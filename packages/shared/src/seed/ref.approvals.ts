import type { ApprovalRule } from '../rows';
import { baseOf, refId, type SeedEnv } from './util';

type RuleSeed = Omit<ApprovalRule, 'id' | 'org_id' | 'created_at' | 'updated_at' | 'created_by'>;

/**
 * Approval matrix (prompt Section 9, Stage 4).
 *  - commercial lane: min_value / max_value are the DISCOUNT PERCENT band (lower bound inclusive, upper bound exclusive);
 *  - credit lane: min_value / max_value are in ₹ (order value above which accounts must approve);
 *  - compliance lane: opened by triggers (see conditions), not by value.
 */
export const APPROVAL_RULES: readonly RuleSeed[] = [
  { lane: 'commercial', name: 'Discount 0 – 2 %: no approval', min_value: 0, max_value: 2, role_chain: [], sla_hours: 0, active: true, conditions: { metric: 'discount_pct', bounds: '[min, max)' } },
  { lane: 'commercial', name: 'Discount 2 – 5 %: DSM', min_value: 2, max_value: 5, role_chain: ['dsm'], sla_hours: 8, active: true, conditions: { metric: 'discount_pct', bounds: '[min, max)' } },
  { lane: 'commercial', name: 'Discount 5 – 10 %: DSM then Regional Head', min_value: 5, max_value: 10, role_chain: ['dsm', 'regional_head'], sla_hours: 24, active: true, conditions: { metric: 'discount_pct', bounds: '[min, max)' } },
  { lane: 'commercial', name: 'Discount above 10 %: DSM, Regional Head, then Management', min_value: 10, max_value: null, role_chain: ['dsm', 'regional_head', 'management'], sla_hours: 48, active: true, conditions: { metric: 'discount_pct', bounds: '[min, max)' } },
  {
    lane: 'compliance', name: 'Compliance review: substitution, exemption reliance or unverified rule dependency', min_value: 0, max_value: null, role_chain: ['compliance_officer'], sla_hours: 24, active: true,
    conditions: { triggers: ['sku_substitution', 'exemption_reliance', 'unverified_rule_dependency', 'hard_stop_override'], note: 'Any override of a hard stop needs a written reason.' },
  },
  {
    lane: 'credit', name: 'Credit review: dealer limit, ageing or portal status', min_value: 0, max_value: null, role_chain: ['accounts'], sla_hours: 24, active: true,
    conditions: { metric: 'order_value_inr', triggers: ['over_credit_limit', 'ageing_over_60_days', 'portal_deactivated', 'under_sop', 'bank_guarantee_expired'] },
  },
];

export function buildApprovalRules(env: SeedEnv): ApprovalRule[] {
  return APPROVAL_RULES.map((r, i) => ({ ...baseOf(env, refId('approval-rule', i + 1), 30 * 1440), ...r, role_chain: [...r.role_chain] }));
}
