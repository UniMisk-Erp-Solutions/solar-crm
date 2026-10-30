import { daysBetween, istDateString, type CreditAgeing, type PortalStatus } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { notFound } from '../http/errors';

export interface DealerExposure {
  dealer_id: string; dealer_name: string; distributor_id: string;
  credit_limit: number; outstanding: number; available: number; over_limit: boolean; utilisation_pct: number;
  ageing: CreditAgeing; overdue_amount: number; overdue_pct: number;
  subsidy_linked: number; subsidy_linked_pct_of_limit: number;
  dso_days: number | null; invoices_open: number;
  bank_guarantee: { amount: number; valid_till: string | null; days_left: number | null; valid: boolean; expiring_soon: boolean };
  portal_status: PortalStatus; sop_open: number; deactivated: boolean; blocked_reasons: string[];
}

const emptyAgeing = (): CreditAgeing => ({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 });

/**
 * Dealer credit position as of `asOf`: limit, outstanding, ageing buckets (days past due), subsidy-linked exposure,
 * DSO (outstanding ÷ last-90-day billing × 90), bank-guarantee validity and portal / SOP status.
 * Used by the credit lane, gate G11, the dealer scorecard and the v_dealer_exposure dashboard.
 */
export async function computeDealerExposure(ctx: AppContext, dealerId: string, asOf: Date = ctx.now()): Promise<DealerExposure> {
  const dealer = await ctx.db.table('dealers').get(dealerId);
  if (!dealer) throw notFound('Dealer');
  const today = istDateString(asOf);
  const receivables = await ctx.db.table('dealer_receivables').all({ dealer_id: dealerId, status: ['open', 'overdue'] });
  const ageing = emptyAgeing();
  let outstanding = 0, subsidyLinked = 0;
  for (const r of receivables) {
    const open = Math.max(0, r.amount - r.paid_amount);
    if (open <= 0) continue;
    outstanding += open;
    if (r.subsidy_linked) subsidyLinked += open;
    const pastDue = daysBetween(r.due_date, today);
    if (pastDue <= 0) ageing.current += open;
    else if (pastDue <= 30) ageing.d1_30 += open;
    else if (pastDue <= 60) ageing.d31_60 += open;
    else if (pastDue <= 90) ageing.d61_90 += open;
    else ageing.d90_plus += open;
  }
  const overdue = ageing.d1_30 + ageing.d31_60 + ageing.d61_90 + ageing.d90_plus;

  const since = istDateString(new Date(asOf.getTime() - 90 * 86400000));
  const billed = (await ctx.db.table('dealer_receivables').all({ dealer_id: dealerId, invoice_date: { gte: since } })).reduce((s, r) => s + r.amount, 0);
  const dso = billed > 0 ? Math.round((outstanding / billed) * 90) : null;

  const regs = await ctx.db.table('vendor_registrations').all({ party_type: 'dealer', party_id: dealerId });
  const sopOpen = await ctx.db.table('sop_cases').count({ dealer_id: dealerId, stage: ['reply', 'reminder', 'show_cause', 'deactivation', 'appeal'] });
  const bgReg = regs.filter((r) => r.bank_guarantee_valid_till).sort((a, b) => (b.bank_guarantee_valid_till ?? '').localeCompare(a.bank_guarantee_valid_till ?? ''))[0];
  const bgDays = bgReg?.bank_guarantee_valid_till ? daysBetween(today, bgReg.bank_guarantee_valid_till) : null;
  const portal: PortalStatus = regs.some((r) => r.portal_status === 'deactivated') || dealer.portal_status === 'deactivated' ? 'deactivated'
    : regs.some((r) => r.portal_status === 'under_sop') || dealer.portal_status === 'under_sop' ? 'under_sop' : 'active';

  const blocked: string[] = [];
  if (outstanding > dealer.credit_limit) blocked.push('Dealer is over the approved credit limit');
  if (portal === 'deactivated') blocked.push('Dealer is deactivated on the PM Surya Ghar portal');
  if (portal === 'under_sop') blocked.push('Dealer is under an MNRE SOP review');

  return {
    dealer_id: dealer.id, dealer_name: dealer.legal_name, distributor_id: dealer.distributor_id,
    credit_limit: dealer.credit_limit, outstanding, available: Math.max(0, dealer.credit_limit - outstanding), over_limit: outstanding > dealer.credit_limit,
    utilisation_pct: dealer.credit_limit > 0 ? Math.round((outstanding / dealer.credit_limit) * 100) : outstanding > 0 ? 100 : 0,
    ageing, overdue_amount: overdue, overdue_pct: outstanding > 0 ? Math.round((overdue / outstanding) * 100) : 0,
    subsidy_linked: subsidyLinked, subsidy_linked_pct_of_limit: dealer.credit_limit > 0 ? Math.round((subsidyLinked / dealer.credit_limit) * 100) : 0,
    dso_days: dso, invoices_open: receivables.length,
    bank_guarantee: { amount: bgReg?.bank_guarantee_amount ?? 0, valid_till: bgReg?.bank_guarantee_valid_till ?? null, days_left: bgDays, valid: bgDays === null ? false : bgDays >= 0, expiring_soon: bgDays !== null && bgDays >= 0 && bgDays <= 60 },
    portal_status: portal, sop_open: sopOpen, deactivated: portal === 'deactivated', blocked_reasons: blocked,
  };
}

/** Would adding `additional` (rupees) take the dealer over limit, or is the dealer blocked by portal status? (gate G11 / SO guard) */
export function creditBlock(exposure: DealerExposure, additional = 0): string[] {
  const reasons = [...exposure.blocked_reasons.filter((r) => !r.includes('over the approved'))];
  if (exposure.outstanding + additional > exposure.credit_limit) reasons.unshift(`Dealer would exceed the credit limit (₹ ${Math.round(exposure.outstanding + additional).toLocaleString('en-IN')} vs ₹ ${Math.round(exposure.credit_limit).toLocaleString('en-IN')})`);
  return reasons;
}
