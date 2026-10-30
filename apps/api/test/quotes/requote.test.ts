/** Re-quote engine: rule-change hook, SKU compliance / price hooks, nightly scan, expiry, exposure report. */
import { describe, expect, it } from 'vitest';
import { registeredJobs } from '../../src/services/hooks';
import { expireQuotes, scanOpenQuotes } from '../../src/services/requoteService';
import { IDS, addSku, makeWorld, quoteWith, type World } from './helpers';

const status = async (w: World, id: string) => (await w.c().db.table('quotations').getOrThrow(id)).status;

describe('re-quote flagging', () => {
  it('a GST rule change flags every open quote that depends on it, notifies owner and DSM, and audits', async () => {
    const w = await makeWorld();
    const sku = await addSku(w);
    const open = await quoteWith(w, [sku]);
    const accepted = await quoteWith(w, [sku]);
    await w.c().db.table('quotations').update(accepted.id, { status: 'accepted' });
    const other = await quoteWith(w, [await addSku(w, { category: 'structure', hsn: '73089090' })]); // no GST rule in its lines → independent

    const gst = (await w.c().svc.rules.path('gst.modules_cells_rate'))!;
    expect((await w.c().db.table('quotations').getOrThrow(open.id)).rule_ids_used).toContain(gst.id);
    await w.c('compliance_officer').svc.rules.update(gst.id, { value: 12 });

    const flagged = await w.c().db.table('quotations').getOrThrow(open.id);
    expect(flagged.status).toBe('requote_required');
    expect(flagged.requote_reason).toMatch(/gst\.modules_cells_rate/);
    expect(await status(w, accepted.id)).toBe('accepted');
    expect(await status(w, other.id)).not.toBe('requote_required');

    const notes = await w.c().db.table('notifications').all({ kind: 'quote.requote_required', entity_id: open.id });
    expect(notes.map((n) => n.user_id)).toContain(IDS.profile('dsm')); // owner and DSM are the same person in the fixture
    const audits = await w.c().db.table('audit_log').all({ action: 'quote.requote_required', record_id: open.id });
    expect(audits).toHaveLength(1);
  });

  it('a new effective-dated version of the rule counts as a change to the rule', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w)]);
    await w.c('compliance_officer').svc.rules.createVersion({ category: 'gst', key: 'modules_cells_rate', value: 12, effective_from: '2027-01-01', source_name: 'CBIC', source_ref: 'Notification 1/2027', confidence: 'high', status: 'verified', is_active: true });
    expect(await status(w, q.id)).toBe('requote_required');
  });

  it('rule categories that cannot change a quote do not flag it', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w)]);
    const r = await w.env.rule('sla.followup_days.hot', 1);
    await w.c('admin').svc.rules.update(r.id, { value: 2 });
    expect(await status(w, q.id)).toBe('draft');
  });

  it('an SKU compliance change flags quotes carrying that SKU; saving the same entry again does not', async () => {
    const w = await makeWorld();
    const sku = await addSku(w);
    const q = await quoteWith(w, [sku]);
    const body = { almm_list1: true, almm_list1_ref: 'ALMM/1', almm_list1_valid_till: '2027-12-31', almm_snapshot_date: '2026-10-26', cell_maker: 'Waaree', almm_list2: true, dcr_verified: true, cell_origin: 'India', bis_licence_no: 'BIS-X', bis_licensed_model: sku.model, bis_standard_no: 'IS 14286', bis_valid_till: '2027-12-31', inverter_kw: null, self_certified: false, thin_film: false };
    const co = w.env.as('compliance_officer');
    expect((await co.put(`/api/v1/skus/${sku.id}/compliance`).send({ ...body, bis_licence_no: (await w.c().db.table('sku_compliance').one({ sku_id: sku.id }))!.bis_licence_no })).status).toBe(200);
    expect(await status(w, q.id)).toBe('draft'); // only the snapshot date / verifier moved
    const res = await co.put(`/api/v1/skus/${sku.id}/compliance`).send({ ...body, dcr_verified: false });
    expect(res.status).toBe(200);
    expect(await status(w, q.id)).toBe('requote_required');
    expect((await w.c().db.table('quotations').getOrThrow(q.id)).requote_reason).toMatch(/register entry changed/);
  });

  it('a new price snapshot flags the quotes and closes the previous snapshot', async () => {
    const w = await makeWorld();
    const sku = await addSku(w);
    const q = await quoteWith(w, [sku]);
    const res = await w.env.as('management').post('/api/v1/prices').send({ sku_id: sku.id, base_price: 22000, valid_from: '2026-10-27', landed_cost: { basic: 13000 }, floor_price: 16000, snapshot_label: 'Nov' });
    expect(res.status).toBe(201);
    const prices = await w.c().db.table('sku_prices').all({ sku_id: sku.id }, { orderBy: { col: 'valid_from' } });
    expect(prices[0]).toMatchObject({ valid_from: '2026-01-01', valid_to: '2026-10-26' });
    expect(prices[1]).toMatchObject({ valid_from: '2026-10-27', valid_to: null });
    expect(await status(w, q.id)).toBe('requote_required');
    expect((await w.c().db.table('quotations').getOrThrow(q.id)).requote_reason).toMatch(/no longer current/);
  });

  it('a flagged quote that was never sent can be re-quoted in place; a sent one must be revised', async () => {
    const w = await makeWorld();
    const sku = await addSku(w);
    const q = await quoteWith(w, [sku]);
    await w.c('compliance_officer').svc.rules.update((await w.c().svc.rules.path('gst.modules_cells_rate'))!.id, { value: 12 });
    expect(await status(w, q.id)).toBe('requote_required');
    const put = await w.env.as('dsm').put(`/api/v1/quotes/${q.id}/lines`).send({ lines: [{ sku_id: sku.id, qty: 2 }] });
    expect(put.body.data).toMatchObject({ status: 'draft', requote_reason: null });
    expect(put.body.data.lines[0].gst_rate).toBe(12);

    const sent = await quoteWith(w, [sku]);
    await w.env.as('dsm').post(`/api/v1/quotes/${sent.id}/request-approval`).send({});
    await w.env.as('dsm').post(`/api/v1/quotes/${sent.id}/send`).send({});
    await w.c('compliance_officer').svc.rules.update((await w.c().svc.rules.path('gst.modules_cells_rate'))!.id, { value: 18 });
    expect(await status(w, sent.id)).toBe('requote_required');
    expect(await w.c().db.table('clocks').count({ clock_type: 'quote_followup', entity_id: sent.id, status: 'running' })).toBe(0);
    expect((await w.env.as('dsm').put(`/api/v1/quotes/${sent.id}/lines`).send({ lines: [] })).status).toBe(409);
    const rev = await w.env.as('dsm').post(`/api/v1/quotes/${sent.id}/revise`).send({});
    expect(rev.body.data.version).toBe(2);
    expect(rev.body.data.lines[0].gst_rate).toBe(18); // re-priced on the current rules
  });
});

describe('nightly jobs', () => {
  it('registers the expiry and the re-quote scan jobs', () => {
    const names = registeredJobs().map((j) => j.name);
    expect(names).toEqual(expect.arrayContaining(['quotes.expire', 'quotes.requote_scan']));
  });

  it('the scan catches a rule edited without the hook, a newer rule version in force today, and a changed register entry', async () => {
    const w = await makeWorld();
    const sku = await addSku(w);
    const q = await quoteWith(w, [sku]);
    expect((await scanOpenQuotes(w.c())).flagged).toBe(0);

    w.env.advance(60_000);
    const gst = (await w.c().svc.rules.path('gst.modules_cells_rate'))!;
    await w.c().db.table('rule_config').update(gst.id, { value: 12 }); // direct edit: no hook fired
    expect(await status(w, q.id)).toBe('draft');
    expect(await scanOpenQuotes(w.c())).toEqual({ scanned: 1, flagged: 1 });
    expect(await status(w, q.id)).toBe('requote_required');

    const w2 = await makeWorld();
    const sku2 = await addSku(w2);
    const q2 = await quoteWith(w2, [sku2]);
    w2.env.advance(60_000);
    await w2.c().db.table('sku_compliance').update((await w2.c().db.table('sku_compliance').one({ sku_id: sku2.id }))!.id, { almm_list2: false });
    expect((await scanOpenQuotes(w2.c())).flagged).toBe(1);
    expect(await status(w2, q2.id)).toBe('requote_required');
  });

  it('quotes whose validity date has passed flip to expired', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w)]);
    const accepted = await quoteWith(w, [await addSku(w)]);
    await w.c().db.table('quotations').update(accepted.id, { status: 'accepted' });
    expect((await expireQuotes(w.c())).expired).toBe(0);
    w.env.setNow(new Date('2026-11-05T05:00:00Z'));
    expect((await expireQuotes(w.c())).expired).toBe(1);
    expect(await status(w, q.id)).toBe('expired');
    expect(await status(w, accepted.id)).toBe('accepted');
    // an expired quote is renewed by revising it (re-priced)
    const rev = await w.env.as('dsm').post(`/api/v1/quotes/${q.id}/revise`).send({});
    expect(rev.status).toBe(201);
    expect(rev.body.data.validity_date >= '2026-11-05').toBe(true);
  });

  it('the jobs run through the registered runner definitions', async () => {
    const w = await makeWorld();
    await quoteWith(w, [await addSku(w)]);
    const job = registeredJobs().find((j) => j.name === 'quotes.expire')!;
    expect(await job.run(w.env.systemCtx())).toEqual({ expired: 0 });
  });
});

describe('re-quote exposure report', () => {
  it('groups open quotes by SKU with counts and rupee value', async () => {
    const w = await makeWorld();
    const a = await addSku(w);
    const b = await addSku(w);
    const q1 = await quoteWith(w, [a, b], { qty: 10 });
    await quoteWith(w, [a], { qty: 5 });
    await w.c('compliance_officer').svc.rules.update((await w.c().svc.rules.path('gst.modules_cells_rate'))!.id, { value: 12 });
    expect(await status(w, q1.id)).toBe('requote_required');

    const res = await w.env.as('sales_manager').get('/api/v1/reports/requote-exposure');
    expect(res.status).toBe(200);
    const rows = res.body.data.rows as { sku_id: string; open_quotes: number; requote_required: number; value: number; flagged_value: number }[];
    const rowA = rows.find((r) => r.sku_id === a.id)!;
    expect(rowA).toMatchObject({ open_quotes: 2, requote_required: 2 });
    expect(rowA.value).toBeCloseTo(15 * 20000 * 1.05, 2); // quoted lines keep the rate they were priced at
    expect(rows.find((r) => r.sku_id === b.id)!.open_quotes).toBe(1);
    expect(res.body.data.totals.open_quotes).toBe(2);
    const flagged = await w.env.as('sales_manager').get('/api/v1/reports/requote-exposure?only_flagged=true');
    expect(flagged.body.data.totals.requote_required).toBe(2);
    expect((await w.env.as('dealer_user').get('/api/v1/reports/requote-exposure')).status).toBe(403);
  });
});
