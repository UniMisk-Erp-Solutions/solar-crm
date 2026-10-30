import { SEGMENT_LABEL, type Finding, type Gate, type Segment, type Severity } from '@solar/shared';
import type { AppContext } from '../../auth/context';
import type { ResolvedRule, SeverityDecision } from '../contracts';
import { decideSeverity } from '../severity';

/**
 * A synthetic, always-verified rule for gates that are Future Solar DESIGN rules with no row in rule_config
 * (G8, G10, G11, G12) or policy gates whose switch row may not be seeded yet (G1, G14). It has no id, so it is never recorded as a
 * dependency. When a switch row EXISTS it is used instead — and a compliance officer deactivating it degrades the gate to a warning.
 */
export const DESIGN_RULE: ResolvedRule = {
  id: '', category: 'design', key: 'design', value: true, status: 'verified', confidence: 'high', isActive: true, maxSeverity: 'hard_stop', enforceHardStop: false,
  source: { name: 'Future Solar design rule', ref: 'prompt.md §7' }, effective_from: '2020-01-01', effective_to: null, notes: null,
};

const ORDER: Record<Severity, number> = { info: 0, warning: 1, hard_stop: 2 };

/** Records every rule version a decision looked at, so `ruleIdsUsed` can reproduce the decision later and the re-quote engine can find dependants. */
export class RuleBook {
  readonly used = new Set<string>();
  constructor(private readonly ctx: AppContext) {}

  async get(path: string, ref: string): Promise<ResolvedRule | null> {
    const r = await this.ctx.svc.rules.path(path, ref);
    if (r) this.used.add(r.id);
    return r;
  }

  /** Numeric value of an ACTIVE rule, else the documented fallback. Inactive rules never change behaviour. */
  async number(path: string, ref: string, fallback: number): Promise<{ value: number; rule: ResolvedRule | null }> {
    const rule = await this.get(path, ref);
    const v = rule && rule.isActive && typeof rule.value === 'number' ? rule.value : fallback;
    return { value: v, rule };
  }

  /** `YYYY-MM-DD` of a date-valued rule (string value), or null when the rule is missing or not a date. */
  dateOf(rule: ResolvedRule | null): string | null {
    if (!rule || typeof rule.value !== 'string') return null;
    return /^\d{4}-\d{2}-\d{2}/.test(rule.value) ? rule.value.slice(0, 10) : null;
  }
}

/**
 * Severity for a gate decided by one or more governing rules. Each rule goes through the kernel's `decideSeverity`;
 * the result is the WEAKEST outcome (so one unverified/inactive/conflicting parameter degrades the whole gate) and advisory if any rule is.
 * An empty list means "design rule" (always verified).
 */
export function decide(rules: (ResolvedRule | null | undefined)[], base: Severity): SeverityDecision {
  const list = rules.length ? rules : [DESIGN_RULE];
  let severity: Severity = base;
  let advisory = false;
  for (const r of list) {
    const d = decideSeverity(r, base);
    if (ORDER[d.severity] < ORDER[severity]) severity = d.severity;
    advisory = advisory || d.advisory;
  }
  return { severity, advisory };
}

/** The rule whose status/confidence/source best explains an advisory outcome: the first one that is not verified+active, else the first. */
function shownRule(rules: ResolvedRule[]): ResolvedRule | null {
  return rules.find((r) => r.id && !(r.status === 'verified' && r.isActive)) ?? rules.find((r) => r.id) ?? null;
}

export function finding(gate: Gate, rules: (ResolvedRule | null | undefined)[], decision: SeverityDecision, message: string, fieldRefs: string[] = []): Finding {
  const real = rules.filter((r): r is ResolvedRule => !!r && !!r.id);
  const shown = shownRule(real);
  return {
    gate, severity: decision.severity, message, ruleIds: [...new Set(real.map((r) => r.id))], fieldRefs,
    ruleStatus: shown?.status ?? null, ruleConfidence: shown?.confidence ?? null,
    ruleSource: shown ? `${shown.source.name} — ${shown.source.ref}` : null, advisory: decision.advisory,
  };
}

/** An informational finding (gate not applicable, rule not configured, FYI). */
export function info(gate: Gate, message: string, rules: (ResolvedRule | null | undefined)[] = [], fieldRefs: string[] = []): Finding {
  return finding(gate, rules, { severity: 'info', advisory: false }, message, fieldRefs);
}

export const notConfigured = (gate: Gate, path: string): Finding =>
  info(gate, `Gate ${gate} was not evaluated — rule ${path} is not configured. Ask a compliance officer to add it.`);

export const notApplicable = (gate: Gate, segment: Segment, note?: string | null): Finding =>
  info(gate, `Gate ${gate} does not apply to ${SEGMENT_LABEL[segment]}${note ? ` — ${note}` : ''}.`);

export const skuLabel = (sku: { make: string; model: string; variant?: string | null } | null | undefined): string =>
  sku ? [sku.make, sku.model, sku.variant].filter(Boolean).join(' ') : 'Item';

export const fmtDate = (d: string): string => {
  const [y, m, day] = d.split('-');
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1] ?? m;
  return `${day}-${mon}-${y}`;
};
