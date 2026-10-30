/** Catalogue: SKUs, compliance register, prices, recommendation, stock receipt, serials and exposure. */
import { describe, expect, it } from 'vitest';
import { IDS, addSku, makeWorld } from './helpers';

const newSku = { category: 'module', make: 'Vikram', model: 'Somera-545', variant: 'N-type', wattage: 545, hsn: '85414300', uom: 'nos', brand_usp: { quality: 'Tier-1', warranty: '25 y', certifications: 'IEC, BIS', service_support: 'Pan-India', delivery_reliability: '97% on time' } };

describe('SKUs', () => {
  it('creates, lists with filters and updates a SKU with its brand USP', async () => {
    const w = await makeWorld();
    const tc = w.env.as('techno_commercial');
    const created = await tc.post('/api/v1/skus').send(newSku);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ make: 'Vikram', active: true, compliance: null, brand_usp: { quality: 'Tier-1' } });
    expect((await tc.post('/api/v1/skus').send(newSku)).status).toBe(409);
    expect((await tc.post('/api/v1/skus').send({ ...newSku, hsn: 'abc' })).status).toBe(422);
    await addSku(w, { make: 'Adani', model: 'Inv-5k', category: 'inverter' });

    const mods = await tc.get('/api/v1/skus?category=module');
    expect(mods.body.data.map((s: { model: string }) => s.model)).toEqual(['Somera-545']);
    expect((await tc.get('/api/v1/skus?q=adani')).body.total).toBe(1);
    expect((await tc.get('/api/v1/skus?active=false')).body.total).toBe(0);
    const patched = await tc.patch(`/api/v1/skus/${created.body.data.id}`).send({ active: false, brand_usp: { ...newSku.brand_usp, warranty: '30 y' } });
    expect(patched.body.data).toMatchObject({ active: false, brand_usp: { warranty: '30 y' } });
    expect((await tc.get('/api/v1/skus?active=false')).body.total).toBe(1);
    expect((await w.env.as('viewer').post('/api/v1/skus').send({ ...newSku, model: 'x' })).status).toBe(403);
  });

  it('GET /skus/:id joins the register entry, the current price and the stock', async () => {
    const w = await makeWorld();
    const sku = await addSku(w);
    const res = await w.env.as('dsm').get(`/api/v1/skus/${sku.id}`);
    expect(res.body.data).toMatchObject({ compliance: { almm_list1: true }, price: { base_price: 20000, landed_cost: { basic: 12000 } }, in_stock: 0, snapshot_stale: false });
  });

  it('the stale_snapshot filter finds SKUs whose ALMM snapshot is older than the rule (or missing)', async () => {
    const w = await makeWorld();
    const fresh = await addSku(w);
    const stale = await addSku(w, { compliance: { almm_snapshot_date: '2026-09-01' } });
    const none = await addSku(w, { compliance: null });
    const res = await w.env.as('techno_commercial').get('/api/v1/skus?stale_snapshot=true');
    const ids = res.body.data.map((s: { id: string }) => s.id);
    expect(ids).toEqual(expect.arrayContaining([stale.id, none.id]));
    expect(ids).not.toContain(fresh.id);
    expect(res.body.data.find((s: { id: string }) => s.id === stale.id).snapshot_stale).toBe(true);
  });

  it('partners never see landed cost or floor price', async () => {
    const w = await makeWorld();
    await addSku(w);
    const res = await w.env.as('dealer_user').get('/api/v1/skus');
    expect(res.body.data[0].price).toMatchObject({ base_price: 20000 });
    expect(res.body.data[0].price.landed_cost).toBeUndefined();
    expect(res.body.data[0].price.floor_price).toBeUndefined();
    expect((await w.env.as('dealer_user').get('/api/v1/prices')).status).toBe(403);
  });
});

describe('compliance register', () => {
  const body = { almm_list1: true, almm_list1_ref: 'ALMM/22', almm_list1_valid_till: '2027-06-30', almm_snapshot_date: '2026-10-26', cell_maker: 'Vikram', almm_list2: true, dcr_verified: true, cell_origin: 'India', bis_licence_no: 'R-41000', bis_licensed_model: 'Somera-545', bis_standard_no: 'IS 14286', bis_valid_till: '2028-01-01', inverter_kw: null, self_certified: false, thin_film: false };

  it('requires the ALMM snapshot date and records who verified and when', async () => {
    const w = await makeWorld();
    const sku = await addSku(w, { compliance: null });
    const co = w.env.as('compliance_officer');
    expect((await co.get(`/api/v1/skus/${sku.id}/compliance`)).body.data).toBeNull();
    const { almm_snapshot_date: _drop, ...noDate } = body;
    expect((await co.put(`/api/v1/skus/${sku.id}/compliance`).send(noDate)).status).toBe(422);
    const res = await co.put(`/api/v1/skus/${sku.id}/compliance`).send(body);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ sku_id: sku.id, verified_by: IDS.profile('compliance_officer'), almm_snapshot_date: '2026-10-26' });
    expect(res.body.data.verified_at).toBeTruthy();
    expect((await w.env.as('dsm').put(`/api/v1/skus/${sku.id}/compliance`).send(body)).status).toBe(403);
    const again = await co.put(`/api/v1/skus/${sku.id}/compliance`).send({ ...body, dcr_verified: false });
    expect(again.body.data.dcr_verified).toBe(false);
    expect(await w.c().db.table('sku_compliance').count({ sku_id: sku.id })).toBe(1);
  });
});

describe('prices', () => {
  it('a new price closes the previous one; overlapping starts are refused; landed cost is internal', async () => {
    const w = await makeWorld();
    const sku = await addSku(w);
    const m = w.env.as('management');
    expect((await m.post('/api/v1/prices').send({ sku_id: sku.id, base_price: 21000, valid_from: '2026-01-01' })).status).toBe(409);
    const ok = await m.post('/api/v1/prices').send({ sku_id: sku.id, base_price: 21000, valid_from: '2026-11-01', landed_cost: { basic: 12500, freight: 400 }, floor_price: 15500 });
    expect(ok.status).toBe(201);
    const list = await w.env.as('accounts').get(`/api/v1/prices?sku_id=${sku.id}`);
    expect(list.body.data.map((p: { valid_from: string; valid_to: string | null }) => [p.valid_from, p.valid_to])).toEqual([['2026-11-01', null], ['2026-01-01', '2026-10-31']]);
    expect((await w.env.as('accounts').get(`/api/v1/prices?sku_id=${sku.id}&active=true`)).body.data).toHaveLength(1);
    expect((await w.env.as('dsm').post('/api/v1/prices').send({ sku_id: sku.id, base_price: 1, valid_from: '2027-01-01' })).status).toBe(403);
  });
});

describe('product recommendation (step 16)', () => {
  it('lists only active SKUs that have a register entry, with USP fields and a per-gate summary for the segment', async () => {
    const w = await makeWorld();
    const good = await addSku(w);
    const bad = await addSku(w, { compliance: { dcr_verified: false } });
    await addSku(w, { compliance: null });
    await addSku(w, { active: false });
    const res = await w.env.as('techno_commercial').get('/api/v1/skus/recommend?segment=pmsg_residential&kw=3&commissioning=2026-12-01');
    expect(res.status).toBe(200);
    const rows = res.body.data as { id: string; usp: { quality: string }; gates: { gate: string; status: string }[]; has_hard_stop: boolean }[];
    expect(rows.map((r) => r.id).sort()).toEqual([good.id, bad.id].sort());
    const g = rows.find((r) => r.id === good.id)!;
    const b = rows.find((r) => r.id === bad.id)!;
    expect(g.usp.quality).toBe('Tier-1 cells');
    expect(g.has_hard_stop).toBe(false);
    expect(b.has_hard_stop).toBe(true);
    expect(g.gates.find((x) => x.gate === 'G2')!.status).toBe('pass');
    expect(b.gates.find((x) => x.gate === 'G2')!.status).toBe('fail');
    const only = await w.env.as('techno_commercial').get('/api/v1/skus/recommend?segment=pmsg_residential&kw=3&compliant_only=true');
    expect(only.body.data.map((r: { id: string }) => r.id)).toEqual([good.id]);
    // for a net-metered job DCR does not apply, so the same module is fine
    const net = await w.env.as('techno_commercial').get('/api/v1/skus/recommend?segment=ci_net_metered&kw=50');
    expect(net.body.data.find((r: { id: string }) => r.id === bad.id).gates.find((x: { gate: string }) => x.gate === 'G2').status).toBe('skipped');
    expect((await w.env.as('techno_commercial').get('/api/v1/skus/recommend?segment=bogus&kw=3')).status).toBe(422);
  });
});

describe('stock receipt, serials and exposure', () => {
  it('receives a batch with serials that copy the SKU compliance snapshot at receipt', async () => {
    const w = await makeWorld();
    const sku = await addSku(w, { compliance: { almm_list2: false, dcr_verified: false } });
    const d = w.env.as('dispatch');
    const res = await d.post('/api/v1/stock-batches').send({ sku_id: sku.id, batch_no: 'B-001', received_at: '2026-10-20', qty: 3, origin: 'import', unit_cost: 12500, serials: ['SN-A001', 'SN-A002'] });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ serials: 2, serials_pending: 1, compliance_snapshot: { almm_list1: true, almm_list2: false, dcr_verified: false, bis_ok: true, snapshot_date: '2026-10-26' } });
    expect(res.body.data.warnings.join(' ')).toMatch(/List-II/);

    // later changes to the register do not rewrite what was true at receipt
    await w.c().db.table('sku_compliance').update((await w.c().db.table('sku_compliance').one({ sku_id: sku.id }))!.id, { almm_list2: true });
    const serials = await d.get('/api/v1/serials?status=in_stock');
    expect(serials.body.total).toBe(2);
    expect(serials.body.data[0]).toMatchObject({ status: 'in_stock', batch_no: 'B-001', compliance_snapshot: { almm_list2: false } });

    // duplicates and over-quantity are refused; the third serial can be added later
    expect((await d.post('/api/v1/stock-batches').send({ sku_id: sku.id, batch_no: 'B-002', received_at: '2026-10-21', qty: 2, serials: ['SN-A001'] })).status).toBe(409);
    expect((await d.post('/api/v1/stock-batches').send({ sku_id: sku.id, batch_no: 'B-001', received_at: '2026-10-21', qty: 1 })).status).toBe(409);
    const batchId = res.body.data.batch.id as string;
    expect((await d.post('/api/v1/serials').send({ batch_id: batchId, serials: ['SN-A003', 'SN-A004'] })).status).toBe(409);
    const added = await d.post('/api/v1/serials').send({ batch_id: batchId, serials: ['SN-A003'] });
    expect(added.status).toBe(201);
    expect(added.body.data.added).toBe(1);

    const filtered = await d.get(`/api/v1/serials?sku_id=${sku.id}&batch_id=${batchId}&q=A003`);
    expect(filtered.body.data.map((s: { serial: string }) => s.serial)).toEqual(['SN-A003']);
    const batches = await d.get('/api/v1/stock-batches');
    expect(batches.body.data[0]).toMatchObject({ batch_no: 'B-001', serial_count: 3, in_stock: 3, serials_pending: 0, sku: { model: sku.model } });
    expect((await w.env.as('dealer_user').get('/api/v1/serials')).status).toBe(403);
  });

  it('a SKU without a register entry is received with everything unverified and a warning', async () => {
    const w = await makeWorld();
    const sku = await addSku(w, { compliance: null });
    const res = await w.env.as('techno_commercial').post('/api/v1/stock-batches').send({ sku_id: sku.id, batch_no: 'B-9', received_at: '2026-10-20', qty: 1, serials: ['SN-X1'] });
    expect(res.body.data.compliance_snapshot).toEqual({ almm_list1: false, almm_list2: false, dcr_verified: false, bis_ok: false, snapshot_date: null });
    expect(res.body.data.warnings[0]).toMatch(/no compliance register entry/);
  });

  it('the exposure helper totals in-stock units and value that are not on List-II, ahead of the exemption date', async () => {
    const w = await makeWorld();
    const old = await addSku(w, { compliance: { almm_list2: false } });
    const ok = await addSku(w);
    const d = w.env.as('dispatch');
    await d.post('/api/v1/stock-batches').send({ sku_id: old.id, batch_no: 'B-OLD', received_at: '2026-09-01', qty: 4, unit_cost: 10000, serials: ['O1', 'O2', 'O3', 'O4'].map((s) => `SN-${s}`) });
    await d.post('/api/v1/stock-batches').send({ sku_id: ok.id, batch_no: 'B-NEW', received_at: '2026-10-01', qty: 2, unit_cost: 11000, serials: ['SN-N1', 'SN-N2'] });
    await w.c().db.table('inventory_serials').update((await w.c().db.table('inventory_serials').one({ serial: 'SN-O4' }))!.id, { status: 'dispatched' });
    const res = await w.env.as('management').get('/api/v1/serials/exposure');
    expect(res.body.data).toMatchObject({ exemption_until: '2026-12-31', days_left: 66, total_units: 5, total_value: 3 * 10000 + 2 * 11000, non_list2_units: 3, non_list2_value: 30000 });
    expect(res.body.data.by_sku.find((r: { sku_id: string }) => r.sku_id === old.id)).toMatchObject({ units: 3, non_list2_units: 3 });
  });
});

describe('the 100-product starter catalogue feeds the recommendation', () => {
  it('recommends DCR modules for a subsidised home job and any ALMM module for a commercial one, with brand details', async () => {
    const { buildReferenceSeed } = await import('@solar/shared/seed');
    const w = await makeWorld();
    const cat = buildReferenceSeed(new Date(), true) as { skus: never[]; sku_compliance: never[]; sku_prices: never[] };
    for (const s of cat.skus) await w.env.db.table('skus').insert(s);
    for (const c of cat.sku_compliance) await w.env.db.table('sku_compliance').insert(c);
    for (const p of cat.sku_prices) await w.env.db.table('sku_prices').insert(p);
    // as in the shipped rules: the BIS module standard is still conflicting (V-5), so the licence check is advisory
    for (const r of await w.env.db.table('rule_config').all({ category: 'bis', key: 'module_standard_no' })) await w.env.db.table('rule_config').update(r.id, { status: 'conflicting', is_active: false });
    const tc = w.env.as('techno_commercial');
    const home = await tc.get('/api/v1/skus/recommend?segment=pmsg_residential&kw=5&compliant_only=true');
    expect(home.status).toBe(200);
    const mods = home.body.data.filter((r: { category: string }) => r.category === 'module');
    expect(mods.length).toBeGreaterThanOrEqual(10);
    expect(mods.every((m: { model: string }) => m.model.endsWith('-DCR'))).toBe(true);
    expect(home.body.data.filter((r: { category: string }) => r.category === 'inverter').length).toBeGreaterThan(5);
    expect(mods[0].usp.quality).toBeTruthy();
    const ci = await tc.get('/api/v1/skus/recommend?segment=ci_net_metered&kw=50&compliant_only=true');
    expect(ci.body.data.filter((r: { category: string }) => r.category === 'module').length).toBeGreaterThan(mods.length);
  });
});
