/**
 * Loans: bank, status ladder, rejection-code picklist, co-applicant, document checklist, FREE-INPUT interest rate (with source date, never defaulted),
 * the `loan_ageing` clock (no statutory SLA — ageing is measured from the actual application date) and the approved ÷ applied summary.
 */
import {
  LOAN_REJECTION_CODES, daysBetween, istDateString, type Json, type Loan, type LoanCreateInput, type LoanRejectionCode, type LoanStatus, type LoanSummary, type LoanSummaryGroup,
} from '@solar/shared';
import type { AppContext } from '../auth/context';
import { scopedWhere } from '../auth/access';
import { badRequest, guardBlocked } from '../http/errors';
import { audit } from '../lib/audit';
import { istMidnight } from '../lib/time';
import { registerClockHandlers } from './hooks';
import { actorId, dueAfterDays, istDay, loadByIds, mapById, notifyOnce, ruleNumber } from './postsaleShared';
import { decideSeverity } from './severity';

export const LOAN_NEXT: Record<LoanStatus, LoanStatus[]> = {
  draft: ['applied', 'withdrawn'],
  applied: ['in_review', 'approved', 'rejected', 'withdrawn'],
  in_review: ['approved', 'rejected', 'withdrawn'],
  approved: ['disbursed', 'withdrawn'],
  rejected: ['applied', 'withdrawn'],
  disbursed: [],
  withdrawn: [],
};
/** Statuses in which the loan is still waiting for the bank. */
const PENDING: LoanStatus[] = ['applied', 'in_review'];
const FINAL_FOR_CLOCK: LoanStatus[] = ['approved', 'rejected', 'disbursed', 'withdrawn'];

/** Ageing is a warning only: when the threshold passes the DSM is told once, and the clock is resolved so it never escalates to Management. */
registerClockHandlers('loan_ageing', {
  async onBreach(ctx, clock) {
    const loan = await ctx.db.table('loans').get(clock.entity_id);
    if (loan && PENDING.includes(loan.status)) {
      const rule = await ctx.svc.rules.path('loan.ageing_warn_days');
      const sev = decideSeverity(rule, 'warning');
      await notifyOnce(ctx, {
        roles: ['dsm'], user_ids: loan.owner_id ? [loan.owner_id] : [], kind: 'loan.ageing', severity: sev.severity === 'info' ? 'info' : 'warning', entity_type: 'loan', entity_id: loan.id,
        title: `Loan application waiting at ${loan.bank} since ${istDay(loan.application_date ?? loan.created_at)}`,
        body: 'No decision from the bank yet. There is no statutory time limit — follow up with the branch and check the document checklist.',
      }, 30);
    }
    await ctx.svc.clocks.complete('loan', clock.entity_id, 'loan_ageing', { ageing_warning_sent: true });
  },
});

async function startAgeingClock(ctx: AppContext, loan: Loan, warnings: string[]): Promise<void> {
  const warn = await ruleNumber(ctx, 'loan.ageing_warn_days', 15, 'loan ageing clock not started');
  if (warn.warning) warnings.push(warn.warning);
  if (warn.value === null) return;
  const from = loan.application_date ?? istDay(ctx.now());
  await ctx.svc.clocks.start({
    entity_type: 'loan', entity_id: loan.id, clock_type: 'loan_ageing', due_at: dueAfterDays(istMidnight(from), warn.value), started_at: istMidnight(from), owner_id: actorId(ctx),
    meta: { bank: loan.bank, application_date: from, warn_days: warn.value } as Json,
  });
}

function checkRate(rate: number | null | undefined, sourceDate: string | null | undefined): void {
  if (rate !== null && rate !== undefined && !sourceDate) throw guardBlocked('Enter the date the interest rate was sourced — the rate is a free input and must carry its source date', { field: 'rate_source_date' });
}

type LoanInput = Partial<LoanCreateInput>;

/** CRUD `prepareCreate`: external users are pinned to their own party; draft by default; applied needs a date. */
export async function prepareLoanCreate(ctx: AppContext, input: LoanInput): Promise<Partial<Loan>> {
  checkRate(input.rate_pct, input.rate_source_date);
  const extra: Partial<Loan> = {
    opportunity_id: input.opportunity_id ?? null, lead_id: input.lead_id ?? null, customer_id: input.customer_id ?? null, dealer_id: input.dealer_id ?? null, distributor_id: input.distributor_id ?? null,
    application_date: input.application_date ?? null, amount: input.amount ?? null, rate_pct: input.rate_pct ?? null, rate_source_date: input.rate_source_date ?? null, co_applicant: input.co_applicant ?? null,
    disbursed_at: null, notes: input.notes ?? null, document_checklist: input.document_checklist ?? {}, owner_id: input.owner_id ?? actorId(ctx),
  };
  const u = ctx.user;
  if (u.role === 'dealer_user') { extra.dealer_id = u.dealer_id; extra.distributor_id = u.distributor_id; }
  else if (u.role === 'distributor_user') {
    extra.distributor_id = u.distributor_id;
    if (input.dealer_id) {
      const dealer = await ctx.db.table('dealers').get(input.dealer_id);
      if (!dealer || dealer.distributor_id !== u.distributor_id) throw guardBlocked('That dealer does not belong to your distributorship');
    }
  } else if (input.dealer_id && !input.distributor_id) {
    extra.distributor_id = (await ctx.db.table('dealers').get(input.dealer_id))?.distributor_id ?? null;
  }
  const status: LoanStatus = input.status ?? 'draft';
  if (status === 'rejected' && !input.rejection_code) throw guardBlocked('Choose a rejection code', { codes: LOAN_REJECTION_CODES });
  extra.status = status;
  extra.rejection_code = status === 'rejected' ? input.rejection_code ?? null : null;
  if (status !== 'draft' && !input.application_date) extra.application_date = istDay(ctx.now());
  if (status === 'disbursed') extra.disbursed_at = ctx.now().toISOString();
  return extra;
}

/** CRUD `prepareUpdate`: validates the status ladder, rejection code and rate/source-date pairing. */
export async function prepareLoanUpdate(ctx: AppContext, input: LoanInput, current: Loan): Promise<Partial<Loan>> {
  const extra: Partial<Loan> = {};
  const rate = input.rate_pct !== undefined ? input.rate_pct : current.rate_pct;
  const src = input.rate_source_date !== undefined ? input.rate_source_date : current.rate_source_date;
  checkRate(rate, src);
  if (input.status && input.status !== current.status) {
    if (!LOAN_NEXT[current.status].includes(input.status)) throw guardBlocked(`A loan cannot move from ${current.status} to ${input.status}`, { allowed: LOAN_NEXT[current.status] });
    if (input.status === 'rejected' && !(input.rejection_code ?? current.rejection_code)) throw guardBlocked('Choose a rejection code', { codes: LOAN_REJECTION_CODES });
    if (input.status === 'applied' && !(input.application_date ?? current.application_date)) extra.application_date = istDay(ctx.now());
    if (input.status === 'disbursed') extra.disbursed_at = ctx.now().toISOString();
    if (input.status !== 'rejected') extra.rejection_code = null;
  } else if (input.rejection_code && current.status !== 'rejected') {
    throw badRequest('A rejection code can only be set on a rejected loan');
  }
  return extra;
}

/** CRUD `afterCreate` / `afterUpdate`: ageing clock on `applied`, completed on a decision; audit of status changes. */
export async function afterLoanWrite(ctx: AppContext, row: Loan, before: Loan | null): Promise<void> {
  const warnings: string[] = [];
  const changed = !before || before.status !== row.status;
  if (!changed) return;
  if (PENDING.includes(row.status) && (!before || !PENDING.includes(before.status))) await startAgeingClock(ctx, row, warnings);
  if (FINAL_FOR_CLOCK.includes(row.status)) await ctx.svc.clocks.complete('loan', row.id, 'loan_ageing', { decision: row.status });
  if (before) await audit(ctx, { action: 'loan.status_change', table: 'loans', record_id: row.id, old: { status: before.status }, new: { status: row.status, rejection_code: row.rejection_code } });
}

export async function hydrateLoans(ctx: AppContext, rows: Loan[]): Promise<Loan[]> {
  const today = istDateString(ctx.now());
  const warn = await ruleNumber(ctx, 'loan.ageing_warn_days', 15, 'ageing threshold unknown');
  const [dealers, customers] = await Promise.all([
    loadByIds(ctx, 'dealers', rows.map((r) => r.dealer_id)).then(mapById),
    loadByIds(ctx, 'customers', rows.map((r) => r.customer_id)).then(mapById),
  ]);
  return rows.map((r) => {
    const open = PENDING.includes(r.status) && r.application_date;
    const age = open ? Math.max(0, daysBetween(r.application_date!, today)) : null;
    const cu = customers.get(r.customer_id ?? '');
    return { ...r, dealer_name: dealers.get(r.dealer_id ?? '')?.legal_name ?? null, customer_name: cu?.display_name ?? cu?.legal_name ?? null, age_days: age, ageing_over_threshold: age !== null && warn.value !== null && age > warn.value } as Loan;
  });
}

/* ───────────── summary ───────────── */
export interface LoanSummaryQuery { from?: string; to?: string; bank?: string; dealer_id?: string; distributor_id?: string }

const emptyGroup = (key: string, label: string): LoanSummaryGroup => ({ key, label, applied: 0, approved: 0, rejected: 0, disbursed: 0, approval_rate_pct: null });
function tally(g: LoanSummaryGroup, status: LoanStatus): void {
  g.applied++;
  if (status === 'approved' || status === 'disbursed') g.approved++;
  if (status === 'disbursed') g.disbursed++;
  if (status === 'rejected') g.rejected++;
}
const finish = (g: LoanSummaryGroup): LoanSummaryGroup => ({ ...g, approval_rate_pct: g.applied ? Math.round((g.approved / g.applied) * 1000) / 10 : null });

/**
 * Approved ÷ applied. "Applied" = every loan that left draft (withdrawn ones included); "approved" = approved or disbursed.
 * Grouped by bank and by dealer, with a breakdown of rejection codes and a count of applications waiting past the ageing threshold.
 */
export async function loanSummary(ctx: AppContext, q: LoanSummaryQuery): Promise<LoanSummary> {
  const where = await scopedWhere(ctx, 'loans', { ...(q.dealer_id ? { dealer_id: q.dealer_id } : {}), ...(q.distributor_id ? { distributor_id: q.distributor_id } : {}), status: ['applied', 'in_review', 'approved', 'rejected', 'disbursed', 'withdrawn'] });
  let loans = await ctx.db.table('loans').all(where);
  if (q.bank) loans = loans.filter((l) => l.bank.toLowerCase() === q.bank!.toLowerCase());
  if (q.from || q.to) loans = loans.filter((l) => { const d = l.application_date ?? istDay(l.created_at); return (!q.from || d >= q.from) && (!q.to || d <= q.to); });
  const dealers = mapById(await loadByIds(ctx, 'dealers', loans.map((l) => l.dealer_id)));
  const overall = emptyGroup('all', 'All loans');
  const banks = new Map<string, LoanSummaryGroup>(), byDealer = new Map<string, LoanSummaryGroup>();
  const codes = new Map<LoanRejectionCode | 'unspecified', number>();
  for (const l of loans) {
    tally(overall, l.status);
    const bk = l.bank.trim();
    tally(banks.get(bk.toLowerCase()) ?? banks.set(bk.toLowerCase(), emptyGroup(bk.toLowerCase(), bk)).get(bk.toLowerCase())!, l.status);
    const dk = l.dealer_id ?? '∅';
    tally(byDealer.get(dk) ?? byDealer.set(dk, emptyGroup(dk, l.dealer_id ? dealers.get(l.dealer_id)?.legal_name ?? 'Unknown dealer' : 'No dealer')).get(dk)!, l.status);
    if (l.status === 'rejected') codes.set(l.rejection_code ?? 'unspecified', (codes.get(l.rejection_code ?? 'unspecified') ?? 0) + 1);
  }
  const warn = await ruleNumber(ctx, 'loan.ageing_warn_days', 15, 'ageing threshold unknown');
  const today = istDateString(ctx.now());
  const pending = loans.filter((l) => PENDING.includes(l.status));
  const sortGroups = (m: Map<string, LoanSummaryGroup>) => [...m.values()].map(finish).sort((a, b) => b.applied - a.applied || a.label.localeCompare(b.label));
  return {
    overall: finish(overall), by_bank: sortGroups(banks), by_dealer: sortGroups(byDealer),
    rejection_codes: [...codes.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
    ageing: { warn_days: warn.value ?? 0, pending: pending.length, over_threshold: warn.value === null ? 0 : pending.filter((l) => l.application_date && daysBetween(l.application_date, today) > warn.value!).length },
  };
}
