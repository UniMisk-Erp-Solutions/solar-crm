/**
 * Product-compliance gates: G2 (DCR), G3 (ALMM List-I), G4 (ALMM List-II), G5 (List-II exemption date), G6 (BIS),
 * G7 (inverter self-certification) and G10 (ALMM snapshot freshness).
 *
 * Quotes and previews check the SKU's compliance register entry; dispatch checks each serial's `compliance_snapshot` (taken at receipt).
 * Severity always comes from `decide()` (→ kernel `decideSeverity`), so an unverified / conflicting / inactive governing rule can never hard-stop.
 */
import { SEGMENT_LABEL, type Finding, type Segment } from '@solar/shared';
import { DESIGN_RULE, decide, finding, fmtDate, info, notConfigured, skuLabel } from './ruleBook';
import { diffDays, maxDateStr } from './dates';
import type { EvalLine, EvalSerial, GateFn } from './types';

const isModule = (l: { sku: { category: string } | null }): boolean => l.sku?.category === 'module';
const EXEMPTION_SEGMENTS: Segment[] = ['ci_net_metered', 'open_access'];

function listSerials(serials: EvalSerial[], max = 5): string {
  const shown = serials.slice(0, max).map((s) => s.serial).join(', ');
  return serials.length > max ? `${shown} and ${serials.length - max} more` : shown;
}
const serialRefs = (serials: EvalSerial[]): string[] => serials.slice(0, 50).map((s) => `serial:${s.serial}`);

/** Group lines by SKU so one finding covers a SKU that appears on several lines. */
function bySku(lines: EvalLine[]): { label: string; lines: EvalLine[] }[] {
  const m = new Map<string, { label: string; lines: EvalLine[] }>();
  for (const l of lines) {
    const k = l.sku?.id ?? l.key;
    const e = m.get(k) ?? { label: skuLabel(l.sku) || l.description, lines: [] };
    e.lines.push(l);
    m.set(k, e);
  }
  return [...m.values()];
}
const lineRefs = (lines: EvalLine[]): string[] => lines.map((l) => `line:${l.key}`);

/* ───────────── G2 — PMSG / KUSUM quote containing a module that is not DCR-verified ───────────── */
export const g2: GateFn = async ({ rules, input }) => {
  const rule = await rules.get('pmsg.dcr_required_for_cfa', input.refDate);
  if (!rule) return [notConfigured('G2', 'pmsg.dcr_required_for_cfa')];
  if (rule.value === false) return [info('G2', 'DCR is not required for CFA under the configured rule — gate G2 passes.', [rule])];
  const d = decide([rule], 'hard_stop');
  if (input.mode === 'dispatch') {
    const bad = input.serials.filter((s) => isModule(s) && !s.snapshot.dcr_verified && !s.compliance?.thin_film);
    return bad.length
      ? [finding('G2', [rule], d, `${bad.length} module serial(s) are not DCR-verified (${listSerials(bad)}) — ${SEGMENT_LABEL[input.segment]} dispatches need DCR modules.`, serialRefs(bad))]
      : [];
  }
  const bad = input.lines.filter((l) => isModule(l) && !l.compliance?.thin_film && !l.compliance?.dcr_verified);
  return bySku(bad).map((g) => finding('G2', [rule], d,
    `${g.label} is not DCR-verified${g.lines[0]?.compliance ? '' : ' (no compliance register entry)'} — ${SEGMENT_LABEL[input.segment]} projects claiming CFA must use DCR modules. Swap the module or request a compliance override.`, lineRefs(g.lines)));
};

/* ───────────── G3 — ALMM List-I (model level) ───────────── */
export const g3: GateFn = async ({ rules, input }) => {
  const rule = await rules.get('almm.list1.enforcement_date', input.refDate);
  if (!rule) return [notConfigured('G3', 'almm.list1.enforcement_date')];
  if (rule.value === false) return [info('G3', 'ALMM List-I is not enforced under the configured rule — gate G3 passes.', [rule])];
  const since = rules.dateOf(rule);
  if (since && input.refDate < since) return [];
  const d = decide([rule], 'hard_stop');
  if (input.mode === 'dispatch') {
    const bad = input.serials.filter((s) => isModule(s) && !s.snapshot.almm_list1);
    return bad.length
      ? [finding('G3', [rule], d, `${bad.length} module serial(s) are not on ALMM List-I (${listSerials(bad)}) — ${SEGMENT_LABEL[input.segment]} dispatches need List-I models.`, serialRefs(bad))]
      : [];
  }
  const checkDate = maxDateStr(input.refDate, input.today);
  const out: Finding[] = [];
  for (const g of bySku(input.lines.filter(isModule))) {
    const comp = g.lines[0]?.compliance ?? null;
    if (!comp || !comp.almm_list1) {
      out.push(finding('G3', [rule], d, `${g.label} is not on ALMM List-I${comp ? '' : ' (no compliance register entry)'} — ALMM is model-specific, so the manufacturer and model must both be listed.`, lineRefs(g.lines)));
    } else if (comp.almm_list1_valid_till && comp.almm_list1_valid_till < checkDate) {
      out.push(finding('G3', [rule], d, `${g.label} — the ALMM List-I listing is valid only till ${fmtDate(comp.almm_list1_valid_till)}, before the commissioning date ${fmtDate(checkDate)}.`, lineRefs(g.lines)));
    }
  }
  return out;
};

/* ───────────── G4 — ALMM List-II (cells) once the List-II date has been reached ───────────── */
export const g4: GateFn = async ({ rules, input }) => {
  const eff = await rules.get('almm.list2.effective_date', input.refDate);
  if (!eff) return [notConfigured('G4', 'almm.list2.effective_date')];
  const effDate = rules.dateOf(eff);
  if (!effDate) return [info('G4', 'Gate G4 was not evaluated — almm.list2.effective_date is not a date.', [eff])];
  if (input.refDate < effDate) return [];
  const d = decide([eff], 'hard_stop');

  // net-metered / open-access jobs that declare the exemption are covered until the exemption date (G5 owns the cliff)
  let exemptionRules = [eff];
  let covered = false;
  if (EXEMPTION_SEGMENTS.includes(input.segment) && input.exemptionReliance) {
    const until = await rules.get('almm.list2.exemption_net_metering_open_access_until', input.refDate);
    const untilDate = rules.dateOf(until);
    if (until && untilDate) { exemptionRules = [eff, until]; covered = input.refDate <= untilDate; }
  }
  if (input.mode === 'dispatch') {
    const bad = input.serials.filter((s) => isModule(s) && !s.snapshot.almm_list2);
    if (!bad.length) return [];
    if (covered) return [info('G4', `${bad.length} module serial(s) are not on ALMM List-II but the job relies on the List-II exemption (commissioning ${fmtDate(input.refDate)}).`, exemptionRules, serialRefs(bad))];
    return [finding('G4', [eff], d, `${bad.length} module serial(s) have cells that are not on ALMM List-II (${listSerials(bad)}) — commissioning ${fmtDate(input.refDate)} is on/after the List-II date ${fmtDate(effDate)}.`, serialRefs(bad))];
  }
  const bad = input.lines.filter((l) => isModule(l) && !l.compliance?.almm_list2);
  if (!bad.length) return [];
  if (covered) return [info('G4', 'Cells are not on ALMM List-II, but the job relies on the List-II exemption and commissioning is within the exemption period.', exemptionRules, lineRefs(bad))];
  return bySku(bad).map((g) => finding('G4', [eff], d,
    `${g.label} — cells are not on ALMM List-II${g.lines[0]?.compliance ? '' : ' (no compliance register entry)'}; commissioning ${fmtDate(input.refDate)} is on/after the List-II date ${fmtDate(effDate)}.${EXEMPTION_SEGMENTS.includes(input.segment) ? ' Declare exemption reliance or use List-II cells.' : ''}`, lineRefs(g.lines)));
};

/* ───────────── G5 — job relying on the List-II exemption but commissioning after the exemption date ───────────── */
export const g5: GateFn = async ({ rules, input }) => {
  const until = await rules.get('almm.list2.exemption_net_metering_open_access_until', input.refDate);
  if (!until) return [notConfigured('G5', 'almm.list2.exemption_net_metering_open_access_until')];
  if (!input.exemptionReliance) return [];
  const untilDate = rules.dateOf(until);
  if (!untilDate) return [info('G5', 'Gate G5 was not evaluated — the exemption date rule is not a date.', [until])];
  if (input.refDate > untilDate) {
    return [finding('G5', [until], decide([until], 'hard_stop'),
      `The job relies on the ALMM List-II exemption, but the expected commissioning date ${fmtDate(input.refDate)} is after the exemption end date ${fmtDate(untilDate)}. Use List-II cells, bring commissioning forward, or request a compliance override.`)];
  }
  const left = diffDays(input.today, untilDate);
  return [info('G5', `The job relies on the ALMM List-II exemption — commissioning must happen on or before ${fmtDate(untilDate)}${left >= 0 ? ` (${left} day${left === 1 ? '' : 's'} from today)` : ''}.`, [until])];
};

/* ───────────── G6 — BIS licence missing / expired / licensed model ≠ quoted model ───────────── */
const BIS_CATEGORIES = new Set(['module', 'inverter', 'battery']);
const norm = (s: string | null | undefined): string => (s ?? '').toLowerCase().replace(/[\s_-]+/g, '');

export const g6: GateFn = async ({ rules, input }) => {
  // The governing rule is the BIS standard for modules (bis.module_standard_no). While it is conflicting (IS 14286 vs IS 14086) or inactive,
  // the licence / model checks below are advisory: they degrade to warnings until a compliance officer settles and verifies the standard.
  const rule = await rules.get('bis.module_standard_no', input.refDate);
  if (!rule) return [notConfigured('G6', 'bis.module_standard_no')];
  const d = decide([rule], 'hard_stop');
  if (input.mode === 'dispatch') {
    const bad = input.serials.filter((s) => s.sku && BIS_CATEGORIES.has(s.sku.category) && !(s.sku.category === 'inverter' && s.compliance?.self_certified) && !s.snapshot.bis_ok);
    return bad.length
      ? [finding('G6', [rule], d, `${bad.length} serial(s) did not have a valid BIS licence for the model at receipt (${listSerials(bad)}).`, serialRefs(bad))]
      : [];
  }
  const checkDate = maxDateStr(input.refDate, input.today);
  const out: Finding[] = [];
  for (const g of bySku(input.lines.filter((l) => l.sku && BIS_CATEGORIES.has(l.sku.category)))) {
    const l = g.lines[0]!;
    const comp = l.compliance;
    // inverters above the threshold may be self-certified — gate G7 owns that case
    if (l.sku?.category === 'inverter' && comp?.self_certified) continue;
    const issues: string[] = [];
    if (!comp || !comp.bis_licence_no) issues.push('no BIS licence is recorded');
    else {
      if (!comp.bis_valid_till) issues.push('the BIS licence validity date is missing');
      else if (comp.bis_valid_till < input.today) issues.push(`the BIS licence expired on ${fmtDate(comp.bis_valid_till)}`);
      else if (comp.bis_valid_till < checkDate) issues.push(`the BIS licence expires on ${fmtDate(comp.bis_valid_till)}, before the commissioning date ${fmtDate(checkDate)}`);
      if (!comp.bis_licensed_model) issues.push('the licensed model is not recorded');
      else if (norm(comp.bis_licensed_model) !== norm(l.sku?.model)) issues.push(`the licensed model "${comp.bis_licensed_model}" does not match the quoted model "${l.sku?.model ?? ''}"`);
    }
    if (issues.length) out.push(finding('G6', [rule], d, `${g.label} — ${issues.join('; ')}. A licence-model mismatch can cause rejection at inspection.`, lineRefs(g.lines)));
  }
  return out;
};

/* ───────────── G7 — inverter above the threshold still on self-certification ───────────── */
export const g7: GateFn = async ({ rules, input }) => {
  const above = await rules.get('bis.inverter_self_cert_above_kw', input.refDate);
  if (!above) return [notConfigured('G7', 'bis.inverter_self_cert_above_kw')];
  if (typeof above.value !== 'number') return [info('G7', 'Gate G7 was not evaluated — the inverter threshold rule is not a number.', [above])];
  const until = await rules.get('bis.inverter_self_cert_until', input.refDate);
  const untilDate = rules.dateOf(until);
  const pastEnd = !!untilDate && input.refDate > untilDate;
  const subjects: { label: string; refs: string[] }[] = [];
  if (input.mode === 'dispatch') {
    for (const s of input.serials) {
      if (s.sku?.category === 'inverter' && s.compliance?.self_certified && (s.compliance.inverter_kw ?? 0) > above.value) subjects.push({ label: `${skuLabel(s.sku)} (${s.serial})`, refs: [`serial:${s.serial}`] });
    }
  } else {
    for (const g of bySku(input.lines)) {
      const l = g.lines[0]!;
      if (l.sku?.category === 'inverter' && l.compliance?.self_certified && (l.compliance.inverter_kw ?? 0) > above.value) subjects.push({ label: g.label, refs: lineRefs(g.lines) });
    }
  }
  const ruleList = until ? [above, until] : [above];
  const d = decide(ruleList, pastEnd ? 'hard_stop' : 'warning');
  return subjects.map((s) => finding('G7', ruleList, d,
    pastEnd
      ? `${s.label} is above ${above.value} kW and still on self-certification, which ended on ${fmtDate(untilDate!)} — a BIS licence is required for commissioning on ${fmtDate(input.refDate)}.`
      : `${s.label} is above ${above.value} kW and relies on self-certification${untilDate ? ` valid until ${fmtDate(untilDate)}` : ''} — confirm the extension or obtain a BIS licence before then.`, s.refs));
};

/* ───────────── G10 — ALMM snapshot older than N days ───────────── */
export const g10: GateFn = async ({ rules, input }) => {
  const lim = await rules.number('compliance.almm_snapshot_max_age_days', input.today, 7);
  const d = decide([lim.rule ?? DESIGN_RULE], 'warning');
  const ruleList = [lim.rule ?? DESIGN_RULE];
  const age = (date: string | null): number | null => (date ? diffDays(date, input.today) : null);
  if (input.mode === 'dispatch') {
    const stale = input.serials.filter((s) => {
      if (!isModule(s)) return false;
      const snapshotAge = age(s.snapshot.snapshot_date);
      if (snapshotAge !== null && snapshotAge <= lim.value) return false;
      const registerAge = age(s.compliance?.almm_snapshot_date ?? null); // re-confirmed recently on the register? then fine
      return registerAge === null || registerAge > lim.value;
    });
    return stale.length
      ? [finding('G10', ruleList, d, `ALMM status of ${stale.length} module serial(s) has not been re-confirmed in the last ${lim.value} days (${listSerials(stale)}).`, serialRefs(stale))]
      : [];
  }
  const out: Finding[] = [];
  for (const g of bySku(input.lines.filter(isModule))) {
    const date = g.lines[0]?.compliance?.almm_snapshot_date ?? null;
    const a = age(date);
    if (a === null) out.push(finding('G10', ruleList, d, `${g.label} has no ALMM snapshot date — verify the listing on the MNRE ALMM list.`, lineRefs(g.lines)));
    else if (a > lim.value) out.push(finding('G10', ruleList, d, `${g.label} — the ALMM snapshot (${fmtDate(date!)}) is ${a} days old; the limit is ${lim.value} days. Re-verify the listing.`, lineRefs(g.lines)));
  }
  return out;
};
