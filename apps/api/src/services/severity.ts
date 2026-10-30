import type { Severity } from '@solar/shared';
import type { ResolvedRule, SeverityDecision } from './contracts';

const ORDER: Record<Severity, number> = { info: 0, warning: 1, hard_stop: 2 };
export const capSeverity = (base: Severity, cap: Severity): Severity => (ORDER[base] <= ORDER[cap] ? base : cap);
export const maxSeverity = (a: Severity, b: Severity): Severity => (ORDER[a] >= ORDER[b] ? a : b);

/**
 * The single place that turns "a gate's condition is violated" into a severity.
 *
 *  - verified + active rule          → the gate's base severity, capped by the rule's max_severity
 *  - active + enforce_hard_stop      → a compliance officer explicitly enforced it: base severity (capped)
 *  - anything else (unverified, conflicting, inactive, or no governing rule) → ADVISORY: never a hard stop
 *      · hard-stop gates degrade to `warning`; warning/info gates keep their level.
 *      · no rule at all → `info`.
 */
export function decideSeverity(rule: ResolvedRule | null | undefined, base: Severity): SeverityDecision {
  if (!rule) return { severity: 'info', advisory: true };
  const verifiedActive = rule.status === 'verified' && rule.isActive;
  const enforced = rule.isActive && rule.enforceHardStop;
  if (verifiedActive || enforced) return { severity: capSeverity(base, rule.maxSeverity), advisory: false };
  return { severity: base === 'hard_stop' ? 'warning' : base, advisory: true };
}

/** True when the rule may drive calculations/behaviour (active). Inactive rules are reference data only. */
export const ruleUsable = (rule: ResolvedRule | null | undefined): rule is ResolvedRule => !!rule && rule.isActive;
