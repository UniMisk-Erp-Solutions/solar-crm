import type { RuleSeedInput } from './rules.types';

const SOURCE = 'Future Solar operating default';
const REF = 'docs/api/orders.md — operational defaults for PI, credit and sales orders';

/**
 * Operational (non-regulatory) rule defaults read by the orders module (PI, payment/credit, sales order, dispatch).
 * They are company policy, not statute: seeded verified + active so they drive behaviour, and editable in Admin → Rules.
 */
export const rules_orders: RuleSeedInput[] = [
  {
    path: 'order.min_advance_pct', value: 30, source_name: SOURCE, source_ref: REF, confidence: 'high', status: 'verified', active: true, max_severity: 'hard_stop',
    notes: 'Minimum advance, as a percentage of the PI total, for the "advance received" branch of step 30. Below this the sales order is placed on hold unless credit is approved.',
  },
  {
    path: 'order.pi_validity_days', value: 15, source_name: SOURCE, source_ref: REF, confidence: 'high', status: 'verified', active: true, max_severity: 'warning',
    notes: 'Days a proforma invoice stays valid after issue (valid_till = issue date + this many days).',
  },
  {
    path: 'order.payment_reminder_hours', value: 24, source_name: SOURCE, source_ref: REF, confidence: 'high', status: 'verified', active: true, max_severity: 'info',
    notes: 'Cadence of the customer payment reminder for a sales order on hold (24 = daily). The next reminder is scheduled into working time.',
  },
  {
    path: 'order.payment_reminder_escalation', value: { sales_manager_after: 3, management_after: 5 }, source_name: SOURCE, source_ref: REF, confidence: 'high', status: 'verified', active: true, max_severity: 'info',
    notes: 'After this many unanswered daily reminders the Sales Manager, then Management, are notified (the clock engine already alerts the owner and DSM at the first breach).',
  },
  {
    path: 'order.approval_sla_hours', value: 8, source_name: SOURCE, source_ref: REF, confidence: 'high', status: 'verified', active: true, max_severity: 'info',
    notes: 'Working hours allowed per approval step for PI, sales-order and credit-override approvals (starts the "approval" clock).',
  },
  {
    path: 'order.management_approval_above', value: 2500000, source_name: SOURCE, source_ref: REF, confidence: 'medium', status: 'verified', active: true, max_severity: 'info',
    notes: 'PIs and sales orders whose total is at or above this amount (INR) need a second approval step by Management after Accounts.',
  },
];
