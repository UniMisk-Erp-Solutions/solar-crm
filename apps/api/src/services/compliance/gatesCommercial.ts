/**
 * Commercial-position gates: G8 (validity vs price/duty horizon), G9 (HSN / GST / tax position), G11 (dealer credit & portal status),
 * G12 (DISCOM bill name / dues) and G13 (PMSG system size).
 */
import { SEGMENT_LABEL, type Finding } from '@solar/shared';
import { computeDealerExposure, creditBlock } from '../exposure';
import type { ResolvedRule } from '../contracts';
import { DESIGN_RULE, decide, finding, fmtDate, info, notConfigured, skuLabel } from './ruleBook';
import { addDaysStr, istDate, minDateStr } from './dates';
import { GST_RULE_PATH, requiresTaxApproval } from './tax';
import type { GateFn } from './types';

/* ───────────── G8 — quote validity later than the price / duty horizon ───────────── */
export const g8: GateFn = async ({ rules, input }) => {
  if (!input.validityDate) return [];
  const age = await rules.number('quote.max_price_snapshot_age_days', input.quoteDate, 14);
  const snapshotDate = input.priceSnapshotAt ? istDate(input.priceSnapshotAt) : input.quoteDate;
  const candidates: { date: string; label: string; rule: ResolvedRule | null }[] = [
    { date: addDaysStr(snapshotDate, age.value), label: `the price snapshot age limit (${age.value} days from ${fmtDate(snapshotDate)})`, rule: age.rule },
  ];
  for (const l of input.lines) {
    if (l.price_valid_to) candidates.push({ date: l.price_valid_to, label: `the price validity of ${skuLabel(l.sku) || l.description} (${fmtDate(l.price_valid_to)})`, rule: age.rule });
  }
  if (input.exemptionReliance) {
    const until = await rules.get('almm.list2.exemption_net_metering_open_access_until', input.refDate);
    const untilDate = rules.dateOf(until);
    if (until && untilDate) candidates.push({ date: untilDate, label: `the List-II exemption end date (${fmtDate(untilDate)})`, rule: until });
  }
  const horizon = minDateStr(...candidates.map((c) => c.date));
  if (input.validityDate <= horizon) return [];
  const binding = candidates.find((c) => c.date === horizon)!;
  const ruleList = [binding.rule ?? DESIGN_RULE];
  return [finding('G8', ruleList, decide(ruleList, 'warning'),
    `Quote validity ${fmtDate(input.validityDate)} is later than ${binding.label}. Shorten the validity to ${fmtDate(horizon)} or re-confirm prices and duties before sending.`, ['validity_date'])];
};

/* ───────────── G9 — HSN / GST rate missing, or tax position not approved by a CA-type user ───────────── */
export const g9: GateFn = async ({ rules, input }) => {
  const out: Finding[] = [];
  for (const l of input.lines) {
    const cat = l.sku?.category ?? null;
    const path = cat ? GST_RULE_PATH[cat] : undefined;
    const rule = path ? await rules.get(path, input.quoteDate) : null;
    const label = skuLabel(l.sku) !== 'Item' ? skuLabel(l.sku) : l.description;
    const refs = [`line:${l.key}`];
    const soft = decide([rule ?? DESIGN_RULE], 'warning');
    if (!l.hsn) out.push(finding('G9', [rule], soft, `${label} has no HSN code — add it before the quote is issued.`, refs));
    if (l.gst_rate === null) {
      out.push(finding('G9', [rule], soft, path
        ? `${label} has no GST rate — the rule ${path} is ${rule ? 'not active' : 'not configured'}, so no rate has been applied and tax is excluded. A CA-type user must record the tax position.`
        : `${label} has no GST rate — there is no GST rule for this kind of item. A CA-type user must record the tax position.`, refs));
    }
    if (input.mode !== 'quote' && !(input.mode === 'preview' && cat === 'inverter')) continue;
    if (!requiresTaxApproval(l) || l.tax_position_approved) continue;

    if (cat === 'inverter' && rule && rule.status === 'conflicting') {
      if (input.mode === 'preview') {
        out.push(finding('G9', [rule], soft, `The GST rate for inverters is under dispute (rule ${path} is conflicting). On a quote, ${label} will need a CA-approved tax position and is a hard stop until then.`, refs));
        continue;
      }
      // DELIBERATE INVERSION of the usual "conflicting ⇒ advisory" principle: a conflicting inverter rate cannot be priced by any rule, so
      // it demands a human tax decision. Without one the line must not be quoted. We still route the decision through decideSeverity —
      // with the rule treated as explicitly enforced — rather than hard-coding a severity.
      const enforced: ResolvedRule = { ...rule, status: 'verified', isActive: true, enforceHardStop: true, maxSeverity: 'hard_stop' };
      out.push(finding('G9', [rule], decide([enforced], 'hard_stop'),
        `${label}: the inverter GST rate is disputed (5% vs 18%) and this line's tax position has not been approved by a CA-type user. The quote cannot be issued until Accounts / the Compliance Officer records the tax position.`, refs));
    } else if (input.mode === 'quote') {
      out.push(finding('G9', [rule], soft, `${label}: the tax position needs approval by a CA-type user (mandatory for inverters and bundled lines).`, refs));
    }
  }
  return out;
};

/* ───────────── G11 — dealer over credit limit / portal deactivated / under SOP ───────────── */
export const g11: GateFn = async ({ ctx, input }) => {
  if (!input.dealerId) return [info('G11', 'No dealer is linked, so the credit position was not checked.')];
  const dealer = await ctx.db.table('dealers').get(input.dealerId);
  if (!dealer) return [];
  const exposure = await computeDealerExposure(ctx, input.dealerId, ctx.now());
  const extra = input.mode === 'dispatch' ? 0 : input.orderValue;
  const reasons = creditBlock(exposure, extra);
  if (!reasons.length) return [];
  const out: Finding[] = [];
  // On a QUOTE every reason is a warning that opens the credit lane; hard enforcement belongs to sales-order creation.
  // At DISPATCH a deactivated portal status is a hard stop (the dealer cannot take stock), the rest stay warnings.
  const hard = input.mode === 'dispatch' ? reasons.filter((r) => /deactivated/i.test(r)) : [];
  const soft = reasons.filter((r) => !hard.includes(r));
  const refs = [`dealer:${dealer.id}`];
  if (hard.length) out.push(finding('G11', [], decide([], 'hard_stop'), `${dealer.legal_name}: ${hard.join('; ')}.`, refs));
  if (soft.length) {
    out.push(finding('G11', [], decide([], 'warning'),
      `${dealer.legal_name}: ${soft.join('; ')}.${input.mode === 'quote' ? ' The credit approval lane will review this; sales-order creation is blocked while the limit is exceeded.' : ''}`, refs));
  }
  return out;
};

/* ───────────── G12 — name on DISCOM bill ≠ applicant, or pending dues ───────────── */
const normName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const g12: GateFn = async ({ input }) => {
  const site = input.site;
  if (!site) return [];
  const d = decide([], 'warning');
  const out: Finding[] = [];
  const mismatch = site.name_match === false
    || (site.name_match === null && !!site.name_on_bill && !!site.applicant_name && normName(site.name_on_bill) !== normName(site.applicant_name));
  if (mismatch) {
    out.push(finding('G12', [], d,
      `The name on the DISCOM bill${site.name_on_bill ? ` ("${site.name_on_bill}")` : ''} does not match the applicant${site.applicant_name ? ` ("${site.applicant_name}")` : ''}. Fix this before the DISCOM and loan applications are filed.`, ['site.name_match']));
  }
  if (site.pending_dues) out.push(finding('G12', [], d, 'The site has pending DISCOM dues. Clear them before filing the DISCOM application.', ['site.pending_dues']));
  return out;
};

/* ───────────── G13 — PMSG system above the CFA kW limit ───────────── */
export const g13: GateFn = async ({ rules, input }) => {
  if (input.segment !== 'pmsg_residential') return [];
  const rule = await rules.get('pmsg.cfa.max_kw_eligible', input.refDate);
  if (!rule) return [notConfigured('G13', 'pmsg.cfa.max_kw_eligible')];
  if (typeof rule.value !== 'number') return [];
  if (input.kw <= rule.value) return [];
  return [finding('G13', [rule], decide([rule], 'warning'),
    `${SEGMENT_LABEL[input.segment]} system of ${input.kw} kW is above ${rule.value} kW — CFA is limited to ${rule.value} kW, so the extra ${+(input.kw - rule.value).toFixed(2)} kW is not subsidised.`, ['kw'])];
};
