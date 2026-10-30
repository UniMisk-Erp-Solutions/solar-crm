import { seedId, type Segment } from '@solar/shared';
import channelRouter from '../../src/routes/channel.routes';
import postsaleRouter from '../../src/routes/postsale.routes';
import { IDS, createTestEnv, type TestEnv } from '../helpers/env';

export { IDS };
export const API = '/api/v1';

export function newEnv(): TestEnv {
  return createTestEnv({ authed: [postsaleRouter, channelRouter] });
}

export const DISCOM_ID = seedId('t-discom', 1);
export const SKU_ID = seedId('t-sku', 1);

export interface Project {
  n: number; customerId: string; siteId: string; quoteId: string; oppId: string; soId: string; serials: string[]; serialIds: string[];
}

/**
 * One finished sale: customer, site, quote, opportunity, a DISPATCHED sales order and two dispatched serials of a SKU with a 10-year warranty.
 * `n` keeps ids unique when a test needs several projects.
 */
export async function seedProject(env: TestEnv, o: { n?: number; kw?: number; segment?: Segment; soStatus?: string; dealerId?: string; distributorId?: string; stateShare?: number } = {}): Promise<Project> {
  const n = o.n ?? 1;
  const db = env.ctx('admin').db;
  const dealerId = o.dealerId ?? IDS.dealerA1;
  const distributorId = o.distributorId ?? IDS.distributorA;
  if (!(await db.table('discoms').get(DISCOM_ID))) {
    await db.table('discoms').insert({ id: DISCOM_ID, code: 'UGVCL', name: 'Uttar Gujarat Vij Company Ltd', state: 'Gujarat', kind: 'discom' });
    await db.table('skus').insert({ id: SKU_ID, category: 'module', make: 'Waaree', model: 'WSMD-545', variant: null, wattage: 545, hsn: '85414300', uom: 'nos', active: true, demo: false, description: null, warranty_years: 10, brand_usp: null });
  }
  const customerId = seedId('t-customer', n), siteId = seedId('t-site', n), quoteId = seedId('t-quote', n), oppId = seedId('t-opp', n), soId = seedId('t-so', n);
  const kw = o.kw ?? 3;
  await db.table('customers').insert({ id: customerId, legal_name: `Customer ${n}`, display_name: `Customer ${n}`, customer_type: 'residential', state: 'Gujarat' });
  await db.table('sites').insert({ id: siteId, customer_id: customerId, discom_id: DISCOM_ID, state: 'Gujarat', existing_solar_kw: 0, special_category_state: false, category: 'general', pending_dues: false });
  await db.table('quotations').insert({ id: quoteId, quote_no: `Q-${n}`, kw, segment: o.segment ?? 'pmsg_residential', state_share: o.stateShare ?? 0, cfa_entitlement: 0 });
  await db.table('opportunities').insert({ id: oppId, name: `Opp ${n}`, lead_id: seedId('t-lead', n), customer_id: customerId, site_id: siteId, segment: o.segment ?? 'pmsg_residential', kw, stage: 'won', distributor_id: distributorId, dealer_id: dealerId });
  await db.table('sales_orders').insert({
    id: soId, so_no: `SO/26/${String(n).padStart(4, '0')}`, pi_id: seedId('t-pi', n), quote_id: quoteId, opportunity_id: oppId, customer_id: customerId, site_id: siteId, dealer_id: dealerId, distributor_id: distributorId,
    segment: o.segment ?? 'pmsg_residential', status: (o.soStatus ?? 'dispatched') as never, order_date: '2026-09-20', total: 250000, advance_received: 250000,
  });
  const serials = [`SN-${n}-A`, `SN-${n}-B`];
  const serialIds: string[] = [];
  for (const s of serials) {
    const row = await db.table('inventory_serials').insert({ serial: s, sku_id: SKU_ID, status: 'dispatched', sales_order_id: soId, installed_at: null, site_id: null });
    serialIds.push(row.id);
  }
  return { n, customerId, siteId, quoteId, oppId, soId, serials, serialIds };
}

/** The CFA and DISCOM rules most post-sale tests need (verified + active). */
export async function seedRules(env: TestEnv): Promise<void> {
  await env.rule('pmsg.cfa.per_kw_first_2kw', 30000); await env.rule('pmsg.cfa.third_kw', 18000); await env.rule('pmsg.cfa.max_total', 78000); await env.rule('pmsg.cfa.max_kw_eligible', 3);
  await env.rule('discom.commissioning_days', 15, { status: 'unverified', confidence: 'medium' });
  await env.rule('discom.feasibility_study_exempt_up_to_kw', 10);
  await env.rule('discom.feasibility_study_days_above_10kw', 15);
  await env.rule('pmsg.cfa_release_days_after_discom_approval', 15, { status: 'unverified', confidence: 'medium' });
  await env.rule('pmsg.grievance_days', 30);
  await env.rule('pmsg.om_years', 5);
}

/** Minimal JPEG whose EXIF carries GPS (north / east) — enough for lib/exif to read lat/lng. */
export function jpegWithGps(lat: number, lng: number): Buffer {
  const dms = (v: number): [number, number][] => { const d = Math.floor(v); const m = Math.floor((v - d) * 60); const s = Math.round(((v - d) * 60 - m) * 60 * 100); return [[d, 1], [m, 1], [s, 100]]; };
  // TIFF (little endian): header(8) + IFD0(1 entry: GPS pointer) + GPS IFD(4 entries) + rational data
  const tiff: number[] = [];
  const w16 = (v: number) => tiff.push(v & 255, (v >> 8) & 255);
  const w32 = (v: number) => tiff.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  tiff.push(0x49, 0x49); w16(42); w32(8);
  const ifd0 = 8, gpsIfd = ifd0 + 2 + 12 + 4, dataStart = gpsIfd + 2 + 4 * 12 + 4;
  w16(1); w16(0x8825); w16(4); w32(1); w32(gpsIfd); w32(0);
  w16(4);
  w16(1); w16(2); w32(2); tiff.push(0x4e, 0, 0, 0); // GPSLatitudeRef "N"
  w16(2); w16(5); w32(3); w32(dataStart); // GPSLatitude
  w16(3); w16(2); w32(2); tiff.push(0x45, 0, 0, 0); // GPSLongitudeRef "E"
  w16(4); w16(5); w32(3); w32(dataStart + 24); // GPSLongitude
  w32(0);
  for (const [num, den] of [...dms(lat), ...dms(lng)]) { w32(num); w32(den); }
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), Buffer.from(tiff)]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 255]), exif]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])]);
}

export const noExifJpeg = (): Buffer => Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
