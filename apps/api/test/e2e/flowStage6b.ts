/** After dispatch, part 2 (diagram section 7, P2-P5): dispatch override, installation, DISCOM clock YES/NO, deemed feasibility, quote expiry, subsidy, loan, warranty, SOP tracker, scorecard. */
import { describe, expect, it } from 'vitest';
import type { Dispatch } from '@solar/shared';
import { covers } from './flowCoverage';
import { API, D, DAY, S, clockOf, data, env, goto, notificationsOf } from './flowKit';
import { failure } from './flowHarness';
import { jpegWithExif } from '../sites/jpeg';

interface Finding { gate: string; severity: string; message: string; fieldRefs: string[]; overridden?: boolean; ruleIds?: string[] }
interface DDetail extends Dispatch { hard_stops: Finding[]; override: { approved: boolean; pending: boolean; approval_ids: string[] } }
interface Inst { id: string; status: string; sales_order_id: string; warranty_end: string | null; om_end: string | null; regulation_version: string | null; kw: number }
interface DiscomApp { id: string; commissioning_due_at: string | null; deemed_breach: boolean; commissioning_at: string | null; inspection_at: string | null }
interface Claim { id: string; status: string; cohort: string; cfa_computed: number; claim_deadline: string | null; blockers: string[] }
interface WorkRow { claim_id: string; cohort: string; phase: string; days_to_deadline: number | null }

const dsp = () => env.as('dispatch');

export function stage6b(): void {
  describe('7/C/fail-override · a seeded RWA dispatch blocked by gate G4 can also be released by an approved compliance override', () => {
    it('the override needs a written reason and the compliance officer\'s decision with a comment; the findings are then stored as overridden', async () => {
      goto('2026-11-09', '15:00');
      const id = D.dispatch.dsp4;
      const ev = data<DDetail>(await dsp().post(`${API}/dispatches/${id}/evaluate`).send({}));
      expect(ev.status).toBe('blocked');
      expect(ev.hard_stops.some((f) => f.gate === 'G4')).toBe(true);
      failure(await dsp().post(`${API}/dispatches/${id}/dispatch`).send({}), 422, 'COMPLIANCE_BLOCKED');
      failure(await dsp().post(`${API}/dispatches/${id}/compliance-override`).send({ reason: 'short' }), 422);
      const ov = data<DDetail>(await dsp().post(`${API}/dispatches/${id}/compliance-override`).send({ reason: 'Society needs the batch this week; cells are in the List-II listing queue and the exemption window is open' }), 201);
      expect(ov.override.pending).toBe(true);
      const approvalId = ov.override.approval_ids[0]!;
      failure(await env.as('compliance_officer').post(`${API}/approvals/${approvalId}/decide`).send({ decision: 'approved' }), 422);
      data(await env.as('compliance_officer').post(`${API}/approvals/${approvalId}/decide`).send({ decision: 'approved', comment: 'Exception for this consignment only; List-II listing to be confirmed' }));
      const out = data<DDetail>(await dsp().post(`${API}/dispatches/${id}/dispatch`).send({ vehicle_no: 'GJ05CD9876', transporter: 'Surat Roadways' }));
      expect(out.status).toBe('dispatched');
      expect(out.override.approved).toBe(true);
      const stored = (await env.db.table('dispatches').getOrThrow(id)).compliance_findings as unknown as Finding[];
      expect(stored.filter((x) => x.severity === 'hard_stop').every((x) => x.overridden === true)).toBe(true);
      covers('7/C/fail-override', 'G4 hard stop on the seeded RWA dispatch → compliance-override (reason ≥ 10 chars) → compliance officer approves with a comment → dispatch goes out, hard-stop findings stored overridden:true', 'compliance_officer');
    });
  });

  describe('P2 · installation, DISCOM commissioning clock (15 days), H within 15 days? YES and NO', () => {
    it('7/E: the dealer registers the installation (vendor of record) and uploads a geo-tagged photo; the seeded RWA project is installed too', async () => {
      goto('2026-11-10', '11:00');
      const inst = data<Inst>(await env.as('dealer_user').post(`${API}/installations`).send({ sales_order_id: S.soId, installer_name: 'Anand Rooftop Solutions (Demo)', install_date: '2026-11-10' }), 201);
      S.instId = inst.id;
      expect(inst).toMatchObject({ status: 'installed', sales_order_id: S.soId }); // an install date means the system is installed (ladder: planned → installed → certified → commissioned)
      expect(inst.kw).toBe(3);
      const ph = data<{ uploaded: unknown[]; warnings: string[] }>(await env.as('dealer_user').post(`${API}/installations/${S.instId}/photos`).attach('photos', jpegWithExif({ lat: 23.0468, lng: 72.5309, takenAt: '2026:11:10 12:20:00' }), { filename: 'array-installed.jpg', contentType: 'image/jpeg' }), 201);
      expect(ph.uploaded).toHaveLength(1);
      expect(ph.warnings.join(' ')).not.toMatch(/no geo/i);
      const rwa = data<Inst>(await env.as('sales_manager').post(`${API}/installations`).send({ sales_order_id: D.salesOrder.so4, installer_name: 'Hazira Industrial Solar (Demo)', install_date: '2026-11-10' }), 201);
      S.rwaInstId = rwa.id;
      covers('7/E', 'installation created from a dispatched order with installer / vendor of record; geo-tagged EXIF photo accepted without a missing-geo warning', 'dealer_user');
    });

    it('7/F: the installation certificate starts the DISCOM commissioning clock (15 days) on a DISCOM application', async () => {
      goto('2026-11-12', '11:00');
      const cert = data<{ installation: Inst; discom_application: DiscomApp }>(await env.as('dealer_user').post(`${API}/installations/${S.instId}/certificate`).send({ certificate_at: '2026-11-12T10:30:00+05:30' }));
      expect(cert.installation.status).toBe('certified');
      S.discomAppId = cert.discom_application.id;
      expect(cert.discom_application.commissioning_due_at).toBe('2026-11-27T18:29:59.999Z'); // end of the IST day, 15 days after the certificate
      expect(await clockOf(S.discomAppId, 'discom_commissioning')).toMatchObject({ status: 'running', entity_type: 'discom_application' });
      data(await env.as('sales_manager').post(`${API}/installations/${S.rwaInstId}/certificate`).send({ certificate_at: '2026-11-12T12:00:00+05:30' }));
      S.rwaAppId = (await env.db.table('discom_applications').all({ installation_id: S.rwaInstId }))[0]!.id;
      failure(await env.as('viewer').post(`${API}/installations/${S.instId}/certificate`).send({}), 403);
      covers('7/F', 'certificate → status certified, DISCOM application created with commissioning_due_at = certificate day + 15 (end of IST day), discom_commissioning clock running on the application', 'dealer_user');
    });

    it('7/H/yes: the RWA project is commissioned inside the 15 days - no breach; N3b: the 40 kW society\'s DISCOM feasibility lapses on DISCOM silence and is deemed feasible', async () => {
      goto('2026-11-20', '12:00');
      const done = data<{ installation: Inst; discom_application: DiscomApp }>(await env.as('sales_manager').post(`${API}/installations/${S.rwaInstId}/commission`).send({ commissioned_at: '2026-11-20T11:00:00+05:30', meter_type: 'Net meter', meter_at: '2026-11-19' }));
      expect(done.installation.status).toBe('commissioned');
      expect(done.discom_application.deemed_breach).toBe(false);
      expect((await env.db.table('clocks').all({ entity_id: S.rwaAppId, clock_type: 'discom_commissioning' }))[0]!.status).toBe('met');
      covers('7/H/yes', 'commissioned 8 days after the certificate: clock met, deemed_breach false', 'sales_manager');

      await env.tick(); // the society's feasibility clock (15 days after the complete application) passes with no DISCOM reply
      expect((await env.db.table('site_surveys').getOrThrow(S.chsSurveyId)).feasibility_status).toBe('deemed');
      expect(await env.db.table('lead_events').count({ lead_id: S.lateLeadId, event_type: 'feasibility_deemed' })).toBe(1);
      expect((await env.db.table('notifications').all()).some((n) => n.kind === 'survey.feasibility_deemed')).toBe(true);
      expect((await env.db.table('clocks').all({ entity_id: S.lateLeadId, clock_type: 'discom_feasibility' }))[0]!.resolved_at).toBeTruthy();
      covers('N3b', 'feasibility deemed feasible on DISCOM silence after 15 days: survey feasibility_status deemed, feasibility_deemed event + notification, clock resolved', 'system');
      covers('4/FE/yes', '40 kW society: feasibility clock started from the complete application (due +15 days) and lapsed into "deemed feasible"', 'system');
    });

    it('7/H/no · 7/G · 7/I · 10/X1: the main project misses the 15 days - the deemed-clock breach is logged with evidence and escalated; commissioning, regulation version and inspection are recorded', async () => {
      goto('2026-11-24', '10:00');
      expect(data<{ status: string }>(await env.as('admin').post(`${API}/admin/jobs/subsidy.legacy_claim_reminders/run`).send({})).status).toBe('ok');
      const legacy = (await env.db.table('notifications').all()).filter((n) => n.kind.startsWith('subsidy.legacy_deadline'));
      expect(legacy.length).toBeGreaterThan(0);

      goto('2026-11-28', '10:00');
      await env.tick();
      const app = data<DiscomApp>(await env.as('dsm').get(`${API}/discom-applications/${S.discomAppId}`));
      expect(app.deemed_breach).toBe(true);
      const audit = (await env.db.table('audit_log').all({ action: 'discom.deemed_breach' })).find((a) => a.record_id === S.discomAppId)!;
      expect(JSON.stringify(audit.detail)).toContain('evidence');
      expect((await notificationsOf(D.profile.dsm, 'discom.deemed_breach')).length).toBeGreaterThan(0);
      covers('7/H/no', '15 days passed without commissioning: deemed_breach true, audit discom.deemed_breach with evidence, DSM notified (discom.deemed_breach)', 'system');

      const comm = data<{ installation: Inst; serials_installed: number }>(await env.as('dealer_user').post(`${API}/installations/${S.instId}/commission`).send({ commissioned_at: '2026-11-28T11:00:00+05:30', meter_type: 'Net meter', meter_at: '2026-11-27' }));
      expect(comm.installation.status).toBe('commissioned');
      expect(comm.installation.regulation_version).toContain('Fifth Amendment');
      expect(comm.installation.om_end).toBe('2031-11-28');
      expect(comm.installation.warranty_end).toBeTruthy();
      expect(comm.serials_installed).toBe(6);
      S.warrantySerial = (JSON.parse(S.dispatchSerials) as { serial: string; sku: string }[]).find((x) => x.sku === D.sku.m1Dcr)!.serial;
      failure(await env.as('dealer_user').post(`${API}/installations/${S.instId}/commission`).send({}), 409);
      covers('P2', 'installation → certificate (DISCOM clock) → commissioning within / beyond 15 days with deemed-breach evidence, regulation version and 5-year O&M dates', 'dealer_user');
      covers('7/G', 'commissioning with meter details: regulation version by commissioning date (Fifth Amendment), warranty_end, 5-year om_end, dispatched serials flip to installed', 'dealer_user');

      const insp = data<DiscomApp>(await env.as('dealer_user').patch(`${API}/discom-applications/${S.discomAppId}`).send({ inspection_at: '2026-11-28T14:00:00+05:30' }));
      expect(insp.inspection_at).toBeTruthy();
      covers('7/I', 'DISCOM inspection recorded on the application (stage ageing starts at the certificate)', 'dealer_user');

      const sop = data<{ id: string }>(await env.as('sales_manager').post(`${API}/sop-cases`).send({ dealer_id: D.dealer.d6, complaint_ref: 'FLOW-SOP-2026-001', summary: 'Customer complaint: structure fitted before DISCOM approval' }), 201);
      S.sopId = sop.id;
      expect((await notificationsOf(D.profile.dsm2, 'sop.')).length + (await notificationsOf(D.profile.sales_manager, 'sop.')).length).toBeGreaterThan(0);
      const stock = data<{ exemption: { days_left: number | null; urgency: string }; totals: { units: number } }>(await env.as('sales_manager').get(`${API}/dashboards/stock-exposure`));
      expect(stock.exemption.urgency).toBe('watch'); // 33 days to 31-Dec-2026
      expect(stock.totals.units).toBeGreaterThan(0);
      covers('10/X1', 'research escalations reach the DSM / managers: DISCOM deemed breach (discom.deemed_breach), legacy CFA reminders (subsidy.legacy_deadline.*), dealer under SOP (sop.* notification), non-List-II stock exposure urgency "watch" 33 days before 31-Dec-2026', 'system');
    });
  });

  describe('P3 · subsidy claim (CFA clock, legacy-cohort work-list), loan record with rejection code, release closes the receivable', () => {
    it('7/J · 7/K: the legacy-cohort claim is prepared, DISCOM approval starts the CFA release clock, and the daily work-list puts legacy claims first', async () => {
      goto('2026-11-28', '15:00');
      const claim = data<Claim>(await env.as('accounts').post(`${API}/subsidy-claims`).send({ installation_id: S.instId, cohort: 'legacy', application_date: '2026-10-29', bank_proof_ok: true, e_token: 'ETK-2026-0117' }), 201);
      S.claimId = claim.id;
      expect(claim).toMatchObject({ cohort: 'legacy', status: 'not_ready', claim_deadline: '2026-11-30' });
      expect(claim.cfa_computed).toBe(78000);
      expect(claim.blockers.join(' ')).toMatch(/inspection/i);
      failure(await env.as('accounts').post(`${API}/subsidy-claims/${S.claimId}/claim`).send({}), 422, 'GUARD_BLOCKED');
      expect((await clockOf(S.claimId, 'legacy_cfa_claim_deadline')).status).toBe('running');
      const ok = data<Claim>(await env.as('accounts').post(`${API}/subsidy-claims/${S.claimId}/discom-approval`).send({ approved_at: '2026-11-28T16:00:00+05:30' }));
      expect(ok.status).toBe('ready');
      expect((await clockOf(S.claimId, 'cfa_release')).status).toBe('running');
      covers('7/J', 'claim readiness: not_ready while DISCOM inspection approval is missing (blockers listed, claim refused 422), ready once bank proof, geo photos, inspection approval and e-token are present', 'accounts');

      const wl = await env.as('accounts').get(`${API}/subsidy-claims/worklist`);
      const rows = (wl.body as { data: WorkRow[] }).data;
      const firstCurrent = rows.findIndex((r) => r.cohort !== 'legacy');
      const cut = firstCurrent < 0 ? rows.length : firstCurrent;
      expect(rows.slice(0, cut).every((r) => r.cohort === 'legacy')).toBe(true);
      expect(rows.slice(cut).every((r) => r.cohort !== 'legacy')).toBe(true);
      const legacyRows = rows.filter((r) => r.cohort === 'legacy');
      expect(legacyRows.map((r) => r.claim_id)).toContain(S.claimId);
      const rank = (r: WorkRow) => (r.phase === 'await_release' ? 1 : 0);
      for (let i = 1; i < legacyRows.length; i++) {
        const a = legacyRows[i - 1]!;
        const b = legacyRows[i]!;
        expect(rank(a)).toBeLessThanOrEqual(rank(b)); // not-yet-submitted before submitted
        if (rank(a) === rank(b) && a.days_to_deadline !== null && b.days_to_deadline !== null) expect(a.days_to_deadline).toBeLessThanOrEqual(b.days_to_deadline);
      }
      expect((wl.body as { summary: { legacy: number } }).summary.legacy).toBeGreaterThanOrEqual(2); // ours + the seeded W3 claim
      covers('7/K', 'DISCOM approval starts the cfa_release clock; legacy deadline clock (30-Nov-2026) running; work-list orders legacy cohort first, then not-yet-submitted, then fewest days to the deadline', 'accounts');
    });

    it('the claim is submitted before 30-Nov; 7/L subsidy released → 7/N the subsidy-linked dealer receivable is closed and the dealer\'s exposure drops', async () => {
      goto('2026-11-29', '11:00');
      const rec = data<{ id: string }>(await env.as('accounts').post(`${API}/receivables`).send({ dealer_id: D.dealer.d1, doc_ref: 'FS/INV/26/DSP-MT-CFA', amount: 78000, invoice_date: '2026-11-09', due_date: '2026-12-20', subsidy_linked: true, linked_project_id: S.soId }), 201);
      const before = data<{ outstanding: number; subsidy_linked: number }>(await env.as('accounts').get(`${API}/credit-position/${D.dealer.d1}`));
      const claimed = data<Claim>(await env.as('accounts').post(`${API}/subsidy-claims/${S.claimId}/claim`).send({ claim_at: '2026-11-29T11:00:00+05:30' }));
      expect(claimed.status).toBe('claimed');
      expect((await clockOf(S.claimId, 'legacy_cfa_claim_deadline')).status).toBe('met');
      goto('2026-12-05', '12:00');
      const rel = data<{ receivables_closed: number }>(await env.as('accounts').post(`${API}/subsidy-claims/${S.claimId}/release`).send({ released_at: '2026-12-05T11:00:00+05:30' }));
      expect(rel.receivables_closed).toBe(1);
      expect((await env.db.table('dealer_receivables').getOrThrow(rec.id)).status).toBe('paid');
      const after = data<{ outstanding: number; subsidy_linked: number }>(await env.as('accounts').get(`${API}/credit-position/${D.dealer.d1}`));
      expect(after.outstanding).toBe(before.outstanding - 78000);
      expect(after.subsidy_linked).toBe(before.subsidy_linked - 78000);
      expect((await clockOf(S.claimId, 'cfa_release')).status).toBe('met');
      covers('7/L', 'claim submitted (legacy deadline clock met) and released: status released, CFA release clock met', 'accounts');
      covers('7/N', 'release closes the subsidy-linked receivable (linked_project_id = sales order): status paid, dealer outstanding and subsidy-linked exposure drop by 78,000', 'accounts');
    });

    it('7/M: the loan record moves through the ladder; a rejection needs a code, the rate needs a source date, illegal moves are refused; the ageing clock runs', async () => {
      const sum0 = data<{ overall: { applied: number; disbursed: number }; rejection_codes: { code: string; count: number }[] }>(await env.as('sales_manager').get(`${API}/loans/summary`));
      const mk = data<{ id: string }>(await env.as('accounts').post(`${API}/loans`).send({
        bank: 'Bank of Baroda', opportunity_id: S.oppId, lead_id: S.leadId, customer_id: S.customerId, dealer_id: D.dealer.d1, amount: 100000, co_applicant: 'Rajesh Trivedi (father)',
        document_checklist: { id_proof: true, electricity_bill: true, bank_statement: false }, status: 'draft',
      }), 201);
      const url = `${API}/loans/${mk.id}`;
      failure(await env.as('accounts').patch(url).send({ status: 'disbursed' }), 422, 'GUARD_BLOCKED');
      data(await env.as('accounts').patch(url).send({ status: 'applied' }));
      expect((await clockOf(mk.id, 'loan_ageing')).status).toBe('running');
      data(await env.as('accounts').patch(url).send({ status: 'in_review' }));
      failure(await env.as('accounts').patch(url).send({ status: 'rejected' }), 422); // the rejection code is mandatory
      expect(data<{ status: string; rejection_code: string }>(await env.as('accounts').patch(url).send({ status: 'rejected', rejection_code: 'missing_documents' }))).toMatchObject({ status: 'rejected', rejection_code: 'missing_documents' });
      const codeCount = (x: { rejection_codes: { code: string; count: number }[] }) => x.rejection_codes.find((c) => c.code === 'missing_documents')?.count ?? 0;
      expect(codeCount(data(await env.as('sales_manager').get(`${API}/loans/summary`)))).toBe(codeCount(sum0) + 1); // the summary counts the rejection by code
      failure(await env.as('accounts').patch(url).send({ status: 'applied', rate_pct: 7 }), 422); // a rate without its source date
      data(await env.as('accounts').patch(url).send({ status: 'applied', document_checklist: { id_proof: true, electricity_bill: true, bank_statement: true } }));
      data(await env.as('accounts').patch(url).send({ status: 'in_review' }));
      data(await env.as('accounts').patch(url).send({ status: 'approved', rate_pct: 7, rate_source_date: '2026-12-05' }));
      expect(data<{ status: string }>(await env.as('accounts').patch(url).send({ status: 'disbursed' })).status).toBe('disbursed');
      const sum = data<{ overall: { applied: number; disbursed: number }; rejection_codes: { code: string; count: number }[] }>(await env.as('sales_manager').get(`${API}/loans/summary`));
      expect(sum.overall.disbursed).toBe(sum0.overall.disbursed + 1);
      expect(sum.overall.applied).toBe(sum0.overall.applied + 1);
      covers('7/M', 'loan: draft → applied (ageing clock) → in_review → rejected with code missing_documents → re-applied → approved (rate + source date) → disbursed; illegal move and missing code refused; summary counts the rejection', 'accounts');
      covers('P3', 'subsidy claim (legacy cohort, CFA clock, work-list, release closing the receivable) and loan tracking proven end to end', 'accounts');
    });
  });

  describe('P4 · warranty / RMA ticket on a dispatched serial and the 5-year O&M register; 7/Q-7/R SOP tracker feeding gate G11', () => {
    it('7/P: a warranty ticket on an installed module starts the RMA clock (21 days) and moves the serial to RMA; brand recovery is recorded', async () => {
      goto('2026-12-07', '10:00');
      const t = data<{ id: string; ticket_no: string; status: string }>(await env.as('dealer_user').post(`${API}/warranty-tickets`).send({ serial: S.warrantySerial, type: 'rma', issue: 'Back-sheet delamination on one module after 8 days', cost_bearer: 'brand' }), 201);
      expect(t.ticket_no).toMatch(/^FS\/W\/26\/\d{4}$/);
      expect((await env.db.table('inventory_serials').all({ serial: S.warrantySerial }))[0]!.status).toBe('rma');
      const clock = await clockOf(t.id, 'warranty_rma');
      expect(clock.status).toBe('running');
      expect(new Date(clock.due_at).getTime() - env.now().getTime()).toBeGreaterThan(20 * DAY);
      data(await env.as('dealer_user').patch(`${API}/warranty-tickets/${t.id}`).send({ status: 'inspected' }));
      data(await env.as('dealer_user').patch(`${API}/warranty-tickets/${t.id}`).send({ status: 'sent_to_brand', brand_claim_no: 'DS-CLM-7781' }));
      expect(data<{ status: string; recovered_amount: number }>(await env.as('dealer_user').patch(`${API}/warranty-tickets/${t.id}`).send({ status: 'replaced', recovered_amount: 9500 }))).toMatchObject({ status: 'replaced', recovered_amount: 9500 });
      expect((await clockOf(t.id, 'warranty_rma')).status).toBe('met');
      failure(await env.as('dealer_user').patch(`${API}/warranty-tickets/${t.id}`).send({ status: 'inspected' }), 422); // replaced can only be closed
      env.advance(2 * DAY);
      expect(data<{ status: string; closed_at: string }>(await env.as('dealer_user').patch(`${API}/warranty-tickets/${t.id}`).send({ status: 'closed' })).closed_at).toBeTruthy(); // turnaround = closed − opened
      covers('7/P', 'ticket FS/W/yy/nnnn on a printed serial: warranty_rma clock 21 days, serial → rma, status ladder with brand claim number and recovered amount, illegal move refused, clock met on replacement', 'dealer_user');
    });

    it('7/O: the installed-base register lists the project with warranty end and a 5-year O&M window', async () => {
      const reg = await env.as('dsm').get(`${API}/installations/om-register?dealer_id=${D.dealer.d1}`);
      const rows = (reg.body as { data: { installation_id: string; om_end: string; state: string; warranty_end: string | null }[] }).data;
      const mine = rows.find((r) => r.installation_id === S.instId)!;
      expect(mine).toMatchObject({ om_end: '2031-11-28', state: 'active' });
      expect(mine.warranty_end).toBeTruthy();
      covers('7/O', 'om-register row for the installation: warranty_end, om_end = commissioning + 5 years, state active', 'dsm');
      covers('P4', 'warranty / RMA ticket, RMA clock and the 5-year O&M register', 'dealer_user');
    });

    it('7/Q · 7/R · 7/R-G11: an MNRE SOP notice runs reply 8 d → reminder → show-cause → deactivation (1 month) → appeal 30 d; deactivation makes the dealer a gate G11 problem', async () => {
      goto('2026-12-10', '10:00');
      const url = (p = '') => `${API}/sop-cases/${S.sopId}${p}`;
      const sop = data<{ reply_due_at: string }>(await env.as('sales_manager').get(url()));
      expect(new Date(sop.reply_due_at).getTime() - new Date('2026-11-28T10:00:00+05:30').getTime()).toBeGreaterThan(7.5 * DAY);
      expect((await clockOf(S.sopId, 'sop_reply')).status).not.toBe('cancelled');
      expect((await env.db.table('dealers').getOrThrow(D.dealer.d6)).portal_status).toBe('under_sop');
      failure(await env.as('sales_manager').post(url('/transition')).send({ to: 'deactivation' }), 409); // stages must be passed in order
      expect(data<{ reminder_at: string }>(await env.as('sales_manager').post(url('/transition')).send({ to: 'reminder' })).reminder_at).toBeTruthy();
      const sc = data<{ show_cause_due_at: string }>(await env.as('sales_manager').post(url('/transition')).send({ to: 'show_cause' }));
      expect(new Date(sc.show_cause_due_at).getTime() - env.now().getTime()).toBeGreaterThan(14 * DAY);
      const de = data<{ appeal_due_at: string }>(await env.as('sales_manager').post(url('/transition')).send({ to: 'deactivation', outcome: 'Portal deactivation for one month' }));
      expect(new Date(de.appeal_due_at).getTime() - env.now().getTime()).toBeGreaterThan(29 * DAY);
      expect((await env.db.table('dealers').getOrThrow(D.dealer.d6)).portal_status).toBe('deactivated');
      expect((await env.db.table('vendor_registrations').all({ party_id: D.dealer.d6 }))[0]!.portal_status).toBe('deactivated');
      covers('7/Q', 'dealer complaint / MNRE notice logged as a SOP case (complaint ref, summary), DSM and managers notified', 'sales_manager');
      covers('7/R', 'SOP stages in order with due dates from rules: reply 8 d (clock), reminder, show-cause +15 d, deactivation + appeal +30 d; out-of-order move refused 409', 'sales_manager');

      const pos = data<{ portal_status: string; blocked_reasons: string[]; deactivated: boolean }>(await env.as('accounts').get(`${API}/credit-position/${D.dealer.d6}`));
      expect(pos).toMatchObject({ portal_status: 'deactivated', deactivated: true });
      expect(pos.blocked_reasons.join(' ')).toMatch(/deactivated/i);
      const preview = data<{ findings: Finding[] }>(await env.as('techno_commercial').post(`${API}/compliance/preview`).send({ segment: 'pmsg_residential', kw: 3, dealer_id: D.dealer.d6, sku_ids: [D.sku.m1Dcr] }));
      expect(preview.findings.some((f) => f.gate === 'G11' && f.severity !== 'info' && /deactivated/i.test(f.message))).toBe(true);
      expect(data<{ stage: string }>(await env.as('sales_manager').post(url('/transition')).send({ to: 'appeal' })).stage).toBe('appeal');
      data(await env.as('sales_manager').post(url('/transition')).send({ to: 'closed', outcome: 'Appeal upheld' }));
      expect((await env.db.table('dealers').getOrThrow(D.dealer.d6)).portal_status).toBe('active');
      covers('7/R-G11', 'portal deactivation from the SOP tracker: credit position lists "deactivated" in blocked_reasons and the compliance panel raises a G11 finding for the dealer; closing the case reinstates the vendor', 'system');
    });
  });

  describe('P5 · channel scorecard and credit review', () => {
    it('the dealer scorecard, the distributor score recompute (with history) and the dealer exposure board reflect the project', async () => {
      const sc = data<{ dealer_id: string; credit: { limit: number; over_limit: boolean }; portal_status: string }>(await env.as('sales_manager').get(`${API}/dealers/${D.dealer.d1}/scorecard`));
      expect(sc).toMatchObject({ dealer_id: D.dealer.d1, portal_status: 'active' });
      expect(sc.credit.limit).toBe(2_000_000);
      const before = await env.db.table('distributor_score_history').count({ distributor_id: D.distributor.sunrise });
      const rc = data<{ score: number; components: unknown[] }>(await env.as('sales_manager').post(`${API}/distributors/${D.distributor.sunrise}/score/recompute`).send({}));
      expect(rc.score).toBeGreaterThan(0);
      expect(rc.components.length).toBeGreaterThanOrEqual(4);
      expect(await env.db.table('distributor_score_history').count({ distributor_id: D.distributor.sunrise })).toBe(before + 1);
      expect((await env.db.table('distributors').getOrThrow(D.distributor.sunrise)).score).toBe(rc.score);
      const ex = data<{ dealer_id: string }[]>(await env.as('accounts').get(`${API}/dealers/exposure`));
      expect(ex.map((e) => e.dealer_id)).toContain(D.dealer.d1);
      covers('P5', 'dealer scorecard (limit, outstanding, subsidy-linked, portal status), distributor score recompute appends history and updates the score used by routing, exposure board lists the dealer', 'sales_manager');
    });
  });
}
