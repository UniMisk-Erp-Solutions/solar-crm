/** Compliance overrides (written reason, compliance-lane approval, audit) and the gate × segment applicability matrix. */
import { describe, expect, it } from 'vitest';
import { IDS, addSku, evaluate, gate, makeWorld, quoteWith, real } from '../quotes/helpers';

describe('compliance overrides', () => {
  it('needs a written reason, a compliance officer, and then stops blocking — everything audited', async () => {
    const w = await makeWorld();
    const bad = await addSku(w, { compliance: { dcr_verified: false } });
    const q = await quoteWith(w, [bad]);
    expect((await w.c().db.table('quotations').getOrThrow(q.id)).status).toBe('blocked');

    const dsm = w.env.as('dsm');
    // reason is mandatory
    expect((await dsm.post('/api/v1/compliance/overrides').send({ entity_type: 'quotation', entity_id: q.id, gates: ['G2'], reason: 'ok' })).status).toBe(422);
    // a gate with nothing to override is refused
    const none = await dsm.post('/api/v1/compliance/overrides').send({ entity_type: 'quotation', entity_id: q.id, gates: ['G5'], reason: 'Customer insists on this module' });
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('GUARD_BLOCKED');

    const req = await dsm.post('/api/v1/compliance/overrides').send({ entity_type: 'quotation', entity_id: q.id, gates: ['G2'], reason: 'Customer signed a DCR waiver for this module' });
    expect(req.status).toBe(201);
    const approval = req.body.data.approval;
    expect(approval).toMatchObject({ entity_type: 'compliance_override', lane: 'compliance', required_role: 'compliance_officer', decision: 'pending' });
    expect(approval.meta).toMatchObject({ kind: 'override', target: 'quotation', gates: ['G2'] });
    // still blocked while pending; a second request is refused
    expect((await evaluate(w, q.id)).hasHardStop).toBe(true);
    expect((await dsm.post('/api/v1/compliance/overrides').send({ entity_type: 'quotation', entity_id: q.id, gates: ['G2'], reason: 'Second attempt at the same thing' })).status).toBe(409);

    // only the compliance officer can decide, and must write a comment
    expect((await dsm.post(`/api/v1/approvals/${approval.id}/decide`).send({ decision: 'approved', comment: 'fine by me' })).status).toBe(403);
    const co = w.env.as('compliance_officer');
    const noComment = await co.post(`/api/v1/approvals/${approval.id}/decide`).send({ decision: 'approved' });
    expect(noComment.status).toBe(422);
    const ok = await co.post(`/api/v1/approvals/${approval.id}/decide`).send({ decision: 'approved', comment: 'Waiver on file, reviewed' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.outcome).toBe('lane_approved');

    const r = await evaluate(w, q.id);
    expect(gate(r, 'G2')[0]).toMatchObject({ severity: 'hard_stop', overridden: true });
    expect(r.hasHardStop).toBe(false);
    expect(r.status).toBe('warnings');
    expect((await w.c().db.table('quotations').getOrThrow(q.id)).status).toBe('draft');

    const audits = (await w.c().db.table('audit_log').all({ source: 'api' })).map((a) => a.action);
    expect(audits).toEqual(expect.arrayContaining(['compliance.override_requested', 'approval.approved', 'compliance.override_approved']));
  });

  it('a rejected override leaves the quote blocked', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w, { compliance: { almm_list1: false } })]);
    const req = await w.env.as('dsm').post('/api/v1/compliance/overrides').send({ entity_type: 'quotation', entity_id: q.id, gates: ['G3'], reason: 'Model is awaiting ALMM listing' });
    const dec = await w.env.as('compliance_officer').post(`/api/v1/approvals/${req.body.data.approval.id}/decide`).send({ decision: 'rejected', comment: 'Not listed yet' });
    expect(dec.body.data.outcome).toBe('rejected');
    expect((await evaluate(w, q.id)).hasHardStop).toBe(true);
  });

  it('stops applying when the SKUs on the quote change', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w, { compliance: { dcr_verified: false } })]);
    const req = await w.env.as('dsm').post('/api/v1/compliance/overrides').send({ entity_type: 'quotation', entity_id: q.id, gates: ['G2'], reason: 'Waiver on file for module A' });
    await w.env.as('compliance_officer').post(`/api/v1/approvals/${req.body.data.approval.id}/decide`).send({ decision: 'approved', comment: 'Waiver reviewed' });
    expect((await evaluate(w, q.id)).hasHardStop).toBe(false);

    const other = await addSku(w, { compliance: { dcr_verified: false } });
    const res = await w.env.as('dsm').put(`/api/v1/quotes/${q.id}/lines`).send({ lines: [{ sku_id: other.id, qty: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('blocked');
    expect((await evaluate(w, q.id)).hasHardStop).toBe(true);
  });
});

describe('segment applicability matrix', () => {
  it('skips a gate that does not apply with an info finding that says why', async () => {
    const w = await makeWorld({ segment: 'ci_captive', kw: 200 });
    const r = await evaluate(w, (await quoteWith(w, [await addSku(w, { compliance: { dcr_verified: false, almm_list2: false } })])).id);
    expect(gate(r, 'G2')[0]).toMatchObject({ severity: 'info' });
    expect(gate(r, 'G2')[0]!.message).toMatch(/does not apply to C&I — captive/);
    expect(real(r, 'G5')).toHaveLength(0);
  });

  it('captive jobs evaluate G3 / G4 but only as warnings', async () => {
    const w = await makeWorld({ segment: 'ci_captive', kw: 200 });
    const r = await evaluate(w, (await quoteWith(w, [await addSku(w, { compliance: { almm_list1: false, almm_list2: false } })])).id);
    expect(real(r, 'G3')[0]!.severity).toBe('warning');
    expect(real(r, 'G4')[0]!.severity).toBe('warning');
    expect(r.hasHardStop).toBe(false);
  });

  it('the gate_applicability table overrides the built-in matrix', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w, { compliance: { bis_licence_no: null } })]);
    expect(real(await evaluate(w, q.id), 'G6')[0]!.severity).toBe('hard_stop');
    await w.c().db.table('gate_applicability').insert({ gate: 'G6', segment: 'pmsg_residential', applicability: 'warning', note: 'test' });
    expect(real(await evaluate(w, q.id), 'G6')[0]!.severity).toBe('warning');
    const row = (await w.c().db.table('gate_applicability').all())[0]!;
    await w.c().db.table('gate_applicability').update(row.id, { applicability: 'not_applies' });
    const r = await evaluate(w, q.id);
    expect(real(r, 'G6')).toHaveLength(0);
    expect(gate(r, 'G6')[0]!.severity).toBe('info');
  });

  it('exposes the effective matrix', async () => {
    const w = await makeWorld();
    const res = await w.env.as('viewer').get('/api/v1/compliance/gates');
    expect(res.status).toBe(200);
    expect(res.body.data.gates).toHaveLength(14);
    expect(res.body.data.gates.find((g: { gate: string }) => g.gate === 'G3').applicability.ci_captive.applicability).toBe('warning');
  });
});

describe('live preview without a quote', () => {
  it('returns gate results, a per-gate summary and the CFA', async () => {
    const w = await makeWorld();
    const good = await addSku(w);
    const bad = await addSku(w, { compliance: { dcr_verified: false } });
    const res = await w.env.as('techno_commercial').post('/api/v1/compliance/preview').send({ segment: 'pmsg_residential', kw: 3, expected_commissioning_date: '2026-12-01', sku_ids: [good.id, bad.id], dealer_id: IDS.dealerA1 });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.hasHardStop).toBe(true);
    expect(d.gates.find((g: { gate: string }) => g.gate === 'G2')).toMatchObject({ status: 'fail', applicability: 'applies' });
    expect(d.gates.find((g: { gate: string }) => g.gate === 'G3').status).toBe('pass');
    expect(d.cfa.cfa).toBe(78000);
    const clean = await w.env.as('dsm').post('/api/v1/compliance/preview').send({ segment: 'pmsg_residential', kw: 3, sku_ids: [good.id] });
    expect(clean.body.data.hasHardStop).toBe(false);
    expect((await w.env.as('dsm').post('/api/v1/compliance/preview').send({ segment: 'nope', kw: 3 })).status).toBe(422);
  });
});
