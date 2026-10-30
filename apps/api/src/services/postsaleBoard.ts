/** Aggregated view for the post-sale board: counts and overdue items per tab (installations, DISCOM, loans, subsidy, warranty). Scoped to what the caller may read. */
import { daysBetween, istDateString, type DiscomApplication, type PostSaleBoard } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { scopedWhere } from '../auth/access';
import { ruleNumber } from './postsaleShared';

const count = <T>(rows: T[], key: (r: T) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of rows) out[key(r)] = (out[key(r)] ?? 0) + 1;
  return out;
};

/** Where the application currently is, for the DISCOM tab. */
export function discomStage(a: Pick<DiscomApplication, 'commissioning_at' | 'certificate_submitted_at' | 'meter_at' | 'inspection_at' | 'feasibility_status'>): string {
  if (a.commissioning_at) return 'commissioned';
  if (a.certificate_submitted_at) return a.meter_at ? 'awaiting_commissioning' : a.inspection_at ? 'awaiting_meter' : 'awaiting_inspection';
  return a.feasibility_status === 'pending' ? 'feasibility_pending' : 'applied';
}

export async function postSaleBoard(ctx: AppContext): Promise<PostSaleBoard> {
  const now = ctx.now();
  const nowIso = now.toISOString();
  const today = istDateString(now);
  const [installs, apps, loans, claims, tickets] = await Promise.all([
    scopedWhere(ctx, 'installations').then((w) => ctx.db.table('installations').all(w)),
    scopedWhere(ctx, 'discom_applications').then((w) => ctx.db.table('discom_applications').all(w)),
    scopedWhere(ctx, 'loans').then((w) => ctx.db.table('loans').all(w)),
    scopedWhere(ctx, 'subsidy_claims').then((w) => ctx.db.table('subsidy_claims').all(w)),
    scopedWhere(ctx, 'warranty_tickets').then((w) => ctx.db.table('warranty_tickets').all(w)),
  ]);
  const [omWindow, loanWarn, legacyDays] = await Promise.all([
    ruleNumber(ctx, 'postsale.om_expiring_days', 90, 'using 90 days'),
    ruleNumber(ctx, 'loan.ageing_warn_days', 15, 'loan threshold unknown'),
    ctx.svc.rules.value<number[]>('subsidy.legacy_reminder_days'),
  ]);
  const legacyWindow = Array.isArray(legacyDays) && legacyDays.length ? Math.max(...legacyDays) : 14;

  /* installations */
  const appByInstall = new Map(apps.filter((a) => a.installation_id).map((a) => [a.installation_id!, a]));
  const commissioningOverdue = (a: DiscomApplication | undefined): boolean => !!a && !a.commissioning_at && !!a.commissioning_due_at && a.commissioning_due_at < nowIso;
  const installations: PostSaleBoard['installations'] = {
    total: installs.length, open: installs.filter((i) => i.status !== 'commissioned').length,
    overdue: installs.filter((i) => i.status !== 'commissioned' && commissioningOverdue(appByInstall.get(i.id))).length, by_status: count(installs, (i) => i.status),
    awaiting_certificate: installs.filter((i) => i.status === 'installed').length,
    om_expiring: installs.filter((i) => i.om_end && i.commissioned_at && daysBetween(today, i.om_end) >= 0 && daysBetween(today, i.om_end) <= (omWindow.value ?? 90)).length,
  };

  /* DISCOM */
  const feasibilityOverdue = apps.filter((a) => a.feasibility_status === 'pending' && !!a.feasibility_due_at && a.feasibility_due_at < nowIso).length;
  const commissioningOverdueN = apps.filter((a) => commissioningOverdue(a)).length;
  const discom: PostSaleBoard['discom'] = {
    total: apps.length, open: apps.filter((a) => !a.commissioning_at).length, overdue: feasibilityOverdue + commissioningOverdueN, by_status: count(apps, (a) => discomStage(a)),
    deemed_breaches: apps.filter((a) => a.deemed_breach).length, feasibility_overdue: feasibilityOverdue, commissioning_overdue: commissioningOverdueN,
  };

  /* loans */
  const pending = loans.filter((l) => l.status === 'applied' || l.status === 'in_review');
  const overThreshold = loanWarn.value === null ? 0 : pending.filter((l) => l.application_date && daysBetween(l.application_date, today) > loanWarn.value!).length;
  const loansTab: PostSaleBoard['loans'] = {
    total: loans.length, open: loans.filter((l) => !['rejected', 'disbursed', 'withdrawn'].includes(l.status)).length, overdue: overThreshold, by_status: count(loans, (l) => l.status), over_threshold: overThreshold,
  };

  /* subsidy */
  const preClaim = claims.filter((c) => c.status === 'not_ready' || c.status === 'ready');
  const legacyAtRisk = preClaim.filter((c) => c.cohort === 'legacy' && !!c.claim_deadline && daysBetween(today, c.claim_deadline) <= legacyWindow).length;
  const releaseClocks = claims.length ? await ctx.db.table('clocks').all({ entity_type: 'subsidy_claim', entity_id: claims.map((c) => c.id), clock_type: 'cfa_release', resolved_at: null }) : [];
  const releaseOverdue = releaseClocks.filter((c) => c.due_at < nowIso).length;
  const legacyPast = preClaim.filter((c) => c.cohort === 'legacy' && !!c.claim_deadline && c.claim_deadline < today).length;
  const subsidy: PostSaleBoard['subsidy'] = {
    total: claims.length, open: claims.filter((c) => ['not_ready', 'ready', 'claimed'].includes(c.status)).length, overdue: legacyPast + releaseOverdue, by_status: count(claims, (c) => c.status),
    legacy_at_risk: legacyAtRisk, cfa_release_overdue: releaseOverdue,
  };

  /* warranty */
  const openTickets = tickets.filter((t) => !['replaced', 'rejected', 'closed'].includes(t.status));
  const rmaOverdue = openTickets.filter((t) => !!t.rma_due_at && t.rma_due_at < nowIso).length;
  const warranty: PostSaleBoard['warranty'] = {
    total: tickets.length, open: tickets.filter((t) => t.status !== 'closed').length, overdue: rmaOverdue, by_status: count(tickets, (t) => t.status), rma_overdue: rmaOverdue,
  };

  return { installations, discom, loans: loansTab, subsidy, warranty, generated_at: nowIso };
}
