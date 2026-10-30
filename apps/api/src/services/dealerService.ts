/**
 * Dealers: scoped CRUD hooks, the dealer scorecard (DSO, overdue %, ageing, subsidy-linked exposure vs limit, deactivations, complaints, portal status,
 * bank-guarantee expiry, territory, rebate accrual from configurable slabs) and the exposure table for the dashboard.
 */
import {
  formatINR, istDateString, type Dealer, type DealerCreateInput, type DealerExposureView, type DealerScorecard, type Json, type RebateAccrual, type SopCase, type VendorRegistration,
} from '@solar/shared';
import type { AppContext } from '../auth/context';
import { assertCanRead, scopedWhere } from '../auth/access';
import { forbidden, guardBlocked, notFound } from '../http/errors';
import { audit } from '../lib/audit';
import { computeDealerExposure } from './exposure';
import { loadByIds, mapById, periodBounds, round2 } from './postsaleShared';
import { OPEN_SOP_STAGES } from './sopService';
import { bgAlertDays } from './vendorService';

/* ───────────── CRUD hooks ───────────── */
/** Fields a distributor user may change on a dealer of their own. Limits, security, status and portal status stay with the channel administrators. */
const DISTRIBUTOR_EDITABLE = new Set(['legal_name', 'trade_name', 'gstin', 'pan', 'contact_name', 'phone', 'email', 'territory_id', 'city', 'district', 'state']);

export async function prepareDealerCreate(ctx: AppContext, input: Partial<DealerCreateInput>): Promise<Partial<Dealer>> {
  const u = ctx.user;
  const distributorId = u.role === 'distributor_user' ? u.distributor_id : input.distributor_id;
  if (!distributorId) throw guardBlocked('Choose the distributor this dealer belongs to');
  if (u.role === 'distributor_user' && input.distributor_id && input.distributor_id !== u.distributor_id) throw forbidden('You can only add dealers to your own distributorship');
  if (!(await ctx.db.table('distributors').get(distributorId))) throw guardBlocked('Distributor not found');
  const external = u.role === 'distributor_user';
  return {
    trade_name: input.trade_name ?? null, gstin: input.gstin ?? null, pan: input.pan ?? null, contact_name: input.contact_name ?? null, phone: input.phone ?? null, email: input.email ?? null,
    territory_id: input.territory_id ?? null, city: input.city ?? null, district: input.district ?? null,
    distributor_id: distributorId, credit_limit: external ? 0 : input.credit_limit ?? 0, security_type: external ? 'none' : input.security_type ?? 'none', security_amount: external ? 0 : input.security_amount ?? 0,
    status: external ? 'onboarding' : input.status ?? 'onboarding', portal_status: 'active', complaint_count: 0, rebate_accrued: 0,
  };
}

export function prepareDealerUpdate(ctx: AppContext, input: Record<string, unknown>): Partial<Dealer> {
  if (ctx.user.role === 'distributor_user') {
    const blocked = Object.keys(input).filter((k) => !DISTRIBUTOR_EDITABLE.has(k));
    if (blocked.length) throw forbidden(`Your role cannot change: ${blocked.join(', ')}`);
  }
  return {};
}

export interface DealerPanel { open_sop_cases: SopCase[]; vendor_registrations: VendorRegistration[]; distributor_name: string | null; territory_name: string | null }

/** Adds the dealer panel data: open SOP cases, vendor registrations, distributor and territory names. */
export async function hydrateDealers(ctx: AppContext, rows: Dealer[]): Promise<Dealer[]> {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const [sop, regs, distributors, territories] = await Promise.all([
    ctx.db.table('sop_cases').all({ dealer_id: ids, stage: OPEN_SOP_STAGES }, { orderBy: { col: 'notice_at', dir: 'desc' } }),
    ctx.db.table('vendor_registrations').all({ party_type: 'dealer', party_id: ids }),
    loadByIds(ctx, 'distributors', rows.map((r) => r.distributor_id)).then(mapById),
    loadByIds(ctx, 'territories', rows.map((r) => r.territory_id)).then(mapById),
  ]);
  return rows.map((r) => ({
    ...r,
    open_sop_cases: sop.filter((c) => c.dealer_id === r.id), vendor_registrations: regs.filter((g) => g.party_id === r.id),
    distributor_name: distributors.get(r.distributor_id)?.legal_name ?? null, territory_name: territories.get(r.territory_id ?? '')?.name ?? null,
  } as Dealer));
}

/* ───────────── rebate accrual (rule channel.rebate_slabs — no defaults) ───────────── */
interface Slab { from: number; to: number | null; rate_pct: number }
interface SlabSet { period: 'month' | 'quarter' | 'fy'; mode: 'flat' | 'marginal'; slabs: Slab[] }

function readSlabs(raw: Json | undefined): Slab[] {
  if (!Array.isArray(raw)) return [];
  const slabs: Slab[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const from = e['from'], rate = e['rate_pct'], to = e['to'];
    if (typeof from === 'number' && from >= 0 && typeof rate === 'number' && rate >= 0) slabs.push({ from, rate_pct: rate, to: typeof to === 'number' ? to : null });
  }
  return slabs.sort((a, b) => a.from - b.from);
}

/**
 * Accepts: an array of slabs; an object { period?, mode?, slabs }; or an object keyed by distributors.rebate_slab_key (falling back to "default")
 * whose values are either of the above. Returns null when nothing usable is configured.
 */
function slabSetFor(value: Json, key: string | null): SlabSet | null {
  const asSet = (v: Json): SlabSet | null => {
    if (Array.isArray(v)) { const slabs = readSlabs(v); return slabs.length ? { period: 'fy', mode: 'flat', slabs } : null; }
    if (v && typeof v === 'object') {
      const slabs = readSlabs(v['slabs']);
      if (!slabs.length) return null;
      const period = v['period'], mode = v['mode'];
      return { period: period === 'month' || period === 'quarter' ? period : 'fy', mode: mode === 'marginal' ? 'marginal' : 'flat', slabs };
    }
    return null;
  };
  const direct = asSet(value);
  if (direct) return direct;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keyed = (key ? value[key] : undefined) ?? value['default'];
    if (keyed !== undefined) return asSet(keyed);
  }
  return null;
}

export async function rebateAccrual(ctx: AppContext, dealer: Dealer, asOf: Date = ctx.now()): Promise<RebateAccrual> {
  const none = (message: string): RebateAccrual => ({ slabs_configured: false, message, period: null, period_start: null, period_end: null, mode: null, volume: 0, rate_pct: null, accrued: 0 });
  const rule = await ctx.svc.rules.path('channel.rebate_slabs', asOf);
  if (!rule) return none('Rebate slabs are not configured — accrual is 0. Add rule channel.rebate_slabs under Admin → Rule Config.');
  if (!rule.isActive) return none('Rule channel.rebate_slabs is not active — accrual is 0.');
  const distributor = await ctx.db.table('distributors').get(dealer.distributor_id);
  const set = slabSetFor(rule.value, distributor?.rebate_slab_key ?? null);
  if (!set) return none(`Rule channel.rebate_slabs has no usable slab set${distributor?.rebate_slab_key ? ` for "${distributor.rebate_slab_key}"` : ''} — accrual is 0.`);

  const { start, end } = periodBounds(asOf, set.period);
  const volume = (await ctx.db.table('dealer_receivables').all({ dealer_id: dealer.id, invoice_date: { gte: start, lte: end } })).reduce((s, r) => s + r.amount, 0);
  const upper = (i: number): number => set.slabs[i]!.to ?? set.slabs[i + 1]?.from ?? Number.POSITIVE_INFINITY;
  let accrued = 0, rate: number | null = null, message: string | null = null;
  if (set.mode === 'flat') {
    let hit = -1;
    set.slabs.forEach((s, i) => { if (volume >= s.from) hit = i; });
    if (hit >= 0) { rate = set.slabs[hit]!.rate_pct; accrued = (volume * rate) / 100; } else message = `Volume is below the first slab (${formatINR(set.slabs[0]!.from)}).`;
  } else {
    set.slabs.forEach((s, i) => { const slice = Math.max(0, Math.min(volume, upper(i)) - s.from); accrued += (slice * s.rate_pct) / 100; if (slice > 0) rate = s.rate_pct; });
    if (accrued === 0) message = `Volume is below the first slab (${formatINR(set.slabs[0]!.from)}).`;
  }
  return { slabs_configured: true, message, period: set.period, period_start: start, period_end: end, mode: set.mode, volume, rate_pct: rate, accrued: round2(accrued) };
}

/** Persist the current accrual to dealers.rebate_accrued (0 when slabs are not configured). */
export async function recomputeDealerRebate(ctx: AppContext, dealerId: string): Promise<RebateAccrual & { dealer_id: string }> {
  const dealer = await ctx.db.table('dealers').get(dealerId);
  if (!dealer) throw notFound('Dealer');
  await assertCanRead(ctx, 'dealers', dealer);
  const accrual = await rebateAccrual(ctx, dealer);
  await ctx.db.table('dealers').update(dealerId, { rebate_accrued: accrual.accrued });
  await audit(ctx, { action: 'dealer.rebate_recompute', table: 'dealers', record_id: dealerId, old: { rebate_accrued: dealer.rebate_accrued }, new: { rebate_accrued: accrual.accrued }, detail: { slabs_configured: accrual.slabs_configured, volume: accrual.volume } });
  return { dealer_id: dealerId, ...accrual };
}

/* ───────────── scorecard ───────────── */
export async function dealerScorecard(ctx: AppContext, dealerId: string): Promise<DealerScorecard> {
  const dealer = await ctx.db.table('dealers').get(dealerId);
  if (!dealer) throw notFound('Dealer');
  await assertCanRead(ctx, 'dealers', dealer);
  const asOf = ctx.now();
  const today = istDateString(asOf);
  const [x, regs, cases, territory, alertDays, rebate] = await Promise.all([
    computeDealerExposure(ctx, dealerId, asOf),
    ctx.db.table('vendor_registrations').all({ party_type: 'dealer', party_id: dealerId }),
    ctx.db.table('sop_cases').all({ dealer_id: dealerId }),
    dealer.territory_id ? ctx.db.table('territories').get(dealer.territory_id) : null,
    bgAlertDays(ctx),
    rebateAccrual(ctx, dealer, asOf),
  ]);
  const deactivations = regs.filter((r) => r.deactivated_from).length + cases.filter((c) => c.deactivated_at && !c.vendor_registration_id).length;
  const sopOpen = cases.filter((c) => OPEN_SOP_STAGES.includes(c.stage)).length;
  const complaints = Math.max(dealer.complaint_count, cases.length);

  const bg = x.bank_guarantee;
  const bgAlert = bg.valid_till === null ? (bg.amount > 0 ? null : 'No bank guarantee on file')
    : (bg.days_left ?? 0) < 0 ? `Bank guarantee expired on ${bg.valid_till}`
      : (bg.days_left ?? 0) <= alertDays ? `Bank guarantee expires in ${bg.days_left} day(s) (${bg.valid_till})` : null;

  const alerts: string[] = [];
  if (x.over_limit) alerts.push(`Over the credit limit: ${formatINR(x.outstanding)} outstanding against ${formatINR(x.credit_limit)}`);
  if (x.subsidy_linked > dealer.credit_limit && dealer.credit_limit > 0) alerts.push('Subsidy-linked receivables alone exceed the credit limit');
  if (x.overdue_pct >= 50) alerts.push(`${x.overdue_pct}% of the outstanding balance is overdue`);
  if (x.portal_status === 'deactivated') alerts.push('Deactivated on the PM Surya Ghar portal');
  else if (x.portal_status === 'under_sop') alerts.push('Under an MNRE SOP review');
  if (bgAlert) alerts.push(bgAlert);
  if (!rebate.slabs_configured) alerts.push('Rebate slabs not configured');

  return {
    dealer_id: dealer.id, dealer_name: dealer.legal_name, distributor_id: dealer.distributor_id, as_of: today,
    territory: territory ? { id: territory.id, name: territory.name } : null,
    credit: { limit: x.credit_limit, outstanding: x.outstanding, available: x.available, utilisation_pct: x.utilisation_pct, over_limit: x.over_limit },
    dso_days: x.dso_days, overdue_amount: x.overdue_amount, overdue_pct: x.overdue_pct, ageing: x.ageing, invoices_open: x.invoices_open,
    subsidy_linked: { amount: x.subsidy_linked, pct_of_limit: x.subsidy_linked_pct_of_limit, exceeds_limit: dealer.credit_limit > 0 ? x.subsidy_linked > dealer.credit_limit : x.subsidy_linked > 0 },
    portal_status: x.portal_status, deactivations, complaint_count: complaints, sop_open: sopOpen,
    bank_guarantee: { amount: bg.amount, valid_till: bg.valid_till, days_left: bg.days_left, valid: bg.valid, expiring_soon: bg.days_left !== null && bg.days_left >= 0 && bg.days_left <= alertDays, alert_days: alertDays, alert: bgAlert },
    rebate, alerts,
  };
}

/* ───────────── exposure table (all visible dealers) ───────────── */
export async function dealerExposureList(ctx: AppContext, q: { distributor_id?: string; over_limit?: boolean }): Promise<DealerExposureView[]> {
  const where = await scopedWhere(ctx, 'dealers', { ...(q.distributor_id ? { distributor_id: q.distributor_id } : {}) });
  const dealers = await ctx.db.table('dealers').all(where);
  const rows: DealerExposureView[] = [];
  for (const d of dealers) {
    const x = await computeDealerExposure(ctx, d.id);
    if (q.over_limit !== undefined && x.over_limit !== q.over_limit) continue;
    rows.push({
      dealer_id: x.dealer_id, dealer_name: x.dealer_name, distributor_id: x.distributor_id, credit_limit: x.credit_limit, outstanding: x.outstanding, available: x.available, over_limit: x.over_limit,
      utilisation_pct: x.utilisation_pct, ageing: x.ageing, overdue_amount: x.overdue_amount, overdue_pct: x.overdue_pct, subsidy_linked: x.subsidy_linked, subsidy_linked_pct_of_limit: x.subsidy_linked_pct_of_limit,
      dso_days: x.dso_days, invoices_open: x.invoices_open, bank_guarantee: x.bank_guarantee, portal_status: x.portal_status, sop_open: x.sop_open, deactivated: x.deactivated, blocked_reasons: x.blocked_reasons,
    });
  }
  return rows.sort((a, b) => b.utilisation_pct - a.utilisation_pct || b.outstanding - a.outstanding);
}

