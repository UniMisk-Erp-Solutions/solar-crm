import { describe, expect, it } from 'vitest';
import { defaultBucket } from '../../src/services/documentService';
import { IDS } from '../helpers/env';
import { mkLead, platformEnv } from './fixtures';

const api = '/api/v1';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n');

type Env = ReturnType<typeof platformEnv>;
const upload = (env: Env, who: string, leadId: string, over: { filename?: string; type?: string; docType?: string } = {}) =>
  env.as(who).post(`${api}/documents`)
    .field('entity_type', 'lead').field('entity_id', leadId).field('doc_type', over.docType ?? 'electricity_bill')
    .attach('file', PDF, { filename: over.filename ?? 'bill.pdf', contentType: over.type ?? 'application/pdf' });

describe('documents — upload and listing', () => {
  it('stores the file under the org prefix, picks the bucket by entity type and never returns the path', async () => {
    const env = platformEnv();
    const lead = await mkLead(env);
    const r = await upload(env, 'admin', lead.id);
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ entity_type: 'lead', entity_id: lead.id, bucket: 'lead-docs', doc_type: 'electricity_bill', file_name: 'bill.pdf', mime: 'application/pdf', uploaded_by: IDS.profile('admin'), uploaded_by_name: 'Test admin' });
    expect(r.body.data.path).toBeUndefined();
    expect(r.body.data.exif).toEqual({ lat: null, lng: null, taken_at: null });
    const row = (await env.db.table('documents').get(r.body.data.id))!;
    expect(row.path.startsWith(`${IDS.org}/lead/${lead.id}/`)).toBe(true);
    expect(env.providers.files.has(`lead-docs/${row.path}`)).toBe(true);
    expect(await env.db.table('audit_log').count({ action: 'document.upload' })).toBe(1);

    const listed = await env.as('dsm').get(`${api}/documents?entity_type=lead&entity_id=${lead.id}`);
    expect(listed.body.total).toBe(1);
    expect(listed.body.data[0].path).toBeUndefined();
    expect((await env.as('dsm').get(`${api}/documents?entity_type=lead&entity_id=${lead.id}&doc_type=other`)).body.total).toBe(0);
    expect((await env.as('dsm').get(`${api}/documents?entity_type=lead`)).status).toBe(422);
  });

  it('chooses buckets by entity and document type', () => {
    expect(defaultBucket('lead', 'electricity_bill')).toBe('lead-docs');
    expect(defaultBucket('lead', 'site_photo')).toBe('site-photos');
    expect(defaultBucket('survey', 'other')).toBe('site-photos');
    expect(defaultBucket('quotation', 'pdf')).toBe('quote-pdfs');
    expect(defaultBucket('proforma_invoice', 'pdf')).toBe('invoices');
    expect(defaultBucket('sales_order', 'po')).toBe('invoices');
    expect(defaultBucket('sku', 'bis_certificate')).toBe('compliance-docs');
  });

  it('rejects Aadhaar-looking file names, wrong types, a missing file and unknown parents', async () => {
    const env = platformEnv();
    const lead = await mkLead(env);
    const aadhaar = await upload(env, 'admin', lead.id, { filename: 'aadhaar_card.pdf' });
    expect(aadhaar.status).toBe(422);
    expect(aadhaar.body.error.code).toBe('AADHAAR_BLOCKED');
    const txt = await upload(env, 'admin', lead.id, { filename: 'notes.txt', type: 'text/plain' });
    expect(txt.status).toBe(415);
    const none = await env.as('admin').post(`${api}/documents`).field('entity_type', 'lead').field('entity_id', lead.id);
    expect(none.status).toBe(400);
    expect((await upload(env, 'admin', IDS.org)).status).toBe(404);
    expect(await env.db.table('documents').count()).toBe(0);
  });

  it('read-only roles cannot upload', async () => {
    const env = platformEnv();
    const lead = await mkLead(env);
    expect((await upload(env, 'viewer', lead.id)).status).toBe(403);
  });
});

describe('documents — external users only reach their own party’s files', () => {
  it('an external user cannot upload to, list or fetch a document of another distributor', async () => {
    const env = platformEnv();
    const leadA = await mkLead(env, { name: 'For A', distributor_id: IDS.distributorA });
    const leadB = await mkLead(env, { name: 'For B', mobile: '+919000000011', distributor_id: IDS.distributorB });
    const docA = (await upload(env, 'distributor_user', leadA.id)).body.data;
    const docB = (await upload(env, 'admin', leadB.id)).body.data;
    expect(docA.id).toBeTruthy();

    // distributor A: own lead fine, B's lead refused everywhere
    expect((await upload(env, 'distributor_user', leadB.id)).status).toBe(403);
    expect((await env.as('distributor_user').get(`${api}/documents?entity_type=lead&entity_id=${leadB.id}`)).status).toBe(403);
    expect((await env.as('distributor_user').get(`${api}/documents/${docB.id}/url`)).status).toBe(403);
    expect((await env.as('distributor_user').delete(`${api}/documents/${docB.id}`)).status).toBe(403);
    expect((await env.as('distributor_user').get(`${api}/documents/${docA.id}/url`)).status).toBe(200);
    // distributor B cannot open A's document, but can open its own
    expect((await env.as(IDS.distributorUserB).get(`${api}/documents/${docA.id}/url`)).status).toBe(403);
    expect((await env.as(IDS.distributorUserB).get(`${api}/documents/${docB.id}/url`)).status).toBe(200);
    // a dealer of distributor B cannot see distributor A's files either
    expect((await env.as(IDS.dealerUserB).get(`${api}/documents/${docA.id}/url`)).status).toBe(403);
    // the object is still there for admin
    expect((await env.as('admin').get(`${api}/documents/${docA.id}/url`)).status).toBe(200);
    // entity types without a known parent are internal-only
    const odd = await env.as('distributor_user').get(`${api}/documents?entity_type=mystery&entity_id=${leadA.id}`);
    expect(odd.status).toBe(403);
    expect((await env.as('dsm').get(`${api}/documents?entity_type=mystery&entity_id=${leadA.id}`)).status).toBe(200);
  });

  it('territory-restricted internal users are scoped like the lead itself', async () => {
    const env = platformEnv();
    const lead = await mkLead(env);
    const doc = (await upload(env, 'admin', lead.id)).body.data;
    await env.db.table('profiles').update(IDS.profile('dsm'), { territory_ids: [IDS.territorySurat] });
    expect((await env.as('dsm').get(`${api}/documents/${doc.id}/url`)).status).toBe(403);
  });
});

describe('documents — signed URLs', () => {
  it('issues a 5-minute signed URL (rule-driven, clamped) and audits the access', async () => {
    const env = platformEnv();
    const lead = await mkLead(env);
    const doc = (await upload(env, 'admin', lead.id)).body.data;
    const r = await env.as('sales_manager').get(`${api}/documents/${doc.id}/url`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ expires_in_seconds: 300, file_name: 'bill.pdf', mime: 'application/pdf' });
    expect(r.body.data.url).toMatch(/^https:\/\/fake\.storage\/lead-docs\/.+\/lead\//);
    const ttl = new Date(r.body.data.expires_at).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(280_000);
    expect(ttl).toBeLessThanOrEqual(300_500);
    expect(await env.db.table('audit_log').count({ action: 'document.access', record_id: doc.id })).toBe(1);

    await env.rule('documents.signed_url_seconds', 120);
    expect((await env.as('admin').get(`${api}/documents/${doc.id}/url`)).body.data.expires_in_seconds).toBe(120);
    const row = await env.db.table('rule_config').one({ category: 'documents' });
    await env.db.table('rule_config').update(row!.id, { value: 5 });
    expect((await env.as('admin').get(`${api}/documents/${doc.id}/url`)).body.data.expires_in_seconds).toBe(30); // never shorter than 30 s
    await env.db.table('rule_config').update(row!.id, { value: 86400 });
    expect((await env.as('admin').get(`${api}/documents/${doc.id}/url`)).body.data.expires_in_seconds).toBe(900); // never longer than 15 min
    expect((await env.as('admin').get(`${api}/documents/${IDS.org}/url`)).status).toBe(404);
  });

  it('enforces the org prefix on every path', async () => {
    const env = platformEnv();
    const lead = await mkLead(env);
    const make = (path: string) => env.ctx('admin').db.table('documents').insert({ entity_type: 'lead', entity_id: lead.id, bucket: 'lead-docs', path, doc_type: 'other', file_name: 'x.pdf', mime: 'application/pdf', size_bytes: 1, uploaded_by: null });
    const foreign = await make('11111111-1111-4111-8111-111111111111/lead/x/x.pdf');
    const traversal = await make(`${IDS.org}/../other/x.pdf`);
    const good = await make(`${IDS.org}/lead/${lead.id}/x.pdf`);
    expect((await env.as('admin').get(`${api}/documents/${foreign.id}/url`)).status).toBe(403);
    expect((await env.as('admin').get(`${api}/documents/${traversal.id}/url`)).status).toBe(403);
    expect((await env.as('admin').delete(`${api}/documents/${foreign.id}`)).status).toBe(403);
    expect((await env.as('admin').get(`${api}/documents/${good.id}/url`)).status).toBe(200);
  });
});

describe('documents — direct upload URL and deletion', () => {
  it('pre-creates the row and returns a signed PUT URL under the org prefix', async () => {
    const env = platformEnv();
    const lead = await mkLead(env);
    const r = await env.as('dsm').post(`${api}/documents/upload-url`).send({ entity_type: 'lead', entity_id: lead.id, file_name: 'Site photo 1.jpg', content_type: 'image/jpeg', doc_type: 'site_photo', size_bytes: 2048 });
    expect(r.status).toBe(201);
    expect(r.body.data.upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/jpeg' } });
    expect(r.body.data.upload.url).toContain(`https://fake.storage/site-photos/${IDS.org}/lead/${lead.id}/`);
    expect(r.body.data.max_bytes).toBe(10 * 1024 * 1024);
    expect(r.body.data.document).toMatchObject({ bucket: 'site-photos', file_name: 'Site photo 1.jpg', uploaded_by: IDS.profile('dsm') });
    const row = (await env.db.table('documents').get(r.body.data.document.id))!;
    expect(row.path.startsWith(`${IDS.org}/lead/${lead.id}/`)).toBe(true);
    expect(row.path).toMatch(/Site_photo_1\.jpg$/);

    const bad = (body: Record<string, unknown>) => env.as('dsm').post(`${api}/documents/upload-url`).send({ entity_type: 'lead', entity_id: lead.id, file_name: 'a.pdf', content_type: 'application/pdf', ...body });
    expect((await bad({ content_type: 'text/html' })).status).toBe(422);
    expect((await bad({ file_name: 'aadhaar-front.jpg', content_type: 'image/jpeg' })).body.error.code).toBe('AADHAAR_BLOCKED');
    expect((await bad({ size_bytes: 50 * 1024 * 1024 })).status).toBe(413);
    expect((await env.as('distributor_user').post(`${api}/documents/upload-url`).send({ entity_type: 'lead', entity_id: (await mkLead(env, { mobile: '+919000000022', distributor_id: IDS.distributorB })).id, file_name: 'a.pdf', content_type: 'application/pdf' })).status).toBe(403);
    expect(await env.db.table('documents').count()).toBe(1);
  });

  it('delete removes the stored file; only the uploader, managers or compliance may delete', async () => {
    const env = platformEnv();
    const lead = await mkLead(env, { dealer_id: IDS.dealerA1 });
    const mine = (await upload(env, 'dealer_user', lead.id)).body.data;
    const path = (await env.db.table('documents').get(mine.id))!.path;
    expect(env.providers.files.has(`lead-docs/${path}`)).toBe(true);
    // another user of the same distributor who is neither uploader nor manager
    const other = (await upload(env, 'distributor_user', lead.id)).body.data;
    expect((await env.as('dealer_user').delete(`${api}/documents/${other.id}`)).status).toBe(403);
    expect((await env.as('dealer_user').delete(`${api}/documents/${mine.id}`)).status).toBe(200);
    expect(env.providers.files.has(`lead-docs/${path}`)).toBe(false);
    expect(await env.db.table('documents').get(mine.id)).toBeNull();
    expect((await env.as('sales_manager').delete(`${api}/documents/${other.id}`)).status).toBe(200);
    expect((await env.as('admin').delete(`${api}/documents/${other.id}`)).status).toBe(404);
    expect(await env.db.table('audit_log').count({ action: 'document.delete' })).toBe(2);
  });
});
