import { describe, expect, it } from 'vitest';
import { verhoeffCheckDigit } from '@solar/shared';
import { IDS } from '../helpers/env';
import { API, makeEnv, seedLead } from './fixtures';

const pmsgFull = {
  applicant_name: 'Ramesh Patel', name_on_bill: 'PATEL RAMESH', consumer_no: 'UG-778899', discom_code: 'UGVCL', sanctioned_load_kw: 6, phase: 'single',
  roof_ownership: 'owned', title_ok: true, pending_dues: false, category: 'general',
};
const paths = (r: { body: { error: { details: { path: string }[] } } }) => r.body.error.details.map((d) => d.path).sort();

describe('GET /segments/:segment/form', () => {
  it('serves the built-in form with DISCOM options from the master, and per-segment differences', async () => {
    const env = await makeEnv();
    const pmsg = await env.as('dsm').get(`${API}/segments/pmsg_residential/form`);
    expect(pmsg.status).toBe(200);
    expect(pmsg.body.data).toMatchObject({ segment: 'pmsg_residential', version: 0, source: 'default', id: null });
    const byKey = new Map((pmsg.body.data.fields as { key: string; required: boolean; options?: string[]; type: string }[]).map((f) => [f.key, f]));
    expect(byKey.get('consumer_no')).toMatchObject({ required: true, type: 'text' });
    expect(byKey.get('discom_code')!.options).toEqual(['DGVCL', 'UGVCL']);
    expect(byKey.get('category')!.required).toBe(true);
    const rwa = (await env.as('dsm').get(`${API}/segments/rwa_ghs/form`)).body.data.fields.map((f: { key: string }) => f.key);
    expect(rwa).toEqual(expect.arrayContaining(['households', 'society_noc']));
    const gov = (await env.as('dsm').get(`${API}/segments/government_bid/form`)).body.data.fields as { key: string; required: boolean }[];
    expect(gov.find((f) => f.key === 'tender_no')!.required).toBe(true);
    expect(gov.find((f) => f.key === 'consumer_no')!.required).toBe(false);
    expect((await env.as('dsm').get(`${API}/segments/not_a_segment/form`)).status).toBe(422);
  });

  it('the newest published version wins; only managers may publish; Aadhaar fields are refused', async () => {
    const env = await makeEnv();
    const fields = [{ key: 'society_name', label: 'Society', type: 'text', required: true }, { key: 'lift_count', label: 'Lifts', type: 'number', required: false }];
    expect((await env.as('dsm').put(`${API}/segments/rwa_ghs/form`).send({ fields })).status).toBe(403);
    const v1 = await env.as('sales_manager').put(`${API}/segments/rwa_ghs/form`).send({ fields });
    expect(v1.status).toBe(200);
    expect(v1.body.data).toMatchObject({ version: 1, source: 'config' });
    const v2 = await env.as('techno_commercial').put(`${API}/segments/rwa_ghs/form`).send({ fields: [fields[0], { key: 'lift_count', label: 'Lifts', type: 'number', required: true }] });
    expect(v2.body.data.version).toBe(2);
    expect((await env.as('dsm').get(`${API}/segments/rwa_ghs/form`)).body.data.fields[1].required).toBe(true);
    const dup = await env.as('admin').put(`${API}/segments/rwa_ghs/form`).send({ fields: [fields[0], fields[0]] });
    expect(dup.status).toBe(422);
    const noOptions = await env.as('admin').put(`${API}/segments/rwa_ghs/form`).send({ fields: [{ key: 'kind', label: 'Kind', type: 'select', required: false }] });
    expect(noOptions.status).toBe(422);
    const aad = await env.as('admin').put(`${API}/segments/rwa_ghs/form`).send({ fields: [{ key: 'aadhaar_no', label: 'Aadhaar', type: 'text', required: true }] });
    expect(aad.status).toBe(422);
    expect(aad.body.error.details[0].message).toMatch(/Aadhaar/);
  });
});

describe('PUT /leads/:id/requirement', () => {
  it('needs a segment first', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env, { segment: null, customer_type: null, product_interest: [] });
    const g = await env.as('dsm').get(`${API}/leads/${lead.id}/requirement`);
    expect(g.body.data).toMatchObject({ segment: null, config: null, completed: false });
    const p = await env.as('dsm').put(`${API}/leads/${lead.id}/requirement`).send({ data: { consumer_no: '1234567' } });
    expect(p.status).toBe(422);
    expect(p.body.error.code).toBe('GUARD_BLOCKED');
  });

  it('a draft may be incomplete; it is saved, mirrored into the site and listed with what is missing', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    const r = await env.as('dsm').put(`${API}/leads/${lead.id}/requirement`).send({ data: { consumer_no: 'ug-778899', sanctioned_load_kw: '6.5', phase: 'single', notes: 'Prefers morning visits' } });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ completed: false, segment: 'pmsg_residential' });
    expect(r.body.data.data).toMatchObject({ consumer_no: 'ug-778899', sanctioned_load_kw: 6.5, phase: 'single' }); // "6.5" was stored as a number
    expect(r.body.data.missing_required.map((m: { key: string }) => m.key)).toEqual(expect.arrayContaining(['applicant_name', 'roof_ownership', 'category']));
    expect(r.body.data.form.completed_at).toBeNull();
    const fresh = (await env.db.table('leads').get(lead.id))!;
    expect(fresh.site_id).toBe(r.body.data.site.id);
    expect(r.body.data.site).toMatchObject({ consumer_no: 'UG-778899', sanctioned_load_kw: 6.5, phase: 'single' });
    expect(fresh.consumer_no).toBe('UG-778899');
    expect(r.body.data.form.site_id).toBe(fresh.site_id);

    const get = await env.as('dsm').get(`${API}/leads/${lead.id}/requirement`);
    expect(get.body.data.form.id).toBe(r.body.data.form.id);
    expect(get.body.data.config.fields.length).toBeGreaterThan(10);
  });

  it('merges partial saves, lets null clear an answer, and is one row per lead', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    const put = (data: Record<string, unknown>) => env.as('dsm').put(`${API}/leads/${lead.id}/requirement`).send({ data });
    await put({ consumer_no: '1111111', notes: 'first' });
    const second = await put({ phase: 'three', notes: null });
    expect(second.body.data.data).toMatchObject({ consumer_no: '1111111', phase: 'three' });
    expect(second.body.data.data).not.toHaveProperty('notes');
    expect((await env.db.table('requirement_forms').one({ lead_id: lead.id }))!.data).toEqual({ consumer_no: '1111111', phase: 'three' });
    expect(await env.db.table('requirement_forms').count({ lead_id: lead.id })).toBe(1);
  });

  it('rejects unknown keys, wrong types, bad options and bad dates even in a draft', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    const put = (data: Record<string, unknown>) => env.as('dsm').put(`${API}/leads/${lead.id}/requirement`).send({ data });
    expect(paths(await put({ bogus: 'x' }))).toEqual(['data.bogus']);
    expect(paths(await put({ sanctioned_load_kw: 'abc' }))).toEqual(['data.sanctioned_load_kw']);
    expect(paths(await put({ sanctioned_load_kw: -1 }))).toEqual(['data.sanctioned_load_kw']);
    expect(paths(await put({ phase: 'two' }))).toEqual(['data.phase']);
    expect(paths(await put({ discom_code: 'XYZ' }))).toEqual(['data.discom_code']);
    expect(paths(await put({ title_ok: 'maybe' }))).toEqual(['data.title_ok']);
    expect(paths(await put({ target_install_date: '2026-02-31' }))).toEqual(['data.target_install_date']);
    expect(paths(await put({ sanctioned_load_kw: 0 }))).toEqual(['data.sanctioned_load_kw']); // the site cannot have a zero sanctioned load
    expect((await put({ title_ok: 'true' })).status).toBe(200);
    expect(await env.db.table('requirement_forms').count()).toBe(1); // refused saves wrote nothing
  });

  it('completing enforces every required field of THE SEGMENT and records who and when', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    const url = `${API}/leads/${lead.id}/requirement`;
    const missing = await env.as('dsm').put(url).send({ complete: true, data: { consumer_no: '1234567' } });
    expect(missing.status).toBe(422);
    expect(paths(missing)).toEqual(['data.applicant_name', 'data.category', 'data.discom_code', 'data.name_on_bill', 'data.pending_dues', 'data.phase', 'data.roof_ownership', 'data.sanctioned_load_kw', 'data.title_ok']);
    expect(await env.db.table('requirement_forms').count()).toBe(0);

    const done = await env.as('dsm').put(url).send({ complete: true, data: pmsgFull });
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ completed: true, missing_required: [] });
    expect(done.body.data.form).toMatchObject({ completed_by: IDS.profile('dsm'), completed_at: env.now().toISOString() });
    const ugvcl = (await env.db.table('discoms').all()).find((d) => d.code === 'UGVCL')!;
    expect(done.body.data.site).toMatchObject({ discom_id: ugvcl.id, roof_ownership: 'owned', title_ok: true, pending_dues: false, category: 'general', name_match: true });
    const events = (await env.db.table('lead_events').all({ lead_id: lead.id })).map((e) => e.event_type);
    expect(events).toContain('requirement_completed');

    // clearing a required answer drops the form back to a draft
    const reopened = await env.as('dsm').put(url).send({ data: { roof_ownership: null } });
    expect(reopened.body.data.completed).toBe(false);
    expect(reopened.body.data.form.completed_at).toBeNull();
  });

  it('a seeded form that asks for the DISCOM under the key "discom" (display name) still reaches the site', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    await env.ctx().db.table('segment_form_config').insert({ segment: 'pmsg_residential', version: 1, fields: [{ key: 'discom', label: 'DISCOM', type: 'select', required: true, options: ['UGVCL', 'Dakshin Gujarat Vij Company'] }] });
    const res = await env.as('dsm').put(`${API}/leads/${lead.id}/requirement`).send({ data: { discom: 'Dakshin Gujarat Vij Company' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const dgvcl = (await env.db.table('discoms').all()).find((d) => d.code === 'DGVCL')!;
    expect(res.body.data.site).toMatchObject({ discom_id: dgvcl.id });
  });

  it('other segments ask for their own fields', async () => {
    const env = await makeEnv();
    const society = await seedLead(env, { name: 'Shreeji Heights CHS', segment: 'rwa_ghs', customer_type: 'housing_society', capacity_kw: 60 });
    const base = { ...pmsgFull, applicant_name: 'Shreeji Heights CHS', name_on_bill: 'Shreeji Heights CHS' } as Record<string, unknown>;
    delete base['category'];
    const r = await env.as('dsm').put(`${API}/leads/${society.id}/requirement`).send({ complete: true, data: base });
    expect(paths(r)).toEqual(['data.common_area_load_kw', 'data.households', 'data.society_name', 'data.society_noc']);
    const ok = await env.as('dsm').put(`${API}/leads/${society.id}/requirement`).send({ complete: true, data: { ...base, society_name: 'Shreeji Heights', households: 48, common_area_load_kw: 22, society_noc: true } });
    expect(ok.body.data.completed).toBe(true);

    const ci = await seedLead(env, { name: 'Alpha Foods', segment: 'ci_net_metered', customer_type: 'commercial', capacity_kw: 100 });
    const c = await env.as('dsm').put(`${API}/leads/${ci.id}/requirement`).send({ complete: true, data: { ...base, applicant_name: 'Alpha Foods', name_on_bill: 'Alpha Foods' } });
    expect(paths(c)).toEqual(['data.contracted_demand_kva']);
    const kusum = await seedLead(env, { name: 'Farmer Joshi', segment: 'pm_kusum', customer_type: 'farmer', capacity_kw: 7.5 });
    const k = await env.as('dsm').put(`${API}/leads/${kusum.id}/requirement`).send({ complete: true, data: { applicant_name: 'Farmer Joshi', name_on_bill: 'Farmer Joshi' } });
    expect(paths(k)).toEqual(['data.kusum_component', 'data.land_area_acres', 'data.land_survey_no', 'data.title_ok']);
    // a field of another segment is not accepted
    const wrong = await env.as('dsm').put(`${API}/leads/${kusum.id}/requirement`).send({ data: { households: 10 } });
    expect(paths(wrong)).toEqual(['data.households']);
  });

  it('a changed segment re-validates against the new form and reports answers the new form does not have', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    await env.as('dsm').put(`${API}/leads/${lead.id}/requirement`).send({ data: { loan_required: true, consumer_no: '7654321' } });
    await env.db.table('leads').update(lead.id, { segment: 'ci_captive' });
    const view = await env.as('dsm').get(`${API}/leads/${lead.id}/requirement`);
    expect(view.body.data.segment).toBe('ci_captive');
    expect(view.body.data.stale_keys).toEqual(['loan_required']);
    expect(view.body.data.missing_required.map((m: { key: string }) => m.key)).toContain('contracted_demand_kva');
  });

  it('refuses Aadhaar fields and numbers, merged leads and other distributors', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    const url = `${API}/leads/${lead.id}/requirement`;
    const key = await env.as('dsm').put(url).send({ data: { aadhaar_no: '1234' } });
    expect(key.body.error.code).toBe('AADHAAR_BLOCKED');
    const n = '23456789012' + verhoeffCheckDigit('23456789012');
    const val = await env.as('dsm').put(url).send({ data: { notes: `ID ${n}` } });
    expect(val.body.error.code).toBe('AADHAAR_BLOCKED');
    expect(await env.db.table('requirement_forms').count()).toBe(0);
    const merged = await seedLead(env, { status: 'merged' });
    expect((await env.as('dsm').put(`${API}/leads/${merged.id}/requirement`).send({ data: { notes: 'x' } })).body.error.code).toBe('INVALID_STATE');
    expect((await env.as(IDS.distributorUserB).put(url).send({ data: { notes: 'x' } })).status).toBe(403);
    expect((await env.as(IDS.distributorUserB).get(url)).status).toBe(403);
    expect((await env.as('distributor_user').put(url).send({ data: { notes: 'mine' } })).status).toBe(200);
  });
});

describe('GET /leads/:id/requirement without a stored segment', () => {
  it('works the segment out from the customer type and opens the form', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env, { segment: null, customer_type: 'housing_society' });
    const g = await env.as('dsm').get(`${API}/leads/${lead.id}/requirement`);
    expect(g.body.data.segment).toBe('rwa_ghs');
    expect(g.body.data.config).not.toBeNull();
  });
});

describe('the step-15 chart: site, MW, load type, timeline, specs', () => {
  it('every segment form carries size, load type, timeline and specs; size and timeline are copied to the lead', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env, { capacity_kw: 3 });
    const g = await env.as('dsm').get(`${API}/leads/${lead.id}/requirement`);
    const keys = (g.body.data.config.fields as { key: string }[]).map((f) => f.key);
    for (const k of ['capacity_kw', 'load_type', 'timeline_bucket']) expect(keys).toContain(k);
    expect(keys.some((k) => k === 'specs' || k === 'specs_notes')).toBe(true);
    expect(g.body.data.data.capacity_kw).toBe(3); // prefilled from the lead
    const p = await env.as('dsm').put(`${API}/leads/${lead.id}/requirement`).send({ data: { capacity_kw: 12, timeline_bucket: 'within_30_days' } });
    expect(p.status).toBe(200);
    expect(await env.db.table('leads').get(lead.id)).toMatchObject({ capacity_kw: 12, timeline_bucket: 'within_30_days' });
  });
});

describe('the chart-only form (Site, MW, Load type, Timeline, Specs)', () => {
  it('completes with just those answers, without the segment-specific fields', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env, { capacity_kw: null, timeline_bucket: null });
    const put = (body: Record<string, unknown>) => env.as('dsm').put(`${API}/leads/${lead.id}/requirement`).send({ chart_only: true, ...body });
    const bad = await put({ complete: true, data: { site_note: 'Plot 4, Satellite, Ahmedabad — RCC roof' } });
    expect(bad.status).toBe(422);
    const ok = await put({ complete: true, data: { site_note: 'Plot 4, Satellite, Ahmedabad — RCC roof', capacity_kw: 8, load_type: 'residential', timeline_bucket: 'immediate', specs: 'Mono PERC, on-grid' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.completed).toBe(true);
    expect(await env.db.table('leads').get(lead.id)).toMatchObject({ capacity_kw: 8, timeline_bucket: 'immediate' });
  });
});

describe('step 16: the product shortlist is saved and can be changed', () => {
  it('saves, reads back, replaces and clears the chosen products, and rejects unknown ones', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    const org = lead.org_id;
    const mk = (model: string) => env.db.table('skus').insert({ org_id: org, category: 'module', make: 'Waaree', model, variant: null, wattage: 545, hsn: '85414300', uom: 'nos', active: true, demo: false, description: null, warranty_years: 12, brand_usp: null });
    const [a, b] = [await mk('A-545'), await mk('B-545')];
    const url = `${API}/leads/${lead.id}/shortlist`;
    expect((await env.as('dsm').get(url)).body.data.sku_ids).toEqual([]);
    const first = await env.as('dsm').put(url).send({ sku_ids: [a.id, b.id] });
    expect(first.status).toBe(200);
    expect((await env.as('dsm').get(url)).body.data.sku_ids.sort()).toEqual([a.id, b.id].sort());
    expect((await env.as('dsm').put(url).send({ sku_ids: [b.id] })).body.data.sku_ids).toEqual([b.id]);
    expect((await env.as('dsm').get(url)).body.data.sku_ids).toEqual([b.id]);
    expect((await env.as('dsm').put(url).send({ sku_ids: ['00000000-0000-4000-8000-000000000000'] })).status).toBe(422);
    expect((await env.as('dsm').put(url).send({ sku_ids: [] })).body.data.sku_ids).toEqual([]);
    // the requirement form view is not polluted by it
    expect((await env.as('dsm').get(`${API}/leads/${lead.id}/requirement`)).body.data.stale_keys).toEqual([]);
  });
});
