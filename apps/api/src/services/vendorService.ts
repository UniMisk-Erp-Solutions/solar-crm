/**
 * Vendor registrations (PM Surya Ghar portal): level, portal vendor id, states / districts, bank guarantee (amount + validity), portal status.
 * Portal-status changes are audited and mirrored to dealers.portal_status. The bank-guarantee check against pmsg.vendor_bg.* is a WARNING only;
 * `scanBankGuarantees` is the nightly job that alerts on guarantees expiring within the alert window (default 60 days).
 */
import { daysBetween, formatINR, istDateString, type BankGuaranteeWarning, type PortalStatus, type VendorRegistration, type VendorRegistrationCreateInput } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { badRequest, guardBlocked } from '../http/errors';
import { audit } from '../lib/audit';
import type { ResolvedRule } from './contracts';
import { registerJob } from './hooks';
import { istDay, loadByIds, mapById, notifyOnce, ruleNumber } from './postsaleShared';
import { decideSeverity } from './severity';

const SEVERITY_RANK: Record<PortalStatus, number> = { active: 0, under_sop: 1, deactivated: 2 };

/** The worst portal status among a party's registrations. */
export const worstPortalStatus = (statuses: PortalStatus[]): PortalStatus => statuses.reduce<PortalStatus>((w, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[w] ? s : w), 'active');

export async function bgAlertDays(ctx: AppContext): Promise<number> {
  return (await ruleNumber(ctx, 'reporting.bg_expiry_alert_days', 60, 'using 60 days')).value ?? 60;
}

const ruleAmount = (r: ResolvedRule | null): number | null => (r && r.isActive && typeof r.value === 'number' ? r.value : null);

/**
 * Compare the guarantee with rule pmsg.vendor_bg.* (national 25 lakh; multi-state 2.5 lakh per state) and with today's date.
 * Never blocks: severity goes through decideSeverity with a `warning` base, so an unverified rule can only ever advise.
 */
export async function checkBankGuarantee(ctx: AppContext, reg: Pick<VendorRegistration, 'level' | 'states' | 'bank_guarantee_amount' | 'bank_guarantee_valid_till'>): Promise<BankGuaranteeWarning[]> {
  const out: BankGuaranteeWarning[] = [];
  const today = istDateString(ctx.now());
  const alert = await bgAlertDays(ctx);
  const nationalRule = await ctx.svc.rules.path('pmsg.vendor_bg.national');
  const stateRule = await ctx.svc.rules.path('pmsg.vendor_bg.per_state');
  const governing = reg.level === 'national' ? nationalRule : reg.level === 'multi_state' ? stateRule : null;
  const unit = reg.level === 'national' ? ruleAmount(nationalRule) : reg.level === 'multi_state' ? ruleAmount(stateRule) : null;
  const required = unit === null ? null : reg.level === 'multi_state' ? unit * Math.max(1, reg.states.length) : unit;
  if (required !== null && reg.bank_guarantee_amount < required) {
    const sev = decideSeverity(governing, 'warning');
    out.push({
      code: reg.bank_guarantee_amount <= 0 ? 'BG_MISSING' : 'BG_AMOUNT_LOW', severity: sev.severity, advisory: sev.advisory,
      message: reg.bank_guarantee_amount <= 0
        ? `No bank guarantee recorded — ${reg.level === 'national' ? 'national' : 'multi-state'} registration expects ${formatINR(required)}.`
        : `Bank guarantee ${formatINR(reg.bank_guarantee_amount)} is below the ${formatINR(required)} the scheme expects for ${reg.level === 'national' ? 'national' : `${Math.max(1, reg.states.length)} state(s)`}.`,
    });
  }
  if (reg.bank_guarantee_valid_till) {
    const left = daysBetween(today, reg.bank_guarantee_valid_till);
    if (left < 0) out.push({ code: 'BG_EXPIRED', severity: 'warning', advisory: true, message: `Bank guarantee expired on ${reg.bank_guarantee_valid_till}.` });
    else if (left <= alert) out.push({ code: 'BG_EXPIRING', severity: 'warning', advisory: true, message: `Bank guarantee expires in ${left} day${left === 1 ? '' : 's'} (${reg.bank_guarantee_valid_till}).` });
  }
  return out;
}

/* ───────────── portal status (single place that writes it) ───────────── */
export async function syncDealerPortalStatus(ctx: AppContext, dealerId: string, source: string): Promise<PortalStatus | null> {
  const dealer = await ctx.db.table('dealers').get(dealerId);
  if (!dealer) return null;
  const regs = await ctx.db.table('vendor_registrations').all({ party_type: 'dealer', party_id: dealerId });
  if (!regs.length) return dealer.portal_status;
  const next = worstPortalStatus(regs.map((r) => r.portal_status));
  if (next !== dealer.portal_status) {
    await ctx.db.table('dealers').update(dealerId, { portal_status: next });
    await audit(ctx, { action: 'dealer.portal_status_change', table: 'dealers', record_id: dealerId, old: { portal_status: dealer.portal_status }, new: { portal_status: next }, detail: { source } });
  }
  return next;
}

export interface PortalChange { status: PortalStatus; deactivated_from?: string | null; deactivated_to?: string | null }

/**
 * Set a party's portal status: on the registration when there is one (mirrored to the dealer), otherwise straight on the dealer.
 * Used by the SOP tracker; audited either way.
 */
export async function applyDealerPortalStatus(ctx: AppContext, dealerId: string, registrationId: string | null, change: PortalChange, source: string): Promise<void> {
  if (registrationId) {
    const reg = await ctx.db.table('vendor_registrations').get(registrationId);
    if (reg) {
      const row = await ctx.db.table('vendor_registrations').update(reg.id, {
        portal_status: change.status,
        ...(change.deactivated_from !== undefined ? { deactivated_from: change.deactivated_from } : {}), ...(change.deactivated_to !== undefined ? { deactivated_to: change.deactivated_to } : {}),
      });
      if (reg.portal_status !== row.portal_status) {
        await audit(ctx, { action: 'vendor_registration.portal_status_change', table: 'vendor_registrations', record_id: reg.id, old: { portal_status: reg.portal_status }, new: { portal_status: row.portal_status }, detail: { source } });
      }
      await syncDealerPortalStatus(ctx, dealerId, source);
      return;
    }
  }
  const dealer = await ctx.db.table('dealers').get(dealerId);
  if (dealer && dealer.portal_status !== change.status) {
    await ctx.db.table('dealers').update(dealerId, { portal_status: change.status });
    await audit(ctx, { action: 'dealer.portal_status_change', table: 'dealers', record_id: dealerId, old: { portal_status: dealer.portal_status }, new: { portal_status: change.status }, detail: { source } });
  }
}

/* ───────────── CRUD hooks ───────────── */
type VendorInput = Partial<VendorRegistrationCreateInput>;

export async function prepareVendorCreate(ctx: AppContext, input: VendorInput): Promise<Partial<VendorRegistration>> {
  const partyType = input.party_type!, partyId = input.party_id!;
  const party = partyType === 'dealer' ? await ctx.db.table('dealers').get(partyId) : await ctx.db.table('distributors').get(partyId);
  if (!party) throw badRequest(`${partyType === 'dealer' ? 'Dealer' : 'Distributor'} not found`);
  return {
    portal_vendor_id: input.portal_vendor_id ?? null, states: input.states ?? [], districts: input.districts ?? [], bank_guarantee_amount: input.bank_guarantee_amount ?? 0,
    bank_guarantee_valid_till: input.bank_guarantee_valid_till ?? null, portal_status: input.portal_status ?? 'active', deactivated_from: input.deactivated_from ?? null,
    deactivated_to: input.deactivated_to ?? null, complaint_count: 0, notes: input.notes ?? null, ...dateDefaults(ctx, input, null),
  };
}

export function prepareVendorUpdate(ctx: AppContext, input: VendorInput, current: VendorRegistration): Partial<VendorRegistration> {
  return dateDefaults(ctx, input, current);
}

function dateDefaults(ctx: AppContext, input: VendorInput, current: VendorRegistration | null): Partial<VendorRegistration> {
  const status = input.portal_status ?? current?.portal_status ?? 'active';
  const from = input.deactivated_from !== undefined ? input.deactivated_from : current?.deactivated_from ?? null;
  const to = input.deactivated_to !== undefined ? input.deactivated_to : current?.deactivated_to ?? null;
  if (from && to && to < from) throw guardBlocked('The deactivation end date cannot be before its start date');
  const out: Partial<VendorRegistration> = {};
  if (status === 'deactivated' && !from) out.deactivated_from = istDay(ctx.now());
  return out;
}

export async function afterVendorWrite(ctx: AppContext, row: VendorRegistration, before: VendorRegistration | null): Promise<void> {
  if (!before || before.portal_status !== row.portal_status) {
    await audit(ctx, { action: 'vendor_registration.portal_status_change', table: 'vendor_registrations', record_id: row.id, old: { portal_status: before?.portal_status ?? null }, new: { portal_status: row.portal_status }, detail: { source: 'manual', party_type: row.party_type, party_id: row.party_id } });
  }
  if (row.party_type === 'dealer') await syncDealerPortalStatus(ctx, row.party_id, `vendor_registration:${row.id}`);
}

export async function hydrateVendorRegistrations(ctx: AppContext, rows: VendorRegistration[]): Promise<VendorRegistration[]> {
  const today = istDateString(ctx.now());
  const [dealers, distributors] = await Promise.all([
    loadByIds(ctx, 'dealers', rows.filter((r) => r.party_type === 'dealer').map((r) => r.party_id)).then(mapById),
    loadByIds(ctx, 'distributors', rows.filter((r) => r.party_type === 'distributor').map((r) => r.party_id)).then(mapById),
  ]);
  const out: VendorRegistration[] = [];
  for (const r of rows) {
    out.push({
      ...r, party_name: (r.party_type === 'dealer' ? dealers.get(r.party_id)?.legal_name : distributors.get(r.party_id)?.legal_name) ?? null,
      bg_days_left: r.bank_guarantee_valid_till ? daysBetween(today, r.bank_guarantee_valid_till) : null, bg_warnings: await checkBankGuarantee(ctx, r),
    } as VendorRegistration);
  }
  return out;
}

/* ───────────── nightly bank-guarantee scan ───────────── */
export interface BgScanResult { scanned: number; expiring: number; expired: number; notified: number }

/** Alert Accounts, the DSM and the Sales Manager about every bank guarantee that has expired or expires within the alert window. Each alert repeats at most weekly. */
export async function scanBankGuarantees(ctx: AppContext): Promise<BgScanResult> {
  const today = istDateString(ctx.now());
  const alert = await bgAlertDays(ctx);
  const regs = await ctx.db.table('vendor_registrations').all({ bank_guarantee_valid_till: { is_null: false } });
  const [dealers, distributors] = await Promise.all([
    loadByIds(ctx, 'dealers', regs.filter((r) => r.party_type === 'dealer').map((r) => r.party_id)).then(mapById),
    loadByIds(ctx, 'distributors', regs.filter((r) => r.party_type === 'distributor').map((r) => r.party_id)).then(mapById),
  ]);
  const res: BgScanResult = { scanned: regs.length, expiring: 0, expired: 0, notified: 0 };
  for (const r of regs) {
    const left = daysBetween(today, r.bank_guarantee_valid_till!);
    if (left > alert) continue;
    const name = (r.party_type === 'dealer' ? dealers.get(r.party_id)?.legal_name : distributors.get(r.party_id)?.legal_name) ?? 'a vendor';
    const expired = left < 0;
    if (expired) res.expired++; else res.expiring++;
    res.notified += await notifyOnce(ctx, {
      roles: ['accounts', 'dsm', 'sales_manager'], kind: expired ? 'vendor.bg_expired' : 'vendor.bg_expiring', severity: expired || left <= 15 ? 'critical' : 'warning',
      entity_type: 'vendor_registration', entity_id: r.id, link: r.party_type === 'dealer' ? `/dealers/${r.party_id}` : `/distributors/${r.party_id}`,
      title: expired ? `Bank guarantee expired — ${name}` : `Bank guarantee expires in ${left} day${left === 1 ? '' : 's'} — ${name}`,
      body: `${r.level.replace('_', '-')} registration${r.portal_vendor_id ? ` ${r.portal_vendor_id}` : ''}: guarantee of ${formatINR(r.bank_guarantee_amount)} valid till ${r.bank_guarantee_valid_till}. Ask for renewal or a replacement guarantee.`,
    }, 7);
  }
  return res;
}
registerJob({ name: 'channel.bank_guarantee_scan', schedule: '30 2 * * *', run: async (ctx) => ({ ...(await scanBankGuarantees(ctx)) }) });

