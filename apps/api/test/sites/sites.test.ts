import { describe, expect, it } from 'vitest';
import { verhoeffCheckDigit } from '@solar/shared';
import { IDS } from '../helpers/env';
import { API, makeEnv, saveSite, seedLead, seedLeadB } from './fixtures';

const GSTIN = '24AAACF1234A1Z5'; // PAN inside = AAACF1234A

describe('PUT /leads/:id/site — customer + site on first save', () => {
  it('creates the pair once, links the lead, mirrors the consumer number and derives the name match', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    const first = await env.as('dsm').put(`${API}/leads/${lead.id}/site`).send({
      name_on_bill: 'PATEL RAMESH', applicant_name: 'Ramesh Patel', consumer_no: ' ug 12345 ', discom_code: 'ugvcl', sanctioned_load_kw: 6.5, phase: 'single',
      roof_ownership: 'owned', title_ok: true, pending_dues: false, existing_solar_kw: 0, category: 'general', lat: 23.0225, lng: 72.5714,
    });
    expect(first.status).toBe(201);
    expect(first.body.data.created).toEqual({ customer: true, site: true });
    const site = first.body.data.site;
    expect(site).toMatchObject({ name_match: true, consumer_no: 'UG 12345', sanctioned_load_kw: 6.5, lead_id: lead.id, state: 'Gujarat', special_category_state: false });
    const ugvcl = (await env.db.table('discoms').all()).find((d) => d.code === 'UGVCL')!;
    expect(site.discom_id).toBe(ugvcl.id);
    expect(first.body.data.customer).toMatchObject({ legal_name: 'Ramesh Patel', lead_id: lead.id });

    const linked = (await env.db.table('leads').get(lead.id))!;
    expect(linked.customer_id).toBe(first.body.data.customer.id);
    expect(linked.site_id).toBe(site.id);
    expect(linked.consumer_no).toBe('UG 12345');

    const again = await env.as('dsm').put(`${API}/leads/${lead.id}/site`).send({ sanctioned_load_kw: 7 });
    expect(again.status).toBe(200);
    expect(again.body.data.created).toEqual({ customer: false, site: false });
    expect(again.body.data.site.sanctioned_load_kw).toBe(7);
    expect(again.body.data.site.consumer_no).toBe('UG 12345'); // untouched fields are kept
    expect(await env.db.table('customers').count()).toBe(1);
    expect(await env.db.table('sites').count()).toBe(1);
    expect((await env.db.table('audit_log').all()).some((a) => a.source === 'api' && a.action === 'site.save')).toBe(true);
  });

  it('flags a name mismatch and pending dues as G12 hints, and clears them when fixed', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    const bad = await env.as('dsm').put(`${API}/leads/${lead.id}/site`).send({ name_on_bill: 'Suresh Shah', pending_dues: true });
    expect(bad.body.data.site.name_match).toBe(false);
    const codes = bad.body.data.hints.map((h: { code: string; gate?: string }) => h.code);
    expect(codes).toEqual(expect.arrayContaining(['NAME_MISMATCH', 'PENDING_DUES']));
    expect(bad.body.data.hints.find((h: { code: string }) => h.code === 'NAME_MISMATCH').gate).toBe('G12');
    const view = await env.as('dsm').get(`${API}/leads/${lead.id}/site`);
    expect(view.body.data.hints).toHaveLength(2);

    const fixed = await env.as('dsm').put(`${API}/leads/${lead.id}/site`).send({ name_on_bill: 'Ramesh Patel', pending_dues: false });
    expect(fixed.body.data.site.name_match).toBe(true);
    expect(fixed.body.data.hints).toEqual([]);
  });

  it('leaves name_match null until both names are known', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    const r = await env.as('dsm').put(`${API}/leads/${lead.id}/site`).send({ consumer_no: '99887766' });
    expect(r.body.data.site.name_match).toBe(null);
  });

  it('special-category flag: inactive rule → hint only; manual override wins; active rule derives it', async () => {
    const env = await makeEnv();
    await env.rule('pmsg.special_category_states', ['Assam', 'Meghalaya'], { is_active: false, status: 'unverified', confidence: 'low' });
    const lead = await seedLead(env, { state: 'Assam', pincode: '781001' });
    const first = await env.as('dsm').put(`${API}/leads/${lead.id}/site`).send({ name_on_bill: lead.name });
    expect(first.body.data.site.special_category_state).toBe(false); // the unverified list never changes a record on its own
    expect(first.body.data.special_category).toMatchObject({ listed: true, rule_active: false, rule_status: 'unverified', basis: 'unchanged' });
    expect(first.body.data.hints.map((h: { code: string }) => h.code)).toContain('SPECIAL_CATEGORY_UNVERIFIED');
    const manual = await env.as('dsm').put(`${API}/leads/${lead.id}/site`).send({ special_category_state: true });
    expect(manual.body.data.site.special_category_state).toBe(true);
    expect(manual.body.data.special_category.basis).toBe('manual_override');
    expect(manual.body.data.hints.map((h: { code: string }) => h.code)).not.toContain('SPECIAL_CATEGORY_UNVERIFIED');

    const env2 = await makeEnv();
    await env2.rule('pmsg.special_category_states', ['Assam', 'Meghalaya']);
    const guj = await seedLead(env2);
    const g = await env2.as('dsm').put(`${API}/leads/${guj.id}/site`).send({});
    expect(g.body.data.site.special_category_state).toBe(false);
    const moved = await env2.as('dsm').put(`${API}/leads/${guj.id}/site`).send({ state: 'Assam' });
    expect(moved.body.data.site.special_category_state).toBe(true);
    expect(moved.body.data.special_category.basis).toBe('derived');
    const override = await env2.as('dsm').put(`${API}/leads/${guj.id}/site`).send({ special_category_state: false });
    expect(override.body.data.site.special_category_state).toBe(false);
    const unrelated = await env2.as('dsm').put(`${API}/leads/${guj.id}/site`).send({ sanctioned_load_kw: 5 });
    expect(unrelated.body.data.site.special_category_state).toBe(false); // an unrelated save does not undo the manual override
  });

  it('fills city / state from the pincode table when only a pincode is typed', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env, { city: null, district: null, state: null, pincode: null });
    const r = await env.as('dsm').put(`${API}/leads/${lead.id}/site`).send({ pincode: '395003' });
    expect(r.body.data.site).toMatchObject({ pincode: '395003', city: 'Surat', district: 'Surat', state: 'Gujarat' });
  });

  it('rejects bad input and Aadhaar fields', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    const url = `${API}/leads/${lead.id}/site`;
    expect((await env.as('dsm').put(url).send({ sanctioned_load_kw: -3 })).status).toBe(422);
    expect((await env.as('dsm').put(url).send({ phase: 'two' })).status).toBe(422);
    expect((await env.as('dsm').put(url).send({ discom_code: 'NOPE' })).body.error.details[0].path).toBe('discom_code');
    expect((await env.as('dsm').put(url).send({ consumer_no: '12' })).status).toBe(422);
    const key = await env.as('dsm').put(url).send({ aadhaar_number: '1234' });
    expect(key.status).toBe(422);
    expect(key.body.error.code).toBe('AADHAAR_BLOCKED');
    const n = '23456789012' + verhoeffCheckDigit('23456789012');
    const value = await env.as('dsm').put(url).send({ name_on_bill: `Ramesh ${n}` });
    expect(value.body.error.code).toBe('AADHAAR_BLOCKED');
    expect(await env.db.table('sites').count()).toBe(0); // nothing was created by the refused calls
  });

  it('refuses merged leads and unknown ones', async () => {
    const env = await makeEnv();
    const merged = await seedLead(env, { status: 'merged' });
    expect((await env.as('dsm').put(`${API}/leads/${merged.id}/site`).send({})).body.error.code).toBe('INVALID_STATE');
    expect((await env.as('dsm').get(`${API}/leads/00000000-0000-4000-8000-000000000000/site`)).status).toBe(404);
    expect((await env.as('dsm').get(`${API}/leads/not-a-uuid/site`)).status).toBe(404);
  });
});

describe('customers — GSTIN / PAN validation and the Aadhaar guard', () => {
  it('validates GSTIN and PAN, keeps them consistent and unique', async () => {
    const env = await makeEnv();
    const post = (b: Record<string, unknown>) => env.as('sales_manager').post(`${API}/customers`).send(b);
    expect((await post({ legal_name: 'Sun Power Pvt Ltd', gstin: '24BAD' })).status).toBe(422);
    expect((await post({ legal_name: 'Sun Power Pvt Ltd', pan: 'bad' })).status).toBe(422);
    const mismatch = await post({ legal_name: 'Sun Power Pvt Ltd', gstin: GSTIN, pan: 'ZZZZZ9999Z' });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.details[0].path).toBe('pan');
    const ok = await post({ legal_name: 'Sun Power Pvt Ltd', gstin: GSTIN.toLowerCase(), pan: 'aaacf1234a', customer_type: 'commercial', phone: '98765 43210', email: 'Accounts@SunPower.IN', aadhaar_last4: '4321' });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ gstin: GSTIN, pan: 'AAACF1234A', phone: '+919876543210', email: 'accounts@sunpower.in', aadhaar_last4: '4321' });
    const dup = await post({ legal_name: 'Another Name', gstin: GSTIN });
    expect(dup.status).toBe(409);
    const patch = await env.as('accounts').patch(`${API}/customers/${ok.body.data.id}`).send({ billing_address: { line1: '12 Ring Road', city: 'Ahmedabad', state: 'Gujarat', pincode: '380001' } });
    expect(patch.status).toBe(200);
    expect(patch.body.data.billing_address.pincode).toBe('380001');
    const badPan = await env.as('accounts').patch(`${API}/customers/${ok.body.data.id}`).send({ pan: 'ZZZZZ9999Z' });
    expect(badPan.status).toBe(422); // PAN no longer agrees with the stored GSTIN
  });

  it('accepts only the last four Aadhaar digits', async () => {
    const env = await makeEnv();
    const post = (b: Record<string, unknown>) => env.as('dsm').post(`${API}/customers`).send({ legal_name: 'Hansa Shah', ...b });
    expect((await post({ aadhaar_last4: '123' })).status).toBe(422);
    expect((await post({ aadhaar_last4: '12345' })).status).toBe(422);
    expect((await post({ aadhaar_last4: 'ab12' })).status).toBe(422);
    const n = '23456789012' + verhoeffCheckDigit('23456789012');
    const full = await post({ aadhaar_last4: n });
    expect(full.status).toBe(422);
    expect(full.body.error.code).toBe('AADHAAR_BLOCKED'); // a real Aadhaar number is stopped at the edge
    expect((await post({ aadhaar_number: '1234' })).body.error.code).toBe('AADHAAR_BLOCKED');
    expect((await post({ aadhaar: 'x' })).body.error.code).toBe('AADHAAR_BLOCKED');
    expect((await post({ aadhaar_last4: '5678' })).status).toBe(201);
  });

  it('lists with filters and masks contact details for roles without a need', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    await saveSite(env, lead);
    const dsm = await env.as('dsm').get(`${API}/customers?q=ramesh`);
    expect(dsm.body.total).toBe(1);
    expect(dsm.body.data[0].phone).toBe('+919876543210');
    const viewer = await env.as('viewer').get(`${API}/customers?customer_type=residential`);
    expect(viewer.body.total).toBe(1);
    expect(viewer.body.data[0].phone).not.toContain('98765');
    expect(viewer.body.data[0].email).toContain('•');
    const detail = await env.as('dsm').get(`${API}/customers/${dsm.body.data[0].id}`);
    expect(detail.body.data.sites).toHaveLength(1);
    expect(detail.body.data.leads[0].id).toBe(lead.id);
  });
});

describe('electricity bill upload', () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

  it('stores the bill privately, marks bill_captured and serves a signed URL', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    const up = await env.as('dsm').post(`${API}/leads/${lead.id}/site/bill`).attach('file', pdf, { filename: 'ugvcl-bill.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(201);
    expect(up.body.data.bill_captured).toBe(true);
    expect(up.body.data.document).toMatchObject({ bucket: 'lead-docs', doc_type: 'electricity_bill', entity_type: 'site' });
    // the quality score has a "bill captured" component, so the upload must re-score the lead (regression: the score stayed stale)
    const scored = (await env.db.table('lead_scores').all({ lead_id: lead.id })).at(-1)!;
    expect(scored.components.find((c) => c.key === 'bill_captured')!.points).toBeGreaterThan(0);
    expect((await env.db.table('leads').get(lead.id))!.quality_score).toBe(scored.score);
    expect((await env.db.table('leads').get(lead.id))!.bill_captured).toBe(true);
    const site = up.body.data.site;
    expect(site.bill_doc_id).toBe(up.body.data.document.id);
    expect([...env.providers.files.keys()].some((k) => k.startsWith('lead-docs/'))).toBe(true);
    const url = await env.as('dsm').get(`${API}/sites/${site.id}/bill/url`);
    expect(url.status).toBe(200);
    expect(url.body.data.url).toMatch(/^https:\/\/fake\.storage\/lead-docs\//);
    expect((await env.as('dsm').get(`${API}/leads/${lead.id}/site`)).body.data.bill.file_name).toBe('ugvcl-bill.pdf');
    const viaSite = await env.as('dsm').post(`${API}/sites/${site.id}/bill`).attach('file', pdf, { filename: 'second.pdf', contentType: 'application/pdf' });
    expect(viaSite.status).toBe(201);
  });

  it('refuses Aadhaar-named files and wrong types without creating anything', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    const aad = await env.as('dsm').post(`${API}/leads/${lead.id}/site/bill`).attach('file', pdf, { filename: 'aadhaar_card.pdf', contentType: 'application/pdf' });
    expect(aad.status).toBe(422);
    expect(aad.body.error.code).toBe('AADHAAR_BLOCKED');
    const txt = await env.as('dsm').post(`${API}/leads/${lead.id}/site/bill`).attach('file', Buffer.from('hello'), { filename: 'bill.txt', contentType: 'text/plain' });
    expect(txt.status).toBe(415);
    const none = await env.as('dsm').post(`${API}/leads/${lead.id}/site/bill`).send({});
    expect(none.status).toBe(400);
    expect(await env.db.table('sites').count()).toBe(0);
    expect(await env.db.table('documents').count()).toBe(0);
    expect((await env.db.table('leads').get(lead.id))!.bill_captured).toBe(false);
  });
});

describe('standalone /sites endpoints and access scoping', () => {
  it('creates, reads, filters and updates sites', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    const { site } = await saveSite(env, lead, { name_on_bill: 'Someone Else', pending_dues: true });
    const standalone = await env.as('sales_manager').post(`${API}/sites`).send({ consumer_no: 'STAND-1', city: 'Rajkot', state: 'Gujarat', name_on_bill: 'Kiran Joshi', applicant_name: 'Kiran Joshi' });
    expect(standalone.status).toBe(201);
    expect(standalone.body.data.site).toMatchObject({ lead_id: null, name_match: true });
    const dupe = await env.as('dsm').post(`${API}/sites`).send({ lead_id: lead.id, consumer_no: 'X1234' });
    expect(dupe.status).toBe(409); // the lead already has a site
    const list = await env.as('dsm').get(`${API}/sites?name_match=false`);
    expect(list.body.data.map((s: { id: string }) => s.id)).toEqual([site.id]);
    expect((await env.as('dsm').get(`${API}/sites?q=stand`)).body.total).toBe(1);
    const detail = await env.as('dsm').get(`${API}/sites/${site.id}`);
    expect(detail.body.data).toMatchObject({ id: site.id, has_bill: false });
    expect(detail.body.data.lead.id).toBe(lead.id);
    expect(detail.body.data.hints.map((h: { code: string }) => h.code)).toContain('NAME_MISMATCH');
    const patch = await env.as('dsm').patch(`${API}/sites/${site.id}`).send({ name_on_bill: 'Ramesh Patel', pending_dues: false });
    expect(patch.body.data.site.name_match).toBe(true);
    const bad = await env.as('dsm').patch(`${API}/sites/${site.id}`).send({ bogus: 1 });
    expect(bad.status).toBe(422);
  });

  it('a distributor or dealer only reaches their own leads’ customers and sites', async () => {
    const env = await makeEnv();
    const a = await seedLead(env);
    const b = await seedLeadB(env);
    const sa = await saveSite(env, a);
    const sb = await saveSite(env, b);
    const asA = env.as('distributor_user');
    expect((await asA.get(`${API}/leads/${a.id}/site`)).status).toBe(200);
    expect((await asA.get(`${API}/leads/${b.id}/site`)).status).toBe(403);
    expect((await asA.put(`${API}/leads/${b.id}/site`).send({ sanctioned_load_kw: 1 })).status).toBe(403);
    expect((await asA.get(`${API}/sites/${sb.site.id}`)).status).toBe(403);
    expect((await asA.get(`${API}/customers/${sb.customer_id}`)).status).toBe(403);
    const sites = await asA.get(`${API}/sites`);
    expect(sites.body.data.map((s: { id: string }) => s.id)).toEqual([sa.site.id]);
    expect((await asA.get(`${API}/customers`)).body.total).toBe(1);
    expect((await asA.get(`${API}/sites?lead_id=${b.id}`)).body.total).toBe(0); // a crafted filter cannot widen the scope
    const asB = env.as(IDS.distributorUserB);
    expect((await asB.get(`${API}/sites`)).body.data.map((s: { id: string }) => s.id)).toEqual([sb.site.id]);
    expect((await env.as('admin').get(`${API}/sites`)).body.total).toBe(2);
    // a dealer sees only its own dealer's leads
    const other = await seedLead(env, { name: 'Other Dealer Lead', dealer_id: IDS.dealerA2 });
    expect((await env.as('dealer_user').get(`${API}/leads/${a.id}/site`)).status).toBe(200);
    expect((await env.as('dealer_user').get(`${API}/leads/${other.id}/site`)).status).toBe(403);
    // external users cannot create orphan sites
    expect((await asA.post(`${API}/sites`).send({ consumer_no: 'ORPHAN-1' })).status).toBe(403);
  });

  it('read-only roles cannot write', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    expect((await env.as('viewer').put(`${API}/leads/${lead.id}/site`).send({})).status).toBe(403);
    expect((await env.as('accounts').put(`${API}/leads/${lead.id}/site`).send({})).status).toBe(403);
    expect((await env.as('viewer').get(`${API}/leads/${lead.id}/site`)).status).toBe(200);
    expect((await env.anon().get(`${API}/leads/${lead.id}/site`)).status).toBe(401);
  });
});
