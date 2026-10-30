import { daysBetween, entityPath, istDateString, type CreditAgeing, type Dealer, type DealerExposureDashboard, type DealerExposureRow, type DealerExposureTotals, type PortalStatus } from '@solar/shared';
import type { DealerExposure } from '../exposure';
import { KpiBuilder, type Family, type KpiDetail } from './common';
import type { KpiScope } from './scope';
import { DAY, groupBy, sum } from './stats';

const OPEN_SOP_STAGES = ['reply', 'reminder', 'show_cause', 'deactivation', 'appeal'] as const;
const emptyAgeing = (): CreditAgeing => ({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 });
const BG_ALERT_FALLBACK = 60;

export interface DealerExposureCalc extends DealerExposure { billed_90d: number }

/**
 * Batch version of `computeDealerExposure` (services/exposure.ts): same arithmetic, but receivables, vendor registrations and SOP cases are fetched once
 * for all dealers instead of 5 queries per dealer. `test/dashboards/dealer-exposure.test.ts` asserts both produce identical numbers.
 * `bgAlertDays` is the "expiring soon" threshold (rule reporting.bg_expiry_alert_days, default 60).
 */
export async function computeDealerExposures(scope: KpiScope, dealers: Dealer[], asOf: Date, bgAlertDays = BG_ALERT_FALLBACK): Promise<DealerExposureCalc[]> {
  if (!dealers.length) return [];
  const ctx = scope.ctx;
  const today = istDateString(asOf);
  const since = istDateString(new Date(asOf.getTime() - 90 * DAY));
  const ids = new Set(dealers.map((d) => d.id));

  const [openRecv, billedRecv, regs, sops] = await Promise.all([
    scope.rows('dealer_receivables', { status: ['open', 'overdue'] }),
    scope.rows('dealer_receivables', { invoice_date: { gte: since } }),
    ctx.db.table('vendor_registrations').all({ party_type: 'dealer' }),
    ctx.db.table('sop_cases').all({ stage: [...OPEN_SOP_STAGES] }),
  ]);
  const openBy = groupBy(openRecv.filter((r) => ids.has(r.dealer_id)), (r) => r.dealer_id);
  const billedBy = new Map<string, number>();
  for (const r of billedRecv) if (ids.has(r.dealer_id)) billedBy.set(r.dealer_id, (billedBy.get(r.dealer_id) ?? 0) + r.amount);
  const regsBy = groupBy(regs.filter((r) => ids.has(r.party_id)), (r) => r.party_id);
  const sopBy = new Map<string, number>();
  for (const s of sops) if (ids.has(s.dealer_id)) sopBy.set(s.dealer_id, (sopBy.get(s.dealer_id) ?? 0) + 1);

  return dealers.map((dealer) => {
    const receivables = openBy.get(dealer.id) ?? [];
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
    const billed = billedBy.get(dealer.id) ?? 0;
    const dso = billed > 0 ? Math.round((outstanding / billed) * 90) : null;

    const dRegs = regsBy.get(dealer.id) ?? [];
    const bgReg = dRegs.filter((r) => r.bank_guarantee_valid_till).sort((a, b) => (b.bank_guarantee_valid_till ?? '').localeCompare(a.bank_guarantee_valid_till ?? ''))[0];
    const bgDays = bgReg?.bank_guarantee_valid_till ? daysBetween(today, bgReg.bank_guarantee_valid_till) : null;
    const portal: PortalStatus = dRegs.some((r) => r.portal_status === 'deactivated') || dealer.portal_status === 'deactivated' ? 'deactivated'
      : dRegs.some((r) => r.portal_status === 'under_sop') || dealer.portal_status === 'under_sop' ? 'under_sop' : 'active';

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
      bank_guarantee: { amount: bgReg?.bank_guarantee_amount ?? 0, valid_till: bgReg?.bank_guarantee_valid_till ?? null, days_left: bgDays, valid: bgDays === null ? false : bgDays >= 0, expiring_soon: bgDays !== null && bgDays >= 0 && bgDays <= bgAlertDays },
      portal_status: portal, sop_open: sopBy.get(dealer.id) ?? 0, deactivated: portal === 'deactivated', blocked_reasons: blocked, billed_90d: billed,
    };
  });
}

export async function computeDealerExposureDashboard(scope: KpiScope): Promise<Family<Pick<DealerExposureDashboard, 'as_of' | 'totals' | 'dealers' | 'flagged'>>> {
  const { ctx, filters: f } = scope;
  const kb = await KpiBuilder.create(ctx, 'dealer-exposure');
  const bgAlert = (await ctx.svc.rules.value<number>('reporting.bg_expiry_alert_days', undefined, BG_ALERT_FALLBACK)) ?? BG_ALERT_FALLBACK;
  const dealers = await scope.rows('dealers');
  const calc = await computeDealerExposures(scope, dealers, f.now, bgAlert);
  const distNames = await scope.names('distributors', calc.map((c) => c.distributor_id));

  const rows: DealerExposureRow[] = calc.map(({ billed_90d: _b, deactivated: _d, ...c }) => ({ ...c, distributor_name: distNames.get(c.distributor_id) ?? null, path: entityPath('dealer', c.dealer_id) }))
    .sort((a, b) => b.outstanding - a.outstanding || a.dealer_name.localeCompare(b.dealer_name));

  const ageing = emptyAgeing();
  for (const r of rows) { ageing.current += r.ageing.current; ageing.d1_30 += r.ageing.d1_30; ageing.d31_60 += r.ageing.d31_60; ageing.d61_90 += r.ageing.d61_90; ageing.d90_plus += r.ageing.d90_plus; }
  const outstanding = sum(rows.map((r) => r.outstanding));
  const limit = sum(rows.map((r) => r.credit_limit));
  const overdue = sum(rows.map((r) => r.overdue_amount));
  const subsidy = sum(rows.map((r) => r.subsidy_linked));
  const billed = sum(calc.map((c) => c.billed_90d));
  const totals: DealerExposureTotals = {
    dealers: rows.length, credit_limit: limit, outstanding, overdue_amount: overdue, overdue_pct: outstanding > 0 ? Math.round((overdue / outstanding) * 100) : 0,
    subsidy_linked: subsidy, subsidy_linked_pct_of_limit: limit > 0 ? Math.round((subsidy / limit) * 100) : 0,
    dso_days: billed > 0 ? Math.round((outstanding / billed) * 90) : null, ageing,
  };
  const flagged = {
    under_sop: rows.filter((r) => r.portal_status === 'under_sop'),
    deactivated: rows.filter((r) => r.portal_status === 'deactivated'),
    over_limit: rows.filter((r) => r.over_limit),
    bg_expiring: rows.filter((r) => r.bank_guarantee.valid_till !== null && r.bank_guarantee.days_left !== null && r.bank_guarantee.days_left <= bgAlert),
  };

  const top = <T>(list: T[], n = 10): T[] => list.slice(0, n);
  const kpis = [
    kb.make('dealer_outstanding', {
      value: outstanding, secondary: { label: 'Credit limit', value: limit, unit: 'inr' },
      breakdown: [
        { key: 'current', label: 'Not yet due', value: ageing.current }, { key: 'd1_30', label: '1–30 days past due', value: ageing.d1_30 }, { key: 'd31_60', label: '31–60 days past due', value: ageing.d31_60 },
        { key: 'd61_90', label: '61–90 days past due', value: ageing.d61_90 }, { key: 'd90_plus', label: 'Over 90 days past due', value: ageing.d90_plus },
      ],
      links: [{ label: 'Dealers', path: '/dealers' }],
    }),
    kb.make('dealer_overdue_pct', {
      value: totals.overdue_pct, secondary: { label: 'Overdue amount', value: overdue, unit: 'inr' },
      breakdown: top([...rows].sort((a, b) => b.overdue_amount - a.overdue_amount).filter((r) => r.overdue_amount > 0)).map((r) => ({ key: r.dealer_id, label: r.dealer_name, value: r.overdue_pct, overdue_amount: r.overdue_amount })),
      note: outstanding === 0 ? 'No outstanding receivables' : undefined,
    }),
    kb.make('dealer_dso_days', {
      value: totals.dso_days, breakdown: top([...rows].filter((r) => r.dso_days !== null).sort((a, b) => (b.dso_days ?? 0) - (a.dso_days ?? 0))).map((r) => ({ key: r.dealer_id, label: r.dealer_name, value: r.dso_days, outstanding: r.outstanding })),
      note: billed === 0 ? 'No billing in the last 90 days' : undefined,
    }),
    kb.make('subsidy_linked_exposure', {
      value: subsidy, secondary: { label: '% of credit limit', value: totals.subsidy_linked_pct_of_limit, unit: 'pct' },
      breakdown: top([...rows].filter((r) => r.subsidy_linked > 0).sort((a, b) => b.subsidy_linked - a.subsidy_linked)).map((r) => ({ key: r.dealer_id, label: r.dealer_name, value: r.subsidy_linked, pct_of_limit: r.subsidy_linked_pct_of_limit })),
    }),
    kb.make('dealers_under_sop', { value: flagged.under_sop.length, breakdown: flagged.under_sop.map((r) => ({ key: r.dealer_id, label: r.dealer_name, value: r.sop_open })), links: [{ label: 'Dealers', path: '/dealers' }] }),
    kb.make('dealers_deactivated', { value: flagged.deactivated.length, breakdown: flagged.deactivated.map((r) => ({ key: r.dealer_id, label: r.dealer_name, value: 1 })) }),
    kb.make('dealers_over_limit', { value: flagged.over_limit.length, breakdown: flagged.over_limit.map((r) => ({ key: r.dealer_id, label: r.dealer_name, value: r.utilisation_pct, outstanding: r.outstanding, credit_limit: r.credit_limit })) }),
    kb.make('dealer_bg_expiring', {
      value: flagged.bg_expiring.length, breakdown: flagged.bg_expiring.map((r) => ({ key: r.dealer_id, label: r.dealer_name, value: r.bank_guarantee.days_left, valid_till: r.bank_guarantee.valid_till })),
      note: `Flagged at ${bgAlert} days or fewer to expiry`,
    }),
  ];

  const dealerCols: KpiDetail['columns'] = [
    { key: 'dealer', label: 'Dealer', type: 'text' }, { key: 'distributor', label: 'Distributor', type: 'text' }, { key: 'limit', label: 'Credit limit (₹)', type: 'inr' }, { key: 'outstanding', label: 'Outstanding (₹)', type: 'inr' },
    { key: 'utilisation', label: 'Utilisation %', type: 'pct' }, { key: 'current', label: 'Not yet due (₹)', type: 'inr' }, { key: 'd1_30', label: '1–30 days (₹)', type: 'inr' }, { key: 'd31_60', label: '31–60 days (₹)', type: 'inr' },
    { key: 'd61_90', label: '61–90 days (₹)', type: 'inr' }, { key: 'd90_plus', label: 'Over 90 days (₹)', type: 'inr' }, { key: 'overdue_pct', label: 'Overdue %', type: 'pct' }, { key: 'subsidy', label: 'Subsidy-linked (₹)', type: 'inr' },
    { key: 'subsidy_pct', label: 'Subsidy-linked % of limit', type: 'pct' }, { key: 'dso', label: 'DSO (days)', type: 'days' }, { key: 'portal', label: 'Portal status', type: 'text' }, { key: 'bg_valid_till', label: 'BG valid till', type: 'date' },
  ];
  const dealerRow = (r: DealerExposureRow) => ({
    dealer: r.dealer_name, distributor: r.distributor_name, limit: r.credit_limit, outstanding: r.outstanding, utilisation: r.utilisation_pct, current: r.ageing.current, d1_30: r.ageing.d1_30, d31_60: r.ageing.d31_60,
    d61_90: r.ageing.d61_90, d90_plus: r.ageing.d90_plus, overdue_pct: r.overdue_pct, subsidy: r.subsidy_linked, subsidy_pct: r.subsidy_linked_pct_of_limit, dso: r.dso_days, portal: r.portal_status, bg_valid_till: r.bank_guarantee.valid_till,
  });
  const all: KpiDetail = { title: 'Dealer exposure', columns: dealerCols, rows: rows.map(dealerRow) };
  const details: Record<string, KpiDetail> = {
    dealer_outstanding: all, dealer_overdue_pct: all, dealer_dso_days: all, subsidy_linked_exposure: all,
    dealers_under_sop: { ...all, title: 'Dealers under SOP', rows: flagged.under_sop.map(dealerRow) },
    dealers_deactivated: { ...all, title: 'Dealers deactivated', rows: flagged.deactivated.map(dealerRow) },
    dealers_over_limit: { ...all, title: 'Dealers over credit limit', rows: flagged.over_limit.map(dealerRow) },
    dealer_bg_expiring: { ...all, title: 'Bank guarantees expiring', rows: flagged.bg_expiring.map(dealerRow) },
  };
  return { kpis, extra: { as_of: f.today, totals, dealers: rows, flagged }, details };
}
