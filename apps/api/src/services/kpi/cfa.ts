import { daysBetween, entityPath, type CfaBucketRow, type CfaClaimRow, type CfaPendingDashboard, type RuleRef, type SubsidyClaim } from '@solar/shared';
import type { AppContext } from '../../auth/context';
import { KpiBuilder, type Family, type KpiDetail } from './common';
import type { KpiScope } from './scope';
import { summarise, sum } from './stats';

/** Fallback when rule pmsg.claim_deadline.legacy_cohort is absent (prompt Section 6.2; medium confidence, countdown only). */
export const LEGACY_DEADLINE_FALLBACK = '2026-11-30';
const RELEASE_DAYS_FALLBACK = 15;

/** A rule used for display/countdown: the date is shown even if the rule is not active (advisory), with its status so the UI can badge it. */
export async function ruleRef(ctx: AppContext, path: string, fallback: string | number | null): Promise<RuleRef> {
  const r = await ctx.svc.rules.path(path);
  if (!r) return { path, value: fallback, status: null, confidence: null, active: false, source: null, fallback_used: true };
  const v = r.value;
  const value = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : fallback;
  return { path, value, status: r.status, confidence: r.confidence, active: r.isActive, source: r.source.name, fallback_used: false };
}

const AGE_BANDS: { label: string; max: number }[] = [{ label: '0–15 days', max: 15 }, { label: '16–30 days', max: 30 }, { label: '31–60 days', max: 60 }, { label: '61–90 days', max: 90 }, { label: 'Over 90 days', max: Infinity }];
const bandOf = (age: number): string => AGE_BANDS.find((b) => age <= b.max)!.label;
const PAST_DUE_BANDS = ['Not yet due', '1–30 days', '31–60 days', '61–90 days', 'Over 90 days'];
const pastDueBand = (d: number): string => (d <= 0 ? PAST_DUE_BANDS[0]! : d <= 30 ? PAST_DUE_BANDS[1]! : d <= 60 ? PAST_DUE_BANDS[2]! : d <= 90 ? PAST_DUE_BANDS[3]! : PAST_DUE_BANDS[4]!);

export async function computeCfaPending(scope: KpiScope): Promise<Family<Pick<CfaPendingDashboard, 'pending' | 'age_buckets' | 'legacy' | 'state_share'>>> {
  const { ctx, filters: f } = scope;
  const kb = await KpiBuilder.create(ctx, 'cfa-pending');
  const claims = await scope.rows('subsidy_claims');
  const releaseDays = (await ctx.svc.rules.value<number>('pmsg.cfa_release_days_after_discom_approval', undefined, RELEASE_DAYS_FALLBACK)) ?? RELEASE_DAYS_FALLBACK;
  const deadlineRule = await ruleRef(ctx, 'pmsg.claim_deadline.legacy_cohort', LEGACY_DEADLINE_FALLBACK);
  const ruleDeadline = typeof deadlineRule.value === 'string' ? deadlineRule.value.slice(0, 10) : LEGACY_DEADLINE_FALLBACK;
  const today = f.today;

  const dealerNames = await scope.names('dealers', claims.map((c) => c.dealer_id));
  const deadlineOf = (c: SubsidyClaim): string => c.claim_deadline ?? ruleDeadline;
  const toRow = (c: SubsidyClaim): CfaClaimRow => ({
    claim_id: c.id, sales_order_id: c.sales_order_id, dealer_id: c.dealer_id, dealer_name: c.dealer_id ? dealerNames.get(c.dealer_id) ?? null : null, status: c.status, cohort: c.cohort,
    cfa_computed: c.cfa_computed, state_share: c.state_share, discom_approval_at: c.discom_approval_at,
    age_days: c.discom_approval_at ? Math.max(0, daysBetween(c.discom_approval_at, today)) : null,
    claim_deadline: c.cohort === 'legacy' ? deadlineOf(c) : c.claim_deadline, days_to_deadline: c.cohort === 'legacy' ? daysBetween(today, deadlineOf(c)) : c.claim_deadline ? daysBetween(today, c.claim_deadline) : null,
    path: entityPath('subsidy_claim', c.id),
  });

  /* pending CFA: DISCOM-approved, not yet released */
  const pendingClaims = claims.filter((c) => c.discom_approval_at && !c.released_at && c.status !== 'released' && c.status !== 'rejected');
  const pendingRows = pendingClaims.map(toRow).sort((a, b) => (b.age_days ?? 0) - (a.age_days ?? 0));
  const pendingValue = sum(pendingClaims.map((c) => c.cfa_computed));
  const ages = pendingRows.map((r) => r.age_days ?? 0);
  const ageStats = summarise(ages);
  const buckets = new Map<string, CfaBucketRow>(AGE_BANDS.map((b) => [b.label, { label: b.label, count: 0, value: 0 }]));
  for (const r of pendingRows) { const b = buckets.get(bandOf(r.age_days ?? 0))!; b.count++; b.value += r.cfa_computed; }
  const age_buckets = [...buckets.values()];
  const overdue = pendingRows.filter((r) => (r.age_days ?? 0) > releaseDays);

  /* legacy cohort at risk */
  const legacy = claims.filter((c) => c.cohort === 'legacy' && !c.released_at && ['not_ready', 'ready', 'claimed'].includes(c.status));
  const legacyRows = legacy.map(toRow).sort((a, b) => (a.days_to_deadline ?? 0) - (b.days_to_deadline ?? 0));
  const legacyValue = sum(legacy.map((c) => c.cfa_computed));
  const daysToDeadline = daysBetween(today, ruleDeadline);
  const legacyByStatus = new Map<string, { count: number; value: number }>();
  for (const c of legacy) { const e = legacyByStatus.get(c.status) ?? { count: 0, value: 0 }; e.count++; e.value += c.cfa_computed; legacyByStatus.set(c.status, e); }

  /* state-share receivable */
  const ssClaims = claims.filter((c) => c.state_share > 0 && !c.state_share_received_at && c.status !== 'rejected');
  const ssBuckets = new Map<string, CfaBucketRow>(PAST_DUE_BANDS.map((l) => [l, { label: l, count: 0, value: 0 }]));
  for (const c of ssClaims) {
    const past = c.state_share_due_at ? daysBetween(c.state_share_due_at, today) : 0;
    const b = ssBuckets.get(pastDueBand(past))!;
    b.count++; b.value += c.state_share;
  }
  const ssTotal = sum(ssClaims.map((c) => c.state_share));

  const kpis = [
    kb.make('cfa_pending_value', {
      value: pendingValue, breakdown: age_buckets.map((b) => ({ label: b.label, value: b.value, count: b.count })),
      secondary: { label: 'Claims pending', value: pendingRows.length, unit: 'count' }, links: [{ label: 'Subsidy claims', path: '/post-sale?tab=subsidy' }],
    }),
    kb.make('cfa_pending_age_days', {
      value: ageStats.median, secondary: { label: '90th percentile', value: ageStats.p90 }, breakdown: age_buckets.map((b) => ({ label: b.label, value: b.count, amount: b.value })),
      note: pendingRows.length ? undefined : 'No DISCOM-approved claims are waiting for release',
    }),
    kb.make('cfa_release_overdue', {
      value: overdue.length, secondary: { label: 'Value', value: sum(overdue.map((r) => r.cfa_computed)), unit: 'inr' },
      note: `Policy release period: ${releaseDays} days after DISCOM approval`,
    }),
    kb.make('legacy_claims_at_risk', {
      value: legacy.length, secondary: { label: 'Days to deadline', value: daysToDeadline, unit: 'days' },
      breakdown: [...legacyByStatus].map(([label, v]) => ({ key: label, label: label.replace('_', ' '), value: v.count, amount: v.value })),
      links: [{ label: 'Legacy claims work-list', path: '/post-sale?tab=subsidy&cohort=legacy' }],
      note: deadlineRule.fallback_used || deadlineRule.status !== 'verified' || !deadlineRule.active ? 'Deadline is advisory — verify against the MNRE OM before relying' : undefined,
    }),
    kb.make('legacy_claims_at_risk_value', { value: legacyValue, secondary: { label: 'Claims', value: legacy.length, unit: 'count' } }),
    kb.make('legacy_days_to_deadline', { value: daysToDeadline, note: `Deadline ${ruleDeadline}` }),
    kb.make('state_share_receivable', {
      value: ssTotal, breakdown: [...ssBuckets.values()].map((b) => ({ label: b.label, value: b.value, count: b.count })), secondary: { label: 'Claims', value: ssClaims.length, unit: 'count' },
    }),
  ];

  const claimCols: KpiDetail['columns'] = [
    { key: 'claim', label: 'Claim', type: 'text' }, { key: 'dealer', label: 'Dealer', type: 'text' }, { key: 'cohort', label: 'Cohort', type: 'text' }, { key: 'status', label: 'Status', type: 'text' },
    { key: 'cfa', label: 'CFA (₹)', type: 'inr' }, { key: 'state_share', label: 'State share (₹)', type: 'inr' }, { key: 'approved', label: 'DISCOM approval', type: 'date' }, { key: 'age', label: 'Age (days)', type: 'days' },
    { key: 'deadline', label: 'Claim deadline', type: 'date' }, { key: 'days_left', label: 'Days to deadline', type: 'days' },
  ];
  const claimRow = (r: CfaClaimRow) => ({ claim: r.claim_id.slice(0, 8), dealer: r.dealer_name, cohort: r.cohort, status: r.status, cfa: r.cfa_computed, state_share: r.state_share, approved: r.discom_approval_at, age: r.age_days, deadline: r.claim_deadline, days_left: r.days_to_deadline });
  const details: Record<string, KpiDetail> = {
    cfa_pending_value: { title: 'Pending CFA claims', columns: claimCols, rows: pendingRows.map(claimRow) },
    cfa_pending_age_days: { title: 'Pending CFA claims', columns: claimCols, rows: pendingRows.map(claimRow) },
    cfa_release_overdue: { title: 'CFA release overdue', columns: claimCols, rows: overdue.map(claimRow) },
    legacy_claims_at_risk: { title: 'Legacy cohort claims at risk', columns: claimCols, rows: legacyRows.map(claimRow) },
    legacy_claims_at_risk_value: { title: 'Legacy cohort claims at risk', columns: claimCols, rows: legacyRows.map(claimRow) },
    state_share_receivable: { title: 'State-share receivable', columns: claimCols, rows: ssClaims.map(toRow).map(claimRow) },
  };
  return {
    kpis, details,
    extra: {
      pending: pendingRows.slice(0, 200), age_buckets,
      legacy: { deadline: ruleDeadline, days_to_deadline: daysToDeadline, rule: deadlineRule, count: legacy.length, value: legacyValue, claims: legacyRows.slice(0, 200) },
      state_share: { total_receivable: ssTotal, count: ssClaims.length, buckets: [...ssBuckets.values()] },
    },
  };
}
