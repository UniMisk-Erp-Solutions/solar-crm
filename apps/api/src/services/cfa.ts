import type { Segment } from '@solar/shared';
import type { AppContext } from '../auth/context';

export interface CfaInput {
  segment: Segment; kw: number;
  /** pre-existing solar at the premises counts against the 3 kW cap */
  existing_solar_kw?: number;
  /** site is in a special-category state (higher CFA rates) */
  special_category_state?: boolean;
  /** RWA / GHS: number of households (each entitles 3 kW of common-facility capacity) */
  households?: number;
  referenceDate?: Date | string;
}
export interface CfaResult {
  eligible: boolean; cfa: number; eligible_kw: number;
  benchmark_cost: number | null;
  lines: { label: string; kw: number; rate: number; amount: number }[];
  ruleIds: string[]; warnings: string[];
}

/**
 * Central-Financial-Assistance calculator. EVERY number comes from rule_config (pmsg.* / rwa_ghs.*) and only ACTIVE rules are used,
 * so an unverified or conflicting value can never silently change a price. Reference date = expected commissioning date (or quote date).
 */
export async function computeCfa(ctx: AppContext, input: CfaInput): Promise<CfaResult> {
  const ref = input.referenceDate;
  const out: CfaResult = { eligible: false, cfa: 0, eligible_kw: 0, benchmark_cost: null, lines: [], ruleIds: [], warnings: [] };
  const num = async (path: string): Promise<number | null> => {
    const r = await ctx.svc.rules.path(path, ref);
    if (r) out.ruleIds.push(r.id);
    if (!r || !r.isActive || typeof r.value !== 'number') return null;
    return r.value;
  };

  if (input.segment === 'pmsg_residential') {
    const [per2, third, maxTotal, maxKw, sPer2, sThird, bench2, benchAdd] = await Promise.all([
      num('pmsg.cfa.per_kw_first_2kw'), num('pmsg.cfa.third_kw'), num('pmsg.cfa.max_total'), num('pmsg.cfa.max_kw_eligible'),
      num('pmsg.cfa.special_category.per_kw_first_2kw'), num('pmsg.cfa.special_category.third_kw'),
      num('pmsg.benchmark_cost.first_2kw'), num('pmsg.benchmark_cost.additional'),
    ]);
    if (per2 === null || third === null || maxKw === null) { out.warnings.push('CFA rules are not active — no subsidy has been computed.'); return out; }
    const special = !!input.special_category_state && sPer2 !== null && sThird !== null;
    if (input.special_category_state && !special) out.warnings.push('Special-category CFA rates are not active — standard rates used.');
    const headroom = Math.max(0, maxKw - (input.existing_solar_kw ?? 0));
    const kwEligible = Math.min(input.kw, headroom, maxKw);
    out.eligible_kw = kwEligible;
    const first = Math.min(kwEligible, 2);
    const rest = Math.max(0, kwEligible - 2);
    const r1 = special ? sPer2! : per2;
    const r3 = special ? sThird! : third;
    if (first > 0) out.lines.push({ label: 'First 2 kW', kw: first, rate: r1, amount: first * r1 });
    if (rest > 0) out.lines.push({ label: 'Third kW', kw: rest, rate: r3, amount: rest * r3 });
    let cfa = out.lines.reduce((s, l) => s + l.amount, 0);
    if (!special && maxTotal !== null) cfa = Math.min(cfa, maxTotal);
    out.cfa = cfa;
    out.eligible = cfa > 0;
    if (bench2 !== null && benchAdd !== null) out.benchmark_cost = Math.min(input.kw, 2) * bench2 + Math.max(0, input.kw - 2) * benchAdd;
    if (input.kw > maxKw) out.warnings.push(`CFA is limited to ${maxKw} kW — the extra ${+(input.kw - maxKw).toFixed(2)} kW is not subsidised.`);
    if ((input.existing_solar_kw ?? 0) > 0) out.warnings.push(`Existing solar of ${input.existing_solar_kw} kW counts against the ${maxKw} kW cap.`);
    return out;
  }

  if (input.segment === 'rwa_ghs') {
    const [perKw, capKw, kwPerHouse] = await Promise.all([num('rwa_ghs.cfa_per_kw'), num('rwa_ghs.max_kw'), num('rwa_ghs.kw_per_household')]);
    if (perKw === null) { out.warnings.push('RWA/GHS CFA rule is not active — no subsidy has been computed.'); return out; }
    const byHouseholds = input.households !== undefined && kwPerHouse !== null ? input.households * kwPerHouse : Infinity;
    const kw = Math.min(input.kw, capKw ?? 500, byHouseholds);
    out.eligible_kw = kw;
    out.lines.push({ label: 'Common-facility CFA', kw, rate: perKw, amount: kw * perKw });
    out.cfa = kw * perKw;
    out.eligible = out.cfa > 0;
    if (kw < input.kw) out.warnings.push(`CFA applies to ${kw} kW (cap: ${capKw ?? 500} kW and ${kwPerHouse ?? 3} kW per household).`);
    return out;
  }

  out.warnings.push('No central subsidy applies to this segment.');
  return out;
}
