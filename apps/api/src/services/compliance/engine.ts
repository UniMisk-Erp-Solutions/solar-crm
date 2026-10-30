/**
 * The gate runner. Resolves applicability (gate × segment), runs each applicable gate, caps severities for "warning-only" segments,
 * overlays approved compliance overrides and summarises the outcome. Gate code decides severity only through `decide()` → `decideSeverity`.
 */
import { GATES, SEGMENT_LABEL, type ComplianceStatus, type Finding, type Gate, type Severity } from '@solar/shared';
import type { AppContext } from '../../auth/context';
import { loadApplicability } from './applicability';
import { g8, g9, g11, g12, g13 } from './gatesCommercial';
import { g1, g14 } from './gatesConsent';
import { g2, g3, g4, g5, g6, g7, g10 } from './gatesProduct';
import { RuleBook, notApplicable } from './ruleBook';
import { GATE_TITLE, type EvalInput, type FullEvaluation, type GateFn, type GateSummary, type OverrideGrant } from './types';

export const GATE_FNS: Record<Gate, GateFn> = { G1: g1, G2: g2, G3: g3, G4: g4, G5: g5, G6: g6, G7: g7, G8: g8, G9: g9, G10: g10, G11: g11, G12: g12, G13: g13, G14: g14 };
export const QUOTE_GATES: Gate[] = [...GATES];
/** Serial-level gates evaluated at dispatch (plus G5 for exemption-reliant jobs, G11 dealer position and G14 privacy). */
export const DISPATCH_GATES: Gate[] = ['G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G10', 'G11', 'G14'];

const SEV_ORDER: Record<Severity, number> = { info: 0, warning: 1, hard_stop: 2 };
const gateNo = (g: Gate): number => Number(g.slice(1));

export interface RunOptions { gates?: Gate[]; grants?: OverrideGrant[]; lineSignature?: string | null }

export async function runGates(ctx: AppContext, input: EvalInput, opts: RunOptions = {}): Promise<FullEvaluation> {
  const gates = opts.gates ?? (input.mode === 'dispatch' ? DISPATCH_GATES : QUOTE_GATES);
  const matrix = await loadApplicability(ctx);
  const rules = new RuleBook(ctx);
  const findings: Finding[] = [];
  const notEvaluated = new Set<Gate>();

  for (const gate of gates) {
    const cell = matrix[gate][input.segment];
    if (cell.applicability === 'not_applies') {
      findings.push(notApplicable(gate, input.segment, cell.note));
      notEvaluated.add(gate);
      continue;
    }
    const produced = await GATE_FNS[gate]({ ctx, rules, input });
    for (const f of produced) {
      if (cell.applicability === 'warning' && f.severity === 'hard_stop') {
        findings.push({ ...f, severity: 'warning', message: `${f.message} (Warning only for ${SEGMENT_LABEL[input.segment]} — gate applicability matrix.)` });
      } else findings.push(f);
    }
  }

  // ── overrides: a compliance-lane approval marks matching findings as overridden ──
  const grants = opts.grants ?? [];
  const live = grants.filter((g) => g.lineSignature === null || opts.lineSignature === undefined || opts.lineSignature === null || g.lineSignature === opts.lineSignature);
  const stale = grants.filter((g) => !live.includes(g)).map((g) => g.approvalId);
  const overridden = new Set<Gate>(live.flatMap((g) => g.gates));
  const finalFindings = findings
    .map((f) => (f.severity !== 'info' && overridden.has(f.gate) ? { ...f, overridden: true } : f))
    .sort((a, b) => gateNo(a.gate) - gateNo(b.gate) || SEV_ORDER[b.severity] - SEV_ORDER[a.severity]);

  const hasHardStop = finalFindings.some((f) => f.severity === 'hard_stop' && !f.overridden);
  const anyWarn = finalFindings.some((f) => (f.severity === 'warning' && !f.overridden) || (f.severity === 'hard_stop' && f.overridden));
  const status: ComplianceStatus = hasHardStop ? 'blocked' : anyWarn ? 'warnings' : 'clear';

  const summary: GateSummary[] = gates.map((gate) => {
    const cell = matrix[gate][input.segment];
    const own = finalFindings.filter((f) => f.gate === gate);
    const real = own.filter((f) => f.severity !== 'info');
    const skipped = notEvaluated.has(gate) || (!real.length && own.length > 0 && own.every((f) => /was not evaluated/.test(f.message)));
    const open = real.filter((f) => !f.overridden);
    const worst: Severity | null = real.length ? real.reduce<Severity>((m, f) => (SEV_ORDER[f.severity] > SEV_ORDER[m] ? f.severity : m), 'info') : null;
    const st: GateSummary['status'] = skipped ? 'skipped' : open.some((f) => f.severity === 'hard_stop') ? 'fail' : real.length ? 'warn' : 'pass';
    return { gate, title: GATE_TITLE[gate], applicability: cell.applicability, status: st, severity: worst, messages: own.map((f) => f.message) };
  });

  const ruleIds = new Set<string>([...rules.used, ...input.extraRuleIds, ...finalFindings.flatMap((f) => f.ruleIds)]);
  ruleIds.delete('');
  return {
    findings: finalFindings, hasHardStop, status, ruleIdsUsed: [...ruleIds].sort(), evaluated_at: ctx.now().toISOString(), gates: summary,
    overridesApplied: live.map((g) => ({ approvalId: g.approvalId, gates: g.gates, reason: g.reason })), overridesStale: stale,
  };
}
