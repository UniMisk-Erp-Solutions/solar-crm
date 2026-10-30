import type { RuleConfidence, RuleStatus, Severity } from '../enums';
import type { Json } from '../rows';

/**
 * One rule_config version, authored compactly. The seed assembler turns these into RuleConfig rows
 * (deterministic ids from `path` + `effective_from`). `path` = "<category>.<key>" where category is the FIRST dotted segment,
 * e.g. "pmsg.cfa.max_total" → category "pmsg", key "cfa.max_total".
 */
export interface RuleSeedInput {
  path: string;
  value: Json;
  effective_from?: string; // default 2020-01-01
  effective_to?: string | null;
  source_name: string;
  source_ref: string;
  confidence: RuleConfidence;
  status: RuleStatus;
  active: boolean;
  /** cap on the severity this rule may ever produce (default 'warning' unless status verified+active hard-stop gates set 'hard_stop') */
  max_severity?: Severity;
  notes?: string;
}
