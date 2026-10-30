/**
 * Installations (post-dispatch): create from a dispatched sales order, geo-tagged photos, vendor-consumer agreement, warranty / 5-year O&M dates,
 * GERC regulation version, serial → installed on commissioning, and the 5-year O&M register.
 *
 * Layering: this module holds the installation row logic only. Recording the certificate (which starts the DISCOM commissioning clock and
 * creates the DISCOM application) and recording commissioning are orchestrated in discomService, which imports from here.
 */
import { daysBetween, istDateString, type DateOnly, type Installation, type InstallPhoto, type Json, type OmRegisterResult, type OmRegisterRow, type OmState, type Segment, type InstallationCreateInput } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { assertCanRead, scopedWhere } from '../auth/access';
import { conflict, guardBlocked, notFound, badRequest } from '../http/errors';
import { storeDocument } from '../http/upload';
import { audit } from '../lib/audit';
import { actorId, addCalendarMonths, istDay, loadByIds, mapById, ruleNumber } from './postsaleShared';

const DISPATCHED_STATES = ['partially_dispatched', 'dispatched', 'closed'];
/** Segments for which the vendor-consumer agreement applies; everything else defaults to `not_required`. */
const AGREEMENT_SEGMENTS: Segment[] = ['pmsg_residential', 'rwa_ghs', 'pm_kusum'];

export type WithWarnings<T> = T & { warnings: string[] };

/* ───────────── pure-ish helpers ───────────── */
export function installationStatusFor(i: Pick<Installation, 'install_date' | 'certificate_at' | 'commissioned_at'>): Installation['status'] {
  if (i.commissioned_at) return 'commissioned';
  if (i.certificate_at) return 'certified';
  if (i.install_date) return 'installed';
  return 'planned';
}

/** GERC regulation version in force on the commissioning date: the entry of rule gerc.regulation_versions ([{from,label}]) with the latest `from` ≤ date. */
export async function regulationVersionFor(ctx: AppContext, date: DateOnly): Promise<string | null> {
  const v = await ctx.svc.rules.value<Json>('gerc.regulation_versions', date);
  if (!Array.isArray(v)) return null;
  const entries = v
    .filter((e): e is { from: string; label: string } => !!e && typeof e === 'object' && !Array.isArray(e) && typeof e['from'] === 'string' && typeof e['label'] === 'string')
    .sort((a, b) => a.from.localeCompare(b.from));
  const hit = entries.filter((e) => e.from <= date).pop();
  return hit ? hit.label : null;
}

/** Longest component warranty (years) among the serials of the order, applied from `base`. Null when no SKU records a warranty. */
export async function warrantyEndFor(ctx: AppContext, salesOrderId: string, base: DateOnly): Promise<DateOnly | null> {
  const serials = await ctx.db.table('inventory_serials').all({ sales_order_id: salesOrderId });
  const skus = await loadByIds(ctx, 'skus', serials.map((s) => s.sku_id));
  const years = Math.max(0, ...skus.map((s) => s.warranty_years ?? 0));
  return years > 0 ? addCalendarMonths(base, years * 12) : null;
}

/** End of the vendor-of-record O&M duty: commissioning date + rule pmsg.om_years (default 5). Null (with a warning) when the rule is inactive. */
export async function omEndFor(ctx: AppContext, commissioned: DateOnly): Promise<{ om_end: DateOnly | null; warning: string | null }> {
  const years = await ruleNumber(ctx, 'pmsg.om_years', 5, 'O&M end date not calculated', commissioned);
  return { om_end: years.value ? addCalendarMonths(commissioned, Math.round(years.value) * 12) : null, warning: years.warning };
}

async function gujaratPmsgNoAgreementDefault(ctx: AppContext, segment: Segment, state: string | null, at: DateOnly, warnings: string[]): Promise<boolean> {
  if (segment !== 'pmsg_residential') return false;
  if (state && state.toLowerCase() !== 'gujarat') return false;
  const rule = await ctx.svc.rules.path('gujarat.pmsg_no_connectivity_agreement', at);
  if (!rule) return false;
  if (!rule.isActive) { warnings.push('Rule gujarat.pmsg_no_connectivity_agreement is not active — the "no connectivity agreement" flag is a manual entry.'); return false; }
  return rule.value === true;
}

/* ───────────── create / update ───────────── */
export async function createInstallation(ctx: AppContext, input: InstallationCreateInput): Promise<WithWarnings<Installation>> {
  const warnings: string[] = [];
  const so = await ctx.db.table('sales_orders').get(input.sales_order_id);
  if (!so) throw notFound('Sales order');
  await assertCanRead(ctx, 'sales_orders', so);
  if (!DISPATCHED_STATES.includes(so.status)) throw guardBlocked(`Sales order ${so.so_no} is ${so.status.replace(/_/g, ' ')} — an installation can be recorded only after dispatch`);
  const existing = await ctx.db.table('installations').one({ sales_order_id: so.id });
  if (existing) throw conflict('An installation is already recorded for this sales order', { installation_id: existing.id });

  if (input.vendor_registration_id) {
    const reg = await ctx.db.table('vendor_registrations').get(input.vendor_registration_id);
    if (!reg) throw badRequest('Vendor registration not found');
    if (reg.party_id !== so.dealer_id && reg.party_id !== so.distributor_id) throw guardBlocked('The vendor of record must be this order\'s dealer or distributor');
  }
  const [dealer, site, opp, quote] = await Promise.all([
    so.dealer_id ? ctx.db.table('dealers').get(so.dealer_id) : null,
    so.site_id ? ctx.db.table('sites').get(so.site_id) : null,
    so.opportunity_id ? ctx.db.table('opportunities').get(so.opportunity_id) : null,
    ctx.db.table('quotations').get(so.quote_id),
  ]);
  const kw = input.kw ?? opp?.kw ?? quote?.kw ?? null;
  const at = input.install_date ?? istDay(ctx.now());
  const noAgreement = input.no_connectivity_agreement ?? (await gujaratPmsgNoAgreementDefault(ctx, so.segment, site?.state ?? null, at, warnings));
  const row = await ctx.db.table('installations').insert({
    sales_order_id: so.id, site_id: so.site_id, customer_id: so.customer_id, dealer_id: so.dealer_id, distributor_id: so.distributor_id,
    vendor_registration_id: input.vendor_registration_id ?? null, installer_name: input.installer_name ?? dealer?.trade_name ?? dealer?.legal_name ?? null,
    status: installationStatusFor({ install_date: input.install_date ?? null, certificate_at: null, commissioned_at: null }), install_date: input.install_date ?? null,
    certificate_at: null, photos: [], agreement_status: input.agreement_status ?? (AGREEMENT_SEGMENTS.includes(so.segment) ? 'pending' : 'not_required'),
    regulation_version: null, no_connectivity_agreement: noAgreement, commissioned_at: null, warranty_end: null, om_end: null, kw, created_by: actorId(ctx),
  });
  await audit(ctx, { action: 'installation.create', table: 'installations', record_id: row.id, new: row as unknown as Json });
  return { ...row, warnings };
}

/** Plain field edits (installer, vendor of record, install date, kW, agreements). Certificate and commissioning go through discomService. */
export async function updateInstallationFields(
  ctx: AppContext, id: string,
  patch: Partial<Pick<Installation, 'installer_name' | 'vendor_registration_id' | 'install_date' | 'kw' | 'agreement_status' | 'no_connectivity_agreement'>>,
): Promise<Installation> {
  const before = await ctx.db.table('installations').get(id);
  if (!before) throw notFound('Installation');
  await assertCanRead(ctx, 'installations', before);
  if (patch.vendor_registration_id) {
    const reg = await ctx.db.table('vendor_registrations').get(patch.vendor_registration_id);
    if (!reg) throw badRequest('Vendor registration not found');
    if (reg.party_id !== before.dealer_id && reg.party_id !== before.distributor_id) throw guardBlocked('The vendor of record must be this order\'s dealer or distributor');
  }
  const next = { install_date: patch.install_date === undefined ? before.install_date : patch.install_date };
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<Installation>;
  if (Object.keys(clean).length === 0) return before;
  const row = await ctx.db.table('installations').update(id, { ...clean, status: installationStatusFor({ ...before, ...next }) });
  await audit(ctx, { action: 'installation.update', table: 'installations', record_id: id, old: before as unknown as Json, new: row as unknown as Json });
  return row;
}

/* ───────────── photos ───────────── */
export interface PhotoMeta { lat?: number; lng?: number; taken_at?: string }

export async function addInstallationPhotos(ctx: AppContext, id: string, files: Express.Multer.File[], meta: PhotoMeta): Promise<WithWarnings<{ installation: Installation; uploaded: InstallPhoto[] }>> {
  const inst = await ctx.db.table('installations').get(id);
  if (!inst) throw notFound('Installation');
  await assertCanRead(ctx, 'installations', inst);
  if (!files.length) throw badRequest('Attach at least one photo (field name "photos")');
  const bad = files.find((f) => !f.mimetype.startsWith('image/'));
  if (bad) throw badRequest(`${bad.originalname} is not an image — installation photos must be JPG, PNG or WebP`);
  const uploaded: InstallPhoto[] = [];
  for (const file of files) {
    const { document, exif } = await storeDocument(ctx, { file, bucket: 'site-photos', entity_type: 'installation', entity_id: id, doc_type: 'installation_photo' });
    uploaded.push({ path: document.path, lat: exif.lat ?? meta.lat ?? null, lng: exif.lng ?? meta.lng ?? null, taken_at: exif.taken_at ?? meta.taken_at ?? null });
  }
  const row = await ctx.db.table('installations').update(id, { photos: [...inst.photos, ...uploaded] });
  await audit(ctx, { action: 'installation.photos_upload', table: 'installations', record_id: id, detail: { count: uploaded.length, geo_tagged: uploaded.filter((p) => p.lat !== null && p.lng !== null).length } });
  const warnings: string[] = [];
  const noGeo = uploaded.filter((p) => p.lat === null || p.lng === null).length;
  if (noGeo) warnings.push(`${noGeo} photo(s) carry no geo-tag — PM Surya Ghar needs geo-tagged installation photos; retake with location on or send the device position.`);
  return { installation: row, uploaded, warnings };
}

export const geoTaggedPhotoCount = (i: Pick<Installation, 'photos'>): number => i.photos.filter((p) => p.lat !== null && p.lng !== null).length;

/* ───────────── certificate / commissioning (row level; orchestrated by discomService) ───────────── */
export async function markCertified(ctx: AppContext, inst: Installation, certificateAt: string): Promise<Installation> {
  const status = inst.commissioned_at ? 'commissioned' : 'certified';
  return ctx.db.table('installations').update(inst.id, { certificate_at: certificateAt, status });
}

/**
 * Commissioning: installation → commissioned, GERC regulation version, warranty end and O&M end, serials of the order → installed.
 * Returns the updated row, the regulation version (for the DISCOM application) and non-blocking warnings.
 */
export async function markCommissioned(ctx: AppContext, inst: Installation, commissionedAt: string): Promise<{ installation: Installation; regulation_version: string | null; serials_installed: number; warnings: string[] }> {
  const warnings: string[] = [];
  const date = istDay(commissionedAt);
  const regulation_version = await regulationVersionFor(ctx, date);
  const om = await omEndFor(ctx, date);
  if (om.warning) warnings.push(om.warning);
  const warranty_end = await warrantyEndFor(ctx, inst.sales_order_id, date);
  const installation = await ctx.db.table('installations').update(inst.id, {
    commissioned_at: commissionedAt, status: 'commissioned', regulation_version, om_end: om.om_end, warranty_end,
  });
  let serials_installed = 0;
  for (const s of await ctx.db.table('inventory_serials').all({ sales_order_id: inst.sales_order_id, status: 'dispatched' })) {
    await ctx.db.table('inventory_serials').update(s.id, { status: 'installed', installed_at: commissionedAt, site_id: s.site_id ?? inst.site_id });
    serials_installed++;
  }
  await audit(ctx, { action: 'installation.commissioned', table: 'installations', record_id: inst.id, old: inst as unknown as Json, new: installation as unknown as Json, detail: { serials_installed, regulation_version } });
  return { installation, regulation_version, serials_installed, warnings };
}

/* ───────────── hydration ───────────── */
export async function hydrateInstallations(ctx: AppContext, rows: Installation[]): Promise<Installation[]> {
  const [customers, dealers, orders, apps] = await Promise.all([
    loadByIds(ctx, 'customers', rows.map((r) => r.customer_id)).then(mapById),
    loadByIds(ctx, 'dealers', rows.map((r) => r.dealer_id)).then(mapById),
    loadByIds(ctx, 'sales_orders', rows.map((r) => r.sales_order_id)).then(mapById),
    rows.length ? ctx.db.table('discom_applications').all({ installation_id: rows.map((r) => r.id) }) : Promise.resolve([]),
  ]);
  const appBy = new Map(apps.map((a) => [a.installation_id, a]));
  return rows.map((r) => {
    const app = appBy.get(r.id) ?? null;
    return {
      ...r,
      customer_name: customers.get(r.customer_id ?? '')?.display_name ?? customers.get(r.customer_id ?? '')?.legal_name ?? null,
      dealer_name: dealers.get(r.dealer_id ?? '')?.legal_name ?? null,
      so_no: orders.get(r.sales_order_id)?.so_no ?? null,
      geo_tagged_photos: geoTaggedPhotoCount(r),
      discom_application: app ? { id: app.id, application_no: app.application_no, feasibility_status: app.feasibility_status, commissioning_due_at: app.commissioning_due_at, commissioning_at: app.commissioning_at, deemed_breach: app.deemed_breach } : null,
    } as Installation;
  });
}

/* ───────────── 5-year O&M register ───────────── */
export interface OmRegisterQuery { state?: OmState; dealer_id?: string; distributor_id?: string; within_days?: number; limit: number; offset: number }

export async function omRegister(ctx: AppContext, q: OmRegisterQuery): Promise<OmRegisterResult> {
  const today = istDateString(ctx.now());
  const alert = await ruleNumber(ctx, 'postsale.om_expiring_days', 90, 'using 90 days');
  const windowDays = alert.value ?? 90;
  const where = await scopedWhere(ctx, 'installations', { ...(q.dealer_id ? { dealer_id: q.dealer_id } : {}), ...(q.distributor_id ? { distributor_id: q.distributor_id } : {}) });
  const installs = await ctx.db.table('installations').all(where);
  const [customers, dealers] = await Promise.all([
    loadByIds(ctx, 'customers', installs.map((i) => i.customer_id)).then(mapById),
    loadByIds(ctx, 'dealers', installs.map((i) => i.dealer_id)).then(mapById),
  ]);
  const rows: OmRegisterRow[] = installs.map((i) => {
    const daysLeft = i.om_end ? daysBetween(today, i.om_end) : null;
    const state: OmState = !i.commissioned_at || !i.om_end ? 'not_started' : (daysLeft ?? 0) < 0 ? 'expired' : (daysLeft ?? 0) <= windowDays ? 'expiring' : 'active';
    const c = customers.get(i.customer_id ?? '');
    return {
      installation_id: i.id, sales_order_id: i.sales_order_id, customer_id: i.customer_id, customer_name: c?.display_name ?? c?.legal_name ?? null,
      dealer_id: i.dealer_id, dealer_name: dealers.get(i.dealer_id ?? '')?.legal_name ?? null, distributor_id: i.distributor_id, vendor_registration_id: i.vendor_registration_id,
      installer_name: i.installer_name, kw: i.kw, commissioned_at: i.commissioned_at, om_start: i.commissioned_at ? istDay(i.commissioned_at) : null, om_end: i.om_end,
      days_left: daysLeft, state, warranty_end: i.warranty_end,
    };
  });
  const summary = { not_started: 0, active: 0, expiring: 0, expired: 0, expiring_window_days: windowDays };
  for (const r of rows) summary[r.state]++;
  let list = rows;
  if (q.state) list = list.filter((r) => r.state === q.state);
  if (q.within_days !== undefined) list = list.filter((r) => r.days_left !== null && r.days_left >= 0 && r.days_left <= q.within_days!);
  list.sort((a, b) => (a.om_end ?? '9999-12-31').localeCompare(b.om_end ?? '9999-12-31'));
  return { data: list.slice(q.offset, q.offset + q.limit), total: list.length, limit: q.limit, offset: q.offset, summary };
}
