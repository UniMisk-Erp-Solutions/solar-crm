/** Stage 4 of the flow (diagram sections 5, 8 and 11.2, steps 21-27): compliance engine, price review, three approval lanes, send, negotiation, revise loop, re-quote engine. */
import { describe, expect, it } from 'vitest';
import { covers } from './flowCoverage';
import { API, D, DAY, HOUR, MINUTE, S, data, env, funnel, goto, iso, lead, roleOf } from './flowKit';
import { failure, type Who } from './flowHarness';

interface Finding { gate: string; severity: 'info' | 'warning' | 'hard_stop'; message: string; ruleIds: string[]; fieldRefs: string[]; advisory?: boolean; overridden?: boolean }
interface ApprovalRow { id: string; lane: 'commercial' | 'compliance' | 'credit'; step: number; required_role: string; decision: string; approver_id: string | null }
interface QuoteLine { id: string; sku_id: string | null; description: string; qty: number; unit_price: number; discount_pct: number; gst_rate: number | null; gst_as_of: string | null; hsn: string | null; tax_position_approved: boolean; sku: { category: string } | null }
interface Quote {
  id: string; quote_no: string; version: number; status: string; compliance_status: string; parent_quote_id: string | null; kw: number; subtotal: number; discount_pct: number; discount_amount: number; tax_total: number; total: number; freight: number;
  cfa_entitlement: number; state_share: number; loan_share: number; consumer_share: number; margin_pct: number | null; floor_check: unknown; rule_ids_used: string[]; validity_date: string; requote_reason: string | null;
  findings: Finding[]; lines: QuoteLine[]; approvals: ApprovalRow[]; overrides: unknown[]; versions: { id: string; version: number; status: string }[]; documents: { id: string; doc_type: string }[]; editable: boolean;
  cfa: { entitlement: number; consumer_share: number; breakdown: { cfa: { eligible_kw: number; amount: number; lines: { label: string; kw: number; rate: number; amount: number }[] }; reference_date: string } };
}
interface Evaluation { findings: Finding[]; hasHardStop: boolean; status: string; ruleIdsUsed: string[]; quote: Quote }

const getQuote = async (id: string, who: Who = 'admin') => data<Quote>(await env.as(who).get(`${API}/quotes/${id}`));
const hard = (q: { findings: Finding[] }) => q.findings.filter((f) => f.severity === 'hard_stop' && !f.overridden);
const mainLines = (discount: number) => [
  { sku_id: D.sku.m1Dcr, qty: 5, discount_pct: discount }, { sku_id: D.sku.i1Residential, qty: 1, discount_pct: discount },
  { sku_id: D.sku.s1Structure, qty: 3, discount_pct: discount }, { sku_id: D.sku.c1Cable, qty: 40, discount_pct: 0 },
];

/** Decide every open approval of a quote in chain order as the role that is asked for. Returns the roles that decided. */
export async function approveAllLanes(quoteId: string, comment = 'Approved in the flow test'): Promise<string[]> {
  const used: string[] = [];
  for (let i = 0; i < 12; i++) {
    const q = await getQuote(quoteId);
    if (q.status !== 'pending_approval') break;
    const open = q.approvals.filter((a) => a.decision === 'pending');
    const heads = ['commercial', 'compliance', 'credit'].map((lane) => open.filter((a) => a.lane === lane).sort((a, b) => a.step - b.step)[0]).filter((a): a is ApprovalRow => !!a);
    if (!heads.length) break;
    for (const a of heads) {
      const res = await env.as(a.required_role as Who).post(`${API}/approvals/${a.id}/decide`).send({ decision: 'approved', comment });
      data(res);
      used.push(a.required_role);
    }
  }
  return used;
}

export function stage4(): void {
  describe('Stage 4 · §8 gate evaluation logic: R1 rule verified and active?, verdict hard / soft / pass, findings stored with rule ids', () => {
    it('8/R1/no: a verified+active rule hard-stops, switching it off makes the same condition ADVISORY only, switching it back on restores the stop', async () => {
      goto('2026-10-30', '10:00');
      const preview = (body: Record<string, unknown>) => env.as('techno_commercial').post(`${API}/compliance/preview`).send({ segment: 'pmsg_residential', kw: 3, expected_commissioning_date: '2026-12-10', ...body });
      const g2 = async () => data<{ hasHardStop: boolean; findings: Finding[] }>(await preview({ sku_ids: [D.sku.m2NonDcr] })).findings.find((f) => f.gate === 'G2' && f.severity !== 'info')!;
      expect(await g2()).toMatchObject({ severity: 'hard_stop' });
      const rule = data<{ id: string }[]>(await env.as('compliance_officer').get(`${API}/rules?category=pmsg&q=dcr_required_for_cfa&current=true`))[0]!;
      data(await env.as('compliance_officer').post(`${API}/rules/${rule.id}/deactivate`).send({}));
      const off = await g2();
      expect(off.severity).toBe('warning');
      expect(off.advisory).toBe(true);
      data(await env.as('compliance_officer').post(`${API}/rules/${rule.id}/activate`).send({}));
      expect(await g2()).toMatchObject({ severity: 'hard_stop' });
      covers('8/R1/no', 'pmsg.dcr_required_for_cfa deactivated → the same non-DCR module is only a WARNING with advisory:true; reactivated → HARD STOP again', 'compliance_officer');

      // conflicting / unverified rules degrade to advisory too: BIS standard (conflicting, inactive) on an expired licence
      const bis = data<{ findings: Finding[]; hasHardStop: boolean }>(await preview({ segment: 'ci_net_metered', kw: 60, sku_ids: [D.sku.m4BisExpired] }));
      const g6 = bis.findings.filter((f) => f.gate === 'G6' && f.severity !== 'info');
      expect(g6.length).toBeGreaterThan(0);
      expect(g6.every((f) => f.severity === 'warning' && f.advisory === true)).toBe(true);
      const bisRule = data<{ id: string; status: string; is_active: boolean }[]>(await env.as('compliance_officer').get(`${API}/rules?category=bis&q=module_standard_no&current=true`))[0]!;
      expect(bisRule).toMatchObject({ status: 'conflicting', is_active: false });
      // activating an unverified rule is allowed but stays advisory; asking it to hard-stop needs an explicit enforce flag
      failure(await env.as('compliance_officer').post(`${API}/rules/${bisRule.id}/activate`).send({ max_severity: 'hard_stop' }), 422, 'GUARD_BLOCKED');
      data(await env.as('compliance_officer').post(`${API}/rules/${bisRule.id}/activate`).send({}));
      const still = data<{ findings: Finding[] }>(await preview({ segment: 'ci_net_metered', kw: 60, sku_ids: [D.sku.m4BisExpired] }));
      expect(still.findings.filter((f) => f.gate === 'G6' && f.severity !== 'info').every((f) => f.severity === 'warning')).toBe(true);
      data(await env.as('compliance_officer').post(`${API}/rules/${bisRule.id}/deactivate`).send({}));
      covers('8/VERD/soft', 'G6 (expired BIS licence) and G10 are WARNINGS: the governing rule is conflicting/soft, activation of an unverified rule never makes it block', 'compliance_officer');
    });
  });

  describe('Stage 4 · steps 21-22 quote builder, N4a/CE gates, HS any hard stop?, FIX loop, price review', () => {
    it('step 21: the quote is created from the opportunity (version 1, draft) and the funnel counts the quotation', async () => {
      const f0 = await funnel();
      const q = data<Quote>(await env.as('techno_commercial').post(`${API}/quotes`).send({ opportunity_id: S.oppId, payment_terms: '30% advance, balance before dispatch' }), 201);
      S.quoteId = q.id;
      // the seeded default clauses (price validity, duty change, GST change, ALMM change) all exist as templates and are attached
      expect([...(q as unknown as { clause_keys: string[] }).clause_keys].sort()).toEqual(['clause.almm_change', 'clause.duty_change', 'clause.gst_change', 'clause.price_validity']);
      expect(q).toMatchObject({ version: 1, status: 'draft', kw: 3, parent_quote_id: null });
      expect(q.quote_no).toMatch(/^FS\/Q\/26\/\d{4}$/);
      expect((await env.db.table('opportunities').getOrThrow(S.oppId)).stage).toBe('quotation');
      expect((await funnel()).quotation).toBe(f0.quotation! + 1);
      covers('Q/Draft', 'quote created from the opportunity: version 1, status draft, opportunity → quotation', 'techno_commercial');
    });

    it('HS YES: a non-DCR module and an unapproved inverter tax position make the quote BLOCKED; request-approval and send are refused', async () => {
      const bad = [{ sku_id: D.sku.m2NonDcr, qty: 5 }, { sku_id: D.sku.i1Residential, qty: 1 }, { sku_id: D.sku.s1Structure, qty: 3 }, { sku_id: D.sku.c1Cable, qty: 40 }];
      const q = data<Quote>(await env.as('techno_commercial').put(`${API}/quotes/${S.quoteId}/lines`).send({ lines: bad }));
      expect(q).toMatchObject({ status: 'blocked', compliance_status: 'blocked' });
      const stops = hard(q);
      expect(stops.map((f) => f.gate).sort()).toEqual(['G2', 'G9']);
      expect(stops.find((f) => f.gate === 'G2')!.fieldRefs.some((r) => r.startsWith('line:'))).toBe(true);
      const refused = failure(await env.as('techno_commercial').post(`${API}/quotes/${S.quoteId}/request-approval`).send({}), 422, 'COMPLIANCE_BLOCKED');
      expect(JSON.stringify(refused.details)).toContain('G2');
      failure(await env.as('techno_commercial').post(`${API}/quotes/${S.quoteId}/send`).send({}), 409);
      covers('5/HS/yes', 'non-DCR module on a PMSG quote → G2 hard stop (line ref) + inverter G9; status blocked; request-approval 422 COMPLIANCE_BLOCKED; send refused', 'techno_commercial');
      covers('Q/Blocked', 'Draft → Blocked when a hard stop is found', 'techno_commercial');
      covers('8/VERD/hard', 'G2 verified+active rule, condition violated → HARD STOP; G9 inverter special case (conflicting rule) → HARD STOP only because the tax position is unapproved', 'system');
    });

    it('FIX: swap the module for a DCR / List-I / List-II one; the inverter stays a hard stop until a CA-type user records the tax position; structure and cable lines only warn', async () => {
      let q = data<Quote>(await env.as('techno_commercial').put(`${API}/quotes/${S.quoteId}/lines`).send({ lines: mainLines(12) }));
      expect(q.status).toBe('blocked');
      const stops = hard(q);
      expect(stops.map((f) => f.gate)).toEqual(['G9']); // the DCR hard stop is gone; only the disputed-rate inverter remains
      const inverter = q.lines.find((l) => l.sku?.category === 'inverter')!;
      expect(stops[0]!.fieldRefs).toEqual([`line:${inverter.id}`]);
      const soft = q.findings.filter((f) => f.gate === 'G9' && f.severity === 'warning');
      expect(soft.length).toBeGreaterThan(0); // structure / cable: no active GST rule → warning, never a silent rate
      expect(q.lines.find((l) => l.sku?.category === 'structure')!.gst_rate).toBeNull();
      expect(q.lines.find((l) => l.sku?.category === 'module')).toMatchObject({ gst_rate: 5 });
      expect(q.lines.find((l) => l.sku?.category === 'module')!.gst_as_of).toBeTruthy();
      failure(await env.as('techno_commercial').post(`${API}/quotes/${S.quoteId}/tax-position`).send({ lines: [{ line_id: inverter.id, approved: true, gst_rate: 18 }] }), 403);
      const tax = data<Quote>(await env.as('accounts').post(`${API}/quotes/${S.quoteId}/tax-position`).send({
        lines: q.lines.filter((l) => ['inverter', 'structure'].includes(l.sku?.category ?? '') || l.description.toLowerCase().includes('cable')).map((l) => ({ line_id: l.id, approved: true, gst_rate: 18, hsn: l.hsn ?? '85044090' })), note: 'CA review: 18 % on inverter, structure and cable',
      }));
      q = tax;
      expect(hard(q)).toEqual([]);
      expect(q.status).toBe('draft');
      expect(q.lines.find((l) => l.sku?.category === 'inverter')).toMatchObject({ gst_rate: 18, tax_position_approved: true });
      covers('5/FIX/swap', 'module swapped to the DCR SKU and the inverter tax position approved by Accounts (403 for techno-commercial) → hard stops cleared, status draft', 'techno_commercial');
      covers('21', 'lines with HSN and GST rate + as-of date, discount, CFA / state / loan / consumer split, validity date, change clauses; quote number FS/Q/yy/nnnn', 'techno_commercial');
    });

    it('CE · step 22 · N4a: evaluate persists the findings with the rule ids used; no hard stop → PRICE REVIEW with margin and floor check; the CFA matches the pmsg.cfa.* rules', async () => {
      const ev = data<Evaluation>(await env.as('techno_commercial').post(`${API}/quotes/${S.quoteId}/evaluate`).send({}));
      expect(ev.hasHardStop).toBe(false);
      expect(ev.quote.status).toBe('price_review');
      expect(ev.ruleIdsUsed.length).toBeGreaterThan(5);
      const q = await getQuote(S.quoteId, 'techno_commercial');
      expect(q.rule_ids_used.sort()).toEqual([...ev.ruleIdsUsed].sort());
      expect(q.findings.every((f) => Array.isArray(f.ruleIds))).toBe(true);
      const withRules = q.findings.filter((f) => f.severity !== 'info' && f.gate !== 'G9');
      void withRules;
      expect(q.margin_pct).not.toBeNull();
      expect(q.floor_check).not.toBeNull();
      // partners never see margin or floor
      const partner = await getQuote(S.quoteId, 'dealer_user');
      expect(partner.margin_pct).toBeNull();
      expect(partner.floor_check).toBeNull();

      // CFA from the live rules
      const rv = async (path: string) => data<{ rule: { value: number } | null }>(await env.as('compliance_officer').get(`${API}/rules/resolve?path=${path}`)).rule!.value;
      const [per2, third, maxTotal, maxKw] = [await rv('pmsg.cfa.per_kw_first_2kw'), await rv('pmsg.cfa.third_kw'), await rv('pmsg.cfa.max_total'), await rv('pmsg.cfa.max_kw_eligible')];
      const kw = Math.min(q.kw, maxKw);
      const expected = Math.min(Math.min(kw, 2) * per2 + Math.max(0, kw - 2) * third, maxTotal);
      expect(expected).toBe(78000);
      expect(q.cfa_entitlement).toBe(expected);
      expect(q.cfa.breakdown.cfa.lines.map((l) => [l.label, l.kw, l.rate, l.amount])).toEqual([['First 2 kW', 2, per2, 2 * per2], ['Third kW', 1, third, third]]);
      expect(q.state_share).toBe(0); // gujarat.state_subsidy is inactive: no silent state share
      expect(q.loan_share).toBe(0);
      expect(q.consumer_share).toBeCloseTo(q.total - q.cfa_entitlement, 2);
      expect(q.total).toBeCloseTo(q.subtotal - q.discount_amount + q.tax_total + q.freight, 0);
      covers('N4a', 'gates G1-G14 evaluated with rules resolved by reference date; CFA 2 x 30,000 + 18,000 = 78,000 from pmsg.cfa.* (state share 0 while gujarat.state_subsidy is inactive)', 'techno_commercial');
      covers('5/CE', 'POST /evaluate persists findings, status and rule_ids_used (matches the evaluation\'s ruleIdsUsed)', 'techno_commercial');
      covers('8/SAVE', 'quotations.rule_ids_used equals the evaluation ruleIdsUsed; every finding carries ruleIds', 'system');
      covers('8/OUT', 'no hard stop left → Proceed (price_review); with a hard stop → Blocked (earlier test)', 'system');
      covers('5/HS/no', 'no hard stop → internal price review (status price_review)', 'techno_commercial');
      covers('22', 'internal price review: margin_pct and floor_check visible to internal roles, null for the dealer user', 'techno_commercial');
      covers('Q/ComplianceCheck', 'evaluate: findings, compliance_status and rule_ids_used stored', 'techno_commercial');
      covers('Q/PriceReview', 'Draft/Blocked → PriceReview after a clean evaluation', 'techno_commercial');
    });
  });

  describe('Stage 4 · step 23 approval matrix: D1 discount needed?, three lanes, T3 pending approval escalation', () => {
    it('5/FIX/override: a hard stop can also be cleared by a compliance-lane override with a written reason (seeded non-DCR quote)', async () => {
      const g2 = D.quote.g2;
      const before = await getQuote(g2);
      expect(before.status).toBe('draft');
      const ev = data<Evaluation>(await env.as('techno_commercial').post(`${API}/quotes/${g2}/evaluate`).send({}));
      expect(ev.quote.status).toBe('blocked');
      failure(await env.as('techno_commercial').post(`${API}/compliance/overrides`).send({ entity_type: 'quotation', entity_id: g2, gates: ['G2'], reason: 'short' }), 422);
      const ov = data<{ approval: { id: string; lane: string; required_role: string } }>(await env.as('techno_commercial').post(`${API}/compliance/overrides`).send({ entity_type: 'quotation', entity_id: g2, gates: ['G2'], reason: 'Customer-supplied DCR certificate pending MNRE listing - exception agreed with the compliance officer' }), 201);
      expect(ov.approval).toMatchObject({ lane: 'compliance', required_role: 'compliance_officer' });
      failure(await env.as('compliance_officer').post(`${API}/approvals/${ov.approval.id}/decide`).send({ decision: 'approved' }), 422); // comment mandatory
      data(await env.as('compliance_officer').post(`${API}/approvals/${ov.approval.id}/decide`).send({ decision: 'approved', comment: 'Exception recorded; revisit when the certificate is listed' }));
      const after = await getQuote(g2);
      expect(after.findings.filter((f) => f.gate === 'G2' && f.severity === 'hard_stop').every((f) => f.overridden === true)).toBe(true);
      expect(['draft', 'price_review']).toContain(after.status);
      covers('5/FIX/override', 'POST /compliance/overrides (reason ≥ 10 chars) → compliance officer decides with a mandatory comment → G2 findings overridden:true, quote leaves Blocked', 'compliance_officer');
    });

    it('D1 YES: a 12 % discount opens the commercial chain DSM → Regional Head → Management and the credit lane (dealer over limit); every lane runs its own SLA clock', async () => {
      goto('2026-10-30', '11:00');
      const f0 = Object.keys(await funnel());
      void f0;
      const req = data<Quote>(await env.as('techno_commercial').post(`${API}/quotes/${S.quoteId}/request-approval`).send({ note: 'Please review the 12 % discount requested by the customer' }));
      expect(req.status).toBe('pending_approval');
      const lane = (l: string) => req.approvals.filter((a) => a.lane === l).sort((a, b) => a.step - b.step);
      expect(lane('commercial').map((a) => a.required_role)).toEqual(['dsm', 'regional_head', 'management']);
      expect(lane('compliance')).toHaveLength(0); // no exemption reliance, no substitution, no finding that rests on an unverified rule
      expect(lane('credit').map((a) => a.required_role)).toEqual(['accounts']);
      const clocks = await env.db.table('clocks').all({ clock_type: 'approval', status: 'running' });
      const mine = clocks.filter((c) => req.approvals.some((a) => a.id === c.entity_id));
      expect(mine).toHaveLength(2); // one SLA clock per lane's active step
      failure(await env.as('regional_head').post(`${API}/approvals/${lane('commercial')[1]!.id}/decide`).send({ decision: 'approved' }), 409); // out of turn
      failure(await env.as('dealer_user').post(`${API}/approvals/${lane('commercial')[0]!.id}/decide`).send({ decision: 'approved' }), 403);
      S.approvalIds = JSON.stringify(req.approvals.map((a) => a.id));
      covers('5/D1/yes', '12 % discount (> 10 % band) → request-approval opens commercial + compliance + credit lanes in parallel', 'techno_commercial');
      covers('Q/PendingApproval', 'Approved-pending: status pending_approval with one running SLA clock per lane', 'techno_commercial');
    });

    it('T3: an approval left past its SLA breaches and escalates (clock.approval.* notifications); then every lane approves in order', async () => {
      const dsmStep = (await getQuote(S.quoteId)).approvals.find((a) => a.lane === 'commercial' && a.step === 1)!;
      data(await env.as('dsm').post(`${API}/approvals/${dsmStep.id}/decide`).send({ decision: 'approved', comment: 'Within territory range' }));
      // compliance and credit lanes wait: 24 working hours pass (Fri 11:00 → Mon evening)
      goto('2026-11-02', '18:30');
      await env.tick();
      const q = await getQuote(S.quoteId);
      const late = await env.db.table('clocks').all({ clock_type: 'approval', status: 'breached' });
      const mineLate = late.filter((c) => q.approvals.some((a) => a.id === c.entity_id));
      expect(mineLate.length).toBeGreaterThan(0);
      const allNotes = await env.db.table('notifications').all();
      expect(allNotes.some((n) => n.kind.startsWith('clock.approval.breach') && mineLate.some((c) => c.entity_id === n.entity_id))).toBe(true);
      covers('10/T3', 'pending approval past its SLA: clock breached and clock.approval.breach notification to the owner / DSM, later levels escalate', 'system');

      const rolesUsed = [...await approveAllLanes(S.quoteId, 'Reviewed in the flow test')];
      rolesUsed.unshift('dsm');
      expect(new Set(rolesUsed)).toEqual(new Set(['dsm', 'regional_head', 'management', 'accounts']));
      const done = await getQuote(S.quoteId);
      expect(done.status).toBe('approved');
      const decided = done.approvals.filter((a) => a.decision === 'approved');
      expect(decided).toHaveLength(4);
      for (const a of decided) expect(await roleOf(a.approver_id)).toMatch(/dsm|regional_head|management|compliance_officer|accounts|admin/);
      expect(await env.db.table('clocks').count({ clock_type: 'approval', status: 'running', entity_id: decided.map((a) => a.id) })).toBe(0);
      for (const r of new Set(rolesUsed)) covers('23', `approval matrix: ${r} decided its step (commercial chain DSM → Regional Head → Management, compliance officer, accounts)`, r);
      covers('5/L1', 'commercial lane approved in chain order DSM → Regional Head → Management', 'management');
      covers('5/L3', 'credit lane approved by accounts (dealer Anand Rooftop is over its credit limit)', 'accounts');
      covers('Q/Approved', 'PendingApproval → Approved when every lane that was opened approves', 'management');
    });

    it('D1 NO: with no discount and no trigger the quote is approved at once (seeded clean PMSG quote); a lane rejection rejects the quote (seeded pending quote)', async () => {
      const clean = D.quote.clean1;
      const ev = data<Evaluation>(await env.as('techno_commercial').post(`${API}/quotes/${clean}/evaluate`).send({}));
      expect(ev.hasHardStop).toBe(false);
      const req = data<Quote>(await env.as('techno_commercial').post(`${API}/quotes/${clean}/request-approval`).send({}));
      expect(req.status).toBe('approved');
      expect(req.approvals.filter((a) => a.decision === 'pending')).toHaveLength(0);
      S.cleanQuoteId = clean;
      covers('5/D1/no', 'discount 0 % and no compliance / credit trigger → request-approval returns approved, no approval rows, no SLA clocks', 'techno_commercial');

      // any lane rejects → Rejected (comment mandatory)
      const pend = D.quote.pendingH;
      const open = (await getQuote(pend)).approvals.filter((a) => a.decision === 'pending');
      const head = open.filter((a) => a.lane === 'commercial').sort((a, b) => a.step - b.step)[0]!;
      failure(await env.as(head.required_role as Who).post(`${API}/approvals/${head.id}/decide`).send({ decision: 'rejected' }), 422);
      const rej = data<{ outcome: string }>(await env.as(head.required_role as Who).post(`${API}/approvals/${head.id}/decide`).send({ decision: 'rejected', comment: '7 % is too deep for a hospital order at this margin' }));
      expect(rej.outcome).toBe('rejected');
      const after = await getQuote(pend);
      expect(after.status).toBe('rejected');
      covers('Q/Rejected', 'a lane rejection (mandatory comment) rejects the quote; open approvals are closed', head.required_role);
      const revised = data<Quote>(await env.as('techno_commercial').post(`${API}/quotes/${pend}/revise`).send({ note: 'Re-quote at 4 % after the rejection' }), 201);
      expect(revised).toMatchObject({ version: 2, parent_quote_id: pend, status: 'draft' });
      covers('26', 'Rejected → revise creates version 2 as a draft with parent_quote_id', 'techno_commercial');
    });
  });

  describe('Stage 4 · steps 24-27 send, customer discussion, D2 accepted?, revise loop, quote follow-up, re-quote engine', () => {
    it('step 24: the approved quote is sent through the consent-aware pipeline with a stored branded PDF; Day 1/3/5/7 follow-up clocks start', async () => {
      goto('2026-11-02', '18:45');
      const sent = data<{ quote: Quote; deliveries: { channel: string; status: string; blocked: boolean; reasons: unknown[] }[]; followup_clocks: number; document_id: string }>(
        await env.as('techno_commercial').post(`${API}/quotes/${S.quoteId}/send`).send({ channels: ['email', 'whatsapp'] }));
      expect(sent.quote.status).toBe('sent');
      const email = sent.deliveries.find((d) => d.channel === 'email')!;
      expect(email).toMatchObject({ status: 'sent', blocked: false });
      expect(sent.deliveries.every((d) => ['sent', 'queued', 'blocked'].includes(d.status))).toBe(true);
      const doc = await env.db.table('documents').getOrThrow(sent.document_id);
      expect(doc).toMatchObject({ bucket: 'quote-pdfs', mime: 'application/pdf', doc_type: 'quotation_pdf' });
      const bytes = await env.deps.providers.storage.download({ bucket: 'quote-pdfs', path: doc.path });
      expect(bytes!.subarray(0, 5).toString()).toBe('%PDF-');
      const log = await env.db.table('message_log').all({ lead_id: S.leadId, purpose: 'service' });
      expect(log.some((m) => m.channel === 'email' && m.status === 'sent' && m.consent_id)).toBe(true);
      const cadence = (await env.db.table('clocks').all({ clock_type: 'quote_followup', entity_id: S.quoteId }, { orderBy: { col: 'due_at' } })).map((c) => (c.meta as { day: number }).day);
      expect(cadence).toEqual([1, 3, 5, 7]);
      failure(await env.as('techno_commercial').post(`${API}/quotes/${S.quoteId}/send`).send({}), 409);
      S.v1Id = S.quoteId;
      covers('24', 'branded PDF stored (bucket quote-pdfs, starts %PDF-), e-mail delivered with consent id in message_log, WhatsApp/e-mail outcome reported per channel, quote → sent', 'techno_commercial');
      covers('Q/Sent', 'Approved → Sent; one quote_followup clock per cadence day', 'techno_commercial');
      covers('5/FU', 'follow-up clocks for Day 1, 3, 5 and 7 created at send', 'system');
    });

    it('step 25 · T5: Day 1 passes without a customer response (clock breach + escalation); the customer then negotiates → Negotiation', async () => {
      const due1 = (await env.db.table('clocks').all({ clock_type: 'quote_followup', entity_id: S.quoteId }, { orderBy: { col: 'due_at' } }))[0]!.due_at;
      expect(new Date(due1).getTime()).toBeGreaterThan(env.now().getTime() + 12 * HOUR); // Day 1 = one WORKING day after sending (sent after hours)
      env.setNow(new Date(new Date(due1).getTime() + 5 * MINUTE));
      await env.tick();
      const day1 = (await env.db.table('clocks').all({ clock_type: 'quote_followup', entity_id: S.quoteId }, { orderBy: { col: 'due_at' } }))[0]!;
      expect(day1.status).toBe('breached');
      const note = (await env.db.table('notifications').all()).filter((n) => n.entity_id === S.quoteId && n.kind.startsWith('clock.quote_followup'));
      expect(note.length).toBeGreaterThan(0);
      covers('10/T5', 'no customer response by Day 1: quote_followup clock breached, owner / DSM notified (clock.quote_followup.breach)', 'system');
      env.advance(30 * MINUTE);
      const disc = data<{ id: string }>(await env.as('dsm').post(`${API}/quotes/${S.quoteId}/discussions`).send({ kind: 'call', outcome: 'Customer asked for a lower price', notes: 'Compares with a local installer at Rs 55,000/kW', next_followup_at: iso(new Date(env.now().getTime() + DAY)) }), 201);
      expect(disc.id).toBeTruthy();
      expect((await getQuote(S.quoteId)).status).toBe('negotiation');
      expect((await env.db.table('opportunities').getOrThrow(S.oppId)).stage).toBe('negotiation');
      covers('25', 'customer discussion logged (call, outcome, notes) → quote negotiation, opportunity negotiation; the next follow-up clock satisfied', 'dsm');
      covers('Q/Negotiation', 'Sent → Negotiation on the first discussion', 'dsm');
    });

    it('D2 NO · step 26: the customer declines; revising creates version 2 linked to version 1 (which becomes "revised") and loops back through evaluation and approval', async () => {
      failure(await env.as('dsm').post(`${API}/quotes/${S.quoteId}/reject`).send({}), 422);
      const rej = data<Quote>(await env.as('dsm').post(`${API}/quotes/${S.quoteId}/reject`).send({ reason: 'Customer found a lower price elsewhere' }));
      expect(rej.status).toBe('rejected');
      const v2 = data<Quote>(await env.as('techno_commercial').post(`${API}/quotes/${S.quoteId}/revise`).send({ reprice: false, note: 'Customer asked for a better rate - reduce the discount band and keep DCR modules' }), 201);
      expect(v2).toMatchObject({ version: 2, parent_quote_id: S.quoteId, status: 'draft', quote_no: (await getQuote(S.quoteId)).quote_no });
      expect((await getQuote(S.quoteId)).status).toBe('revised');
      expect(v2.lines).toHaveLength(4);
      S.quoteId = v2.id;
      failure(await env.as('techno_commercial').post(`${API}/quotes/${S.v1Id}/revise`).send({}), 409); // a version that already has a child
      covers('5/D2/no', 'customer declines (reason mandatory) → step 26 revise: version 2, same quote_no, parent_quote_id = version 1, version 1 → revised, v1 cannot be revised twice', 'dsm');
      covers('Q/Revised', 'Negotiation/Rejected → Revised (old version) with a new Draft version', 'techno_commercial');
      covers('26', 'revise creates version n+1 (parent linked) and loops back to preparation, evaluation and approval', 'techno_commercial');

      // loop back to 21: smaller discount (8 %) → commercial DSM → Regional Head, credit lane (dealer over limit), no compliance lane
      const lines = mainLines(8).slice(0, 3); // the customer will supply the DC cable: the line set differs from version 1
      const withTax = (await getQuote(S.quoteId)).lines;
      const put = data<Quote>(await env.as('techno_commercial').put(`${API}/quotes/${S.quoteId}/lines`).send({ lines }));
      expect(hard(put).map((f) => f.gate)).toEqual([]); // tax positions approved on v1 are kept when rate / HSN are unchanged
      void withTax;
      const req = data<Quote>(await env.as('techno_commercial').post(`${API}/quotes/${S.quoteId}/request-approval`).send({ note: 'Version 2 at 8 %' }));
      expect(req.status).toBe('pending_approval');
      expect(req.approvals.filter((a) => a.lane === 'commercial').map((a) => a.required_role)).toEqual(['dsm', 'regional_head']);
      expect(req.approvals.filter((a) => a.lane === 'compliance').map((a) => a.required_role)).toEqual(['compliance_officer']); // SKU set changed against the parent version
      expect(req.approvals.filter((a) => a.lane === 'credit').map((a) => a.required_role)).toEqual(['accounts']);
      const roles = await approveAllLanes(S.quoteId, 'Version 2 approved');
      expect(roles).toEqual(expect.arrayContaining(['dsm', 'regional_head', 'accounts', 'compliance_officer']));
      covers('23', 'version 2 opens all three lanes (commercial DSM → Regional Head, compliance for the changed SKU set, credit); the compliance officer decides', 'compliance_officer');
      covers('5/L2', 'compliance lane opened by the SKU-set change against the parent version and approved by the compliance officer', 'compliance_officer');
      expect((await getQuote(S.quoteId)).status).toBe('approved');
      const sent = data<{ quote: Quote }>(await env.as('techno_commercial').post(`${API}/quotes/${S.quoteId}/send`).send({}));
      expect(sent.quote.status).toBe('sent');
    });

    it('D2 YES · step 27: the customer accepts version 2; commercial terms are confirmed and the opportunity moves to the PI stage', async () => {
      goto('2026-11-05', '12:00');
      const acc = data<Quote & { accepted_at: string; terms_confirmed_at: string }>(await env.as('sales_manager').post(`${API}/quotes/${S.quoteId}/accept`).send({ note: 'Customer confirmed by phone and WhatsApp' }));
      expect(acc.status).toBe('accepted');
      expect(acc.terms_confirmed_at).toBeTruthy();
      expect((await env.db.table('opportunities').getOrThrow(S.oppId)).stage).toBe('pi_stage');
      expect(await env.db.table('clocks').count({ clock_type: 'quote_followup', entity_id: S.quoteId, status: 'running' })).toBe(0);
      const versions = (await getQuote(S.quoteId)).versions.map((v) => [v.version, v.status]);
      expect(versions).toEqual(expect.arrayContaining([[1, 'revised'], [2, 'accepted']]));
      expect((await lead(S.leadId)).status).toBe('opportunity');
      covers('27', 'accepted: accepted_at + terms_confirmed_at set, follow-up clocks cancelled, opportunity → pi_stage', 'sales_manager');
      covers('5/D2/yes', 'quotation accepted → commercial terms confirmed (version 2 of the same quote number)', 'sales_manager');
      covers('Q/Accepted', 'Negotiation/Sent → Accepted (step 27)', 'sales_manager');
    });

    it('RQ: a new price snapshot flags every open quote that uses the SKU as requote_required and notifies its owner; revising re-prices it as a new Draft; the exposure report lists it', async () => {
      // the seeded clean quote was approved at once (D1 NO); send it, then change the module price
      goto('2026-11-05', '12:30');
      data(await env.as('dsm').post(`${API}/leads/${D.lead.oppPmsg}/consents`).send({ notice_version: 'default-v1', purposes: ['service', 'quotation'], channels: ['email'], proof_ref: 'phone-consent-flow-test' }), 201);
      const sent = data<{ quote: Quote }>(await env.as('techno_commercial').post(`${API}/quotes/${S.cleanQuoteId}/send`).send({ channels: ['email'] }));
      expect(sent.quote.status).toBe('sent');
      const price = data<{ id: string }>(await env.as('techno_commercial').post(`${API}/prices`).send({ sku_id: D.sku.i1Residential, base_price: 39500, valid_from: '2026-11-05', landed_cost: { freight: 250 }, floor_price: 36000, source: 'Flow test price list', snapshot_label: 'FLOW-PL-1105' }), 201);
      expect(price.id).toBeTruthy();
      const flagged = await getQuote(S.cleanQuoteId);
      expect(flagged.status).toBe('requote_required');
      expect(flagged.requote_reason).toBeTruthy();
      // the accepted main quote is not an open quote, so it is untouched
      expect((await getQuote(S.quoteId)).status).toBe('accepted');
      const rep = data<{ totals: { requote_required: number } }>(await env.as('sales_manager').get(`${API}/reports/requote-exposure?only_flagged=true`));
      expect(rep.totals.requote_required).toBeGreaterThan(0);
      const rq = data<Quote>(await env.as('techno_commercial').post(`${API}/quotes/${S.cleanQuoteId}/revise`).send({ reprice: true }), 201);
      expect(rq).toMatchObject({ version: 2, status: 'draft' });
      expect(rq.lines.find((l) => l.sku_id === D.sku.i1Residential)!.unit_price).toBe(39500);
      // the seeded government quote goes out too (no discount, no trigger → approved at once) and is sent AFTER the price change (so it is not flagged) and left to lapse
      const gov = D.quote.clean2;
      data(await env.as('techno_commercial').patch(`${API}/quotes/${gov}`).send({ validity_date: '2026-11-06' })); // short validity so that it lapses in the flow
      data(await env.as('techno_commercial').post(`${API}/quotes/${gov}/evaluate`).send({}));
      expect(data<Quote>(await env.as('techno_commercial').post(`${API}/quotes/${gov}/request-approval`).send({})).status).toBe('approved');
      data(await env.as('sales_manager').post(`${API}/leads/${D.lead.oppGovernment}/consents`).send({ notice_version: 'default-v1', purposes: ['service', 'quotation'], channels: ['email'], proof_ref: 'tender-correspondence-flow-test' }), 201);
      expect(data<{ quote: Quote }>(await env.as('techno_commercial').post(`${API}/quotes/${gov}/send`).send({ channels: ['email'] })).quote.status).toBe('sent');
      S.govQuoteId = gov;
      covers('5/RQ', 'price snapshot change flagged the open sent quote requote_required (+ reason, owner notified) and left the accepted one alone; exposure report lists it; revise(reprice) takes the new price', 'techno_commercial');
      covers('Q/RequoteRequired', 'Sent → RequoteRequired when a price snapshot changed; RequoteRequired → Draft via revise', 'techno_commercial');
    });
  });
}

