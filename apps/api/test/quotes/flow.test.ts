/** Quote → three-lane approval → send integration, versioning, PDF, consent-less send, follow-up cadence. */
import { describe, expect, it } from 'vitest';
import { IDS, addSku, allowed, denied, makeWorld, quoteWith, type World } from './helpers';

const binary = (res: import('superagent').Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function overLimit(w: World) {
  await w.c().db.table('dealer_receivables').insert({ dealer_id: IDS.dealerA1, distributor_id: IDS.distributorA, doc_ref: 'INV-77', amount: 1_500_000, paid_amount: 0, invoice_date: '2026-09-01', due_date: '2026-10-01', subsidy_linked: false, status: 'open' });
}
const api = (w: World, role: string) => w.env.as(role);

describe('quote → three-lane approval → send', () => {
  it('is blocked while a non-DCR module is on a PMSG quote, passes after the swap, runs the three lanes in parallel and sends', async () => {
    const w = await makeWorld({ exemption: true });
    await overLimit(w);
    const good = await addSku(w);
    const bad = await addSku(w, { compliance: { dcr_verified: false } });

    // create + a non-DCR module → blocked
    const created = await api(w, 'techno_commercial').post('/api/v1/quotes').send({ opportunity_id: w.ids.opp });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    let put = await api(w, 'techno_commercial').put(`/api/v1/quotes/${id}/lines`).send({ lines: [{ sku_id: bad.id, qty: 10, discount_pct: 10 }] });
    expect(put.status).toBe(200);
    expect(put.body.data.status).toBe('blocked');
    expect(put.body.data.compliance_status).toBe('blocked');
    expect(put.body.data.findings.find((f: { gate: string; severity: string }) => f.gate === 'G2' && f.severity === 'hard_stop')).toBeTruthy();
    const refused = await api(w, 'techno_commercial').post(`/api/v1/quotes/${id}/request-approval`).send({});
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('COMPLIANCE_BLOCKED');
    expect((await api(w, 'techno_commercial').post(`/api/v1/quotes/${id}/send`).send({})).status).toBe(409);

    // swap to a DCR-verified module → clears
    put = await api(w, 'techno_commercial').put(`/api/v1/quotes/${id}/lines`).send({ lines: [{ sku_id: good.id, qty: 10, discount_pct: 10 }] });
    expect(put.body.data.status).toBe('draft');
    expect(put.body.data.findings.some((f: { severity: string; overridden?: boolean }) => f.severity === 'hard_stop' && !f.overridden)).toBe(false);

    // price review → approvals open in three parallel lanes
    const req = await api(w, 'techno_commercial').post(`/api/v1/quotes/${id}/request-approval`).send({});
    expect(req.status).toBe(200);
    expect(req.body.data.status).toBe('pending_approval');
    const approvals = req.body.data.approvals as { id: string; lane: string; step: number; required_role: string; decision: string; due_at: string | null; actionable: boolean }[];
    const lane = (l: string) => approvals.filter((a) => a.lane === l).sort((a, b) => a.step - b.step);
    expect(lane('commercial').map((a) => a.required_role)).toEqual(['dsm', 'regional_head', 'management']);
    expect(lane('compliance').map((a) => a.required_role)).toEqual(['compliance_officer']);
    expect(lane('credit').map((a) => a.required_role)).toEqual(['accounts']);
    expect(lane('commercial').map((a) => a.actionable)).toEqual([true, false, false]);
    expect(lane('commercial')[0]!.due_at).toBeTruthy();
    expect(lane('commercial')[1]!.due_at).toBeNull();
    const clocks = await w.c().db.table('clocks').all({ clock_type: 'approval', status: 'running' });
    expect(clocks).toHaveLength(3); // one SLA clock per lane's active step

    // out of turn is refused; the inbox shows each person their own work
    const early = await api(w, 'regional_head').post(`/api/v1/approvals/${lane('commercial')[1]!.id}/decide`).send({ decision: 'approved' });
    expect(early.status).toBe(409);
    expect((await api(w, 'dsm').get('/api/v1/approvals/summary')).body.data).toEqual({ mine: 1 });
    expect((await api(w, 'accounts').get('/api/v1/approvals/summary')).body.data).toEqual({ mine: 1 });
    expect((await api(w, 'regional_head').get('/api/v1/approvals/summary')).body.data).toEqual({ mine: 1 }); // a higher authority may decide the DSM step
    const inbox = await api(w, 'compliance_officer').get('/api/v1/approvals?actionable=true');
    expect(inbox.body.total).toBe(1);
    expect(inbox.body.data[0]).toMatchObject({ lane: 'compliance', entity: { title: expect.stringContaining('FS/Q/26/0001') }, sla: { state: 'running' } });

    const decide = (role: string, a: { id: string }, extra: object = {}) => api(w, role).post(`/api/v1/approvals/${a.id}/decide`).send({ decision: 'approved', ...extra });
    const s1 = await decide('dsm', lane('commercial')[0]!, { comment: 'Within range' });
    expect(s1.body.data.outcome).toBe('step_approved');
    // step 2 is now active: its SLA clock started and the regional head sees it
    expect((await api(w, 'regional_head').get('/api/v1/approvals/summary')).body.data.mine).toBe(1);
    expect((await w.c().db.table('approvals').getOrThrow(lane('commercial')[1]!.id)).due_at).toBeTruthy();
    expect(await w.c().db.table('clocks').count({ clock_type: 'approval', status: 'running' })).toBe(3);

    await decide('regional_head', lane('commercial')[1]!);
    expect((await decide('management', lane('commercial')[2]!)).body.data.outcome).toBe('lane_approved');
    await decide('compliance_officer', lane('compliance')[0]!, { comment: 'Exemption reliance reviewed' });
    expect((await w.c().db.table('quotations').getOrThrow(id)).status).toBe('pending_approval'); // credit lane still open
    await decide('accounts', lane('credit')[0]!);
    expect((await w.c().db.table('quotations').getOrThrow(id)).status).toBe('approved');
    expect(await w.c().db.table('clocks').count({ clock_type: 'approval', status: 'running' })).toBe(0);

    // consent-less send is refused and leaves the quote approved
    w.stubs.consent = () => denied('NO_CONSENT', 'No consent record covers service messages.');
    const noConsent = await api(w, 'techno_commercial').post(`/api/v1/quotes/${id}/send`).send({});
    expect(noConsent.status).toBe(422);
    expect(noConsent.body.error.code).toBe('CONSENT_BLOCKED');
    expect(w.stubs.sent).toHaveLength(0);
    expect((await w.c().db.table('quotations').getOrThrow(id)).status).toBe('approved');

    // with consent: branded PDF, e-mail + WhatsApp, status sent, follow-up cadence
    w.stubs.consent = () => allowed();
    const sent = await api(w, 'techno_commercial').post(`/api/v1/quotes/${id}/send`).send({});
    expect(sent.status).toBe(200);
    expect(sent.body.data.quote.status).toBe('sent');
    expect(sent.body.data.deliveries.map((d: { channel: string }) => d.channel).sort()).toEqual(['email', 'whatsapp']);
    expect(w.stubs.sent.find((s) => s.channel === 'email')).toMatchObject({ attachments: 1, lead_id: w.ids.lead });
    expect(w.stubs.sent.find((s) => s.channel === 'whatsapp')!.attachments).toBe(0);
    // WhatsApp can only carry an approved template (seeded as wa.quote_sent); e-mail carries the composed body + PDF and needs no template
    expect(w.stubs.sent.find((s) => s.channel === 'whatsapp')!.template_key).toBe('wa.quote_sent');
    expect(w.stubs.sent.find((s) => s.channel === 'email')!.template_key).toBeUndefined();
    const doc = (await w.c().db.table('documents').all({ entity_type: 'quotation', entity_id: id }))[0]!;
    expect(doc).toMatchObject({ bucket: 'quote-pdfs', mime: 'application/pdf', doc_type: 'quotation_pdf' });
    expect(doc.path.startsWith(`${IDS.org}/`)).toBe(true);
    const stored = w.env.providers.files.get(`quote-pdfs/${doc.path}`)!;
    expect(stored.subarray(0, 5).toString()).toBe('%PDF-');
    expect(stored.length).toBeGreaterThan(2000);
    const followups = await w.c().db.table('clocks').all({ clock_type: 'quote_followup', entity_id: id }, { orderBy: { col: 'due_at' } });
    expect(followups.map((c) => (c.meta as { day: number }).day)).toEqual([1, 3, 5, 7]);
    expect(followups.every((c) => c.status === 'running' && c.owner_id === IDS.profile('dsm'))).toBe(true);
    expect((await api(w, 'techno_commercial').post(`/api/v1/quotes/${id}/send`).send({})).status).toBe(409); // already sent

    // the stored PDF streams back
    const pdf = await api(w, 'dsm').get(`/api/v1/quotes/${id}/pdf`).buffer(true).parse(binary);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    // negotiation, then acceptance (step 27)
    const disc = await api(w, 'dsm').post(`/api/v1/quotes/${id}/discussions`).send({ kind: 'call', outcome: 'Asked for a lower freight', notes: 'Will confirm by Friday' });
    expect(disc.status).toBe(201);
    expect((await w.c().db.table('quotations').getOrThrow(id)).status).toBe('negotiation');
    expect((await w.c().db.table('opportunities').getOrThrow(w.ids.opp)).stage).toBe('negotiation');
    expect((await w.c().db.table('clocks').all({ clock_type: 'quote_followup', entity_id: id, status: 'met' }))).toHaveLength(1);
    const acc = await api(w, 'dsm').post(`/api/v1/quotes/${id}/accept`).send({});
    expect(acc.body.data).toMatchObject({ status: 'accepted' });
    expect(acc.body.data.terms_confirmed_at).toBeTruthy();
    expect((await w.c().db.table('opportunities').getOrThrow(w.ids.opp)).stage).toBe('pi_stage');
    expect(await w.c().db.table('clocks').count({ clock_type: 'quote_followup', entity_id: id, status: 'running' })).toBe(0);
  });

  it('a rejection in any lane rejects the quote; the reason is mandatory', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w)], { qty: 10, discount_pct: 10 });
    const req = await api(w, 'dsm').post(`/api/v1/quotes/${q.id}/request-approval`).send({});
    const first = (req.body.data.approvals as { id: string; lane: string; step: number }[]).find((a) => a.lane === 'commercial' && a.step === 1)!;
    expect((await api(w, 'dsm').post(`/api/v1/approvals/${first.id}/decide`).send({ decision: 'rejected' })).status).toBe(422);
    const rej = await api(w, 'dsm').post(`/api/v1/approvals/${first.id}/decide`).send({ decision: 'rejected', comment: 'Discount too deep for this territory' });
    expect(rej.body.data.outcome).toBe('rejected');
    const row = await w.c().db.table('quotations').getOrThrow(q.id);
    expect(row.status).toBe('rejected');
    expect(row.rejected_reason).toMatch(/too deep/);
    const left = await w.c().db.table('approvals').all({ entity_type: 'quotation', entity_id: q.id, decision: 'pending' });
    expect(left).toHaveLength(0);
    expect((await api(w, 'dsm').post(`/api/v1/approvals/${first.id}/decide`).send({ decision: 'approved' })).status).toBe(409);
  });

  it('needs no approval lane when there is no discount, no exemption and no credit issue', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w)]);
    const res = await api(w, 'dsm').post(`/api/v1/quotes/${q.id}/request-approval`).send({});
    expect(res.body.data.status).toBe('approved');
    expect(res.body.data.approvals).toHaveLength(0);
  });

  it('refuses to send a quote whose compliance changed to a hard stop after approval', async () => {
    const w = await makeWorld();
    const sku = await addSku(w);
    const q = await quoteWith(w, [sku]);
    await api(w, 'dsm').post(`/api/v1/quotes/${q.id}/request-approval`).send({});
    await w.c().db.table('sku_compliance').update((await w.c().db.table('sku_compliance').one({ sku_id: sku.id }))!.id, { dcr_verified: false });
    const res = await api(w, 'dsm').post(`/api/v1/quotes/${q.id}/send`).send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('COMPLIANCE_BLOCKED');
  });

  it('refuses to send when the lead cannot be reached on any channel, and sends WhatsApp-only when e-mail has no consent', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w)]);
    await api(w, 'dsm').post(`/api/v1/quotes/${q.id}/request-approval`).send({});
    w.stubs.consent = (ch) => (ch === 'email' ? denied('NO_CONSENT', 'No e-mail consent') : allowed());
    const res = await api(w, 'dsm').post(`/api/v1/quotes/${q.id}/send`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.deliveries.find((d: { channel: string }) => d.channel === 'email').blocked).toBe(true);
    expect(w.stubs.sent.map((s) => s.channel)).toEqual(['whatsapp']);
  });

  it('refuses to send an expired quote', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w)]);
    await api(w, 'dsm').post(`/api/v1/quotes/${q.id}/request-approval`).send({});
    w.env.setNow(new Date('2026-11-20T05:00:00Z'));
    expect((await api(w, 'dsm').post(`/api/v1/quotes/${q.id}/send`).send({})).status).toBe(409);
  });
});

describe('versions: reject → revise', () => {
  it('creates version n+1 with the parent link and a copy of the lines; the old version becomes revised', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w), await addSku(w)], { qty: 5 });
    await api(w, 'dsm').post(`/api/v1/quotes/${q.id}/request-approval`).send({});
    await api(w, 'dsm').post(`/api/v1/quotes/${q.id}/send`).send({});
    expect((await api(w, 'dsm').post(`/api/v1/quotes/${q.id}/revise`).send({})).status).toBe(201); // a sent quote can be revised too

    const w2 = await makeWorld();
    const q2 = await quoteWith(w2, [await addSku(w2), await addSku(w2)], { qty: 5 });
    await api(w2, 'dsm').post(`/api/v1/quotes/${q2.id}/request-approval`).send({});
    await api(w2, 'dsm').post(`/api/v1/quotes/${q2.id}/send`).send({});
    expect((await api(w2, 'dsm').post(`/api/v1/quotes/${q2.id}/reject`).send({ reason: '' })).status).toBe(422);
    const rej = await api(w2, 'dsm').post(`/api/v1/quotes/${q2.id}/reject`).send({ reason: 'Customer found a cheaper offer' });
    expect(rej.body.data).toMatchObject({ status: 'rejected', rejected_reason: 'Customer found a cheaper offer' });
    expect(await w2.c().db.table('clocks').count({ clock_type: 'quote_followup', entity_id: q2.id, status: 'running' })).toBe(0);

    const rev = await api(w2, 'dsm').post(`/api/v1/quotes/${q2.id}/revise`).send({});
    expect(rev.status).toBe(201);
    const v2 = rev.body.data;
    expect(v2).toMatchObject({ version: 2, parent_quote_id: q2.id, quote_no: q2.quote_no, status: 'draft' });
    expect(v2.lines).toHaveLength(2);
    expect(v2.lines.map((l: { qty: number }) => l.qty)).toEqual([5, 5]);
    expect(v2.versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
    expect(v2.total).toBe(q2.total);
    expect((await w2.c().db.table('quotations').getOrThrow(q2.id)).status).toBe('revised');
    // the old version cannot be revised again, nor edited
    expect((await api(w2, 'dsm').post(`/api/v1/quotes/${q2.id}/revise`).send({})).status).toBe(409);
    expect((await api(w2, 'dsm').put(`/api/v1/quotes/${q2.id}/lines`).send({ lines: [] })).status).toBe(409);
    // the new version goes through the same flow
    expect((await api(w2, 'dsm').post(`/api/v1/quotes/${v2.id}/request-approval`).send({})).body.data.status).toBe('approved');
    expect((await api(w2, 'dsm').get('/api/v1/quotes?latest_only=true')).body.data.map((r: { id: string }) => r.id)).toEqual([v2.id]);
  });

  it('a substituted SKU compared with the previous version opens the compliance lane', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w)]);
    await api(w, 'dsm').post(`/api/v1/quotes/${q.id}/request-approval`).send({});
    await api(w, 'dsm').post(`/api/v1/quotes/${q.id}/send`).send({});
    await api(w, 'dsm').post(`/api/v1/quotes/${q.id}/reject`).send({ reason: 'Wants another brand' });
    const v2 = (await api(w, 'dsm').post(`/api/v1/quotes/${q.id}/revise`).send({})).body.data;
    await api(w, 'dsm').put(`/api/v1/quotes/${v2.id}/lines`).send({ lines: [{ sku_id: (await addSku(w, { make: 'Adani' })).id, qty: 1 }] });
    const req = await api(w, 'dsm').post(`/api/v1/quotes/${v2.id}/request-approval`).send({});
    expect(req.body.data.approvals.map((a: { lane: string }) => a.lane)).toEqual(['compliance']);
    expect(req.body.data.approvals[0].meta.reasons[0]).toMatch(/substituted/);
  });
});

describe('access', () => {
  it('a dealer sees only their own quotes and no margin or floor data; other dealers get 403', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w)], { qty: 10 });
    const mine = await w.env.as('dealer_user').get(`/api/v1/quotes/${q.id}`);
    expect(mine.status).toBe(200);
    expect(mine.body.data.margin_pct).toBeNull();
    expect(mine.body.data.floor_check).toBeNull();
    const theirs = await w.env.as(IDS.dealerUserB).get(`/api/v1/quotes/${q.id}`);
    expect(theirs.status).toBe(403);
    expect((await w.env.as(IDS.dealerUserB).get('/api/v1/quotes')).body.total).toBe(0);
    expect((await w.env.as('dealer_user').get('/api/v1/approvals')).status).toBe(403);
    expect((await w.env.as('dealer_user').get('/api/v1/approvals/summary')).body.data).toEqual({ mine: 0 });
    expect((await w.env.as('viewer').get('/api/v1/approvals/summary')).body.data).toEqual({ mine: 0 });
  });
});

describe('calling a deal off at any live stage', () => {
  it('a draft or an approved-but-unsent quotation can be cancelled, then revised to start again; a closed one cannot be cancelled twice', async () => {
    const w = await makeWorld();
    const draft = await quoteWith(w, [await addSku(w)], { qty: 2 });
    const res = await api(w, 'dsm').post(`/api/v1/quotes/${draft.id}/reject`).send({ reason: 'Customer cancelled on a call' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'rejected', rejected_reason: 'Customer cancelled on a call' });
    expect((await api(w, 'dsm').post(`/api/v1/quotes/${draft.id}/reject`).send({ reason: 'again' })).status).toBe(409);
    const again = await api(w, 'dsm').post(`/api/v1/quotes/${draft.id}/revise`).send({});
    expect(again.status).toBe(201);
    expect(again.body.data).toMatchObject({ version: 2, status: 'draft' });

    const waiting = await quoteWith(w, [await addSku(w)], { qty: 5 });
    await api(w, 'dsm').post(`/api/v1/quotes/${waiting.id}/request-approval`).send({});
    const cancelled = await api(w, 'dsm').post(`/api/v1/quotes/${waiting.id}/reject`).send({ reason: 'Customer postponed the purchase' });
    expect(cancelled.body.data.status).toBe('rejected');
    expect((cancelled.body.data.approvals as { decision: string }[]).every((a) => a.decision !== 'pending')).toBe(true);
  });
});
