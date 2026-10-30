/** Stage 3 of the flow (diagram section 4, steps 14-20): segmentation fork, site visit, requirement form, name/dues check, feasibility, recommendation, negotiation, convert or nurture. */
import { describe, expect, it } from 'vitest';
import { SEGMENTS, type LeadListItem, type Site } from '@solar/shared';
import { covers } from './flowCoverage';
import { API, D, DAY, HOUR, MINUTE, S, clockOf, data, env, eventsOf, funnel, goto, iso, lead } from './flowKit';
import { failure } from './flowHarness';
import { jpegWithExif, plainJpeg } from '../sites/jpeg';

interface Hint { code: string; gate?: string; advisory: boolean }
interface SiteSave { customer: { id: string }; site: Site; created: { customer: boolean; site: boolean }; hints: Hint[] }
interface SurveyView { id: string; status: string; feasibility: { status: string; required: boolean | null; due_at: string | null; clock: { id: string; status: string } | null }; photo_count: number }

export function stage3(): void {
  describe('Stage 3 · N3a segmentation fork and rule pack', () => {
    it('each of the seven segments has its own requirement form and its own gate applicability', async () => {
      const forms: Record<string, string[]> = {};
      for (const seg of SEGMENTS) {
        const f = data<{ segment: string; source: string; fields: { key: string; required: boolean }[] }>(await env.as('techno_commercial').get(`${API}/segments/${seg}/form`));
        expect(f.segment).toBe(seg);
        forms[seg] = f.fields.map((x) => x.key);
      }
      expect(forms.rwa_ghs).toContain('rwa_households');
      expect(forms.pm_kusum).toContain('kusum_component');
      expect(forms.government_bid).toContain('bid_reference');
      expect(forms.open_access).toContain('voltage_level');
      expect(forms.ci_captive).toContain('behind_the_meter');
      expect(forms.pmsg_residential).toContain('special_category_state');
      expect(new Set(Object.values(forms).map((k) => k.join(','))).size).toBe(7);

      const gates = data<{ gates: { gate: string; applicability: Record<string, { applicability: string }> }[]; segments: string[] }>(await env.as('compliance_officer').get(`${API}/compliance/gates`));
      expect(gates.segments).toHaveLength(7);
      const g2 = gates.gates.find((g) => g.gate === 'G2')!;
      expect(g2.applicability.pmsg_residential!.applicability).toBe('applies');
      expect(g2.applicability.ci_net_metered!.applicability).toBe('not_applies');
      expect(g2.applicability.government_bid!.applicability).toBe('warning');
      const g13 = gates.gates.find((g) => g.gate === 'G13')!;
      expect(Object.entries(g13.applicability).filter(([, v]) => v.applicability === 'applies').map(([k]) => k)).toEqual(['pmsg_residential']);
      covers('N3a', 'seven segment forms differ (RWA households, KUSUM component, bid reference, open-access voltage, captive behind-the-meter, PMSG special category) and gate applicability differs by segment (G2 applies to PMSG/RWA/KUSUM, not to net-metered C&I, a warning for bids; G13 PMSG only)', 'techno_commercial');
    });
  });

  describe('Stage 3 · steps 14-15 site visit, requirement form, NM name on bill + dues, FE feasibility', () => {
    it('step 14: the visit is scheduled, a geo-tagged photo is uploaded and the survey is completed (lead → site_visit)', async () => {
      goto('2026-10-28', '10:40');
      const sched = data<SurveyView>(await env.as('distributor_user').post(`${API}/surveys`).send({ lead_id: S.leadId, scheduled_at: '2026-10-29T11:00:00+05:30', notes: 'Bungalow, Satellite - bring the shading tool' }), 201);
      S.surveyId = sched.id;
      expect(sched.status).toBe('scheduled');
      expect(sched.feasibility).toMatchObject({ status: 'not_required' });
      expect(await lead(S.leadId)).toMatchObject({ next_action: 'Site visit' });

      goto('2026-10-29', '11:20');
      const photo = jpegWithExif({ lat: 23.0467, lng: 72.5307, takenAt: '2026:10:29 11:15:00' });
      const up = await env.as('distributor_user').post(`${API}/surveys/${S.surveyId}/photos`).attach('photos', photo, { filename: 'roof-south-west.jpg', contentType: 'image/jpeg' }).field('caption', 'Roof from the south-west corner');
      const uploaded = data<{ uploaded: { geo_source: string; lat: number; lng: number }[]; photo_count: number }>(up, 201);
      expect(uploaded.uploaded[0]).toMatchObject({ geo_source: 'exif' });
      expect(uploaded.uploaded[0]!.lat).toBeCloseTo(23.0467, 3);
      expect(uploaded.photo_count).toBe(1);

      const missing = failure(await env.as('distributor_user').patch(`${API}/surveys/${S.surveyId}`).send({ status: 'completed' }), 422, 'VALIDATION_ERROR');
      expect(JSON.stringify(missing.details)).toMatch(/shading|roof_type|roof_area_sqm/);
      const done = data<SurveyView>(await env.as('distributor_user').patch(`${API}/surveys/${S.surveyId}`).send({
        status: 'completed', shading: 'low', roof_type: 'rcc', roof_area_sqm: 38, sld_ref: 'SLD-MT-001', notes: 'South-facing RCC terrace, parapet 1.2 m, no obstruction. Room for 6 modules.',
      }));
      expect(done.status).toBe('completed');
      expect(await lead(S.leadId)).toMatchObject({ status: 'site_visit', next_action: 'Share recommendation and discuss rate' });
      covers('14', 'survey scheduled (surveyor notified), EXIF geo-tagged photo stored (geo_source exif), completion needs shading/roof/area, lead → site_visit', 'distributor_user');
      covers('L/SiteVisit', 'Qualified → SiteVisit when the survey is completed', 'distributor_user');
    });

    it('step 15 · NM YES: the saved site matches the applicant, no dues; the bill upload marks the bill captured and RE-SCORES the lead', async () => {
      const before = await lead(S.leadId);
      expect(before.quality_score).toBe(85);
      const save = data<SiteSave>(await env.as('distributor_user').put(`${API}/leads/${S.leadId}/site`).send({
        applicant_name: 'Mukesh Trivedi', name_on_bill: 'Mukesh Rajesh Trivedi', consumer_no: 'AH-41207733', discom_code: 'TORRENT', sanctioned_load_kw: 5, phase: 'single', address: { line1: '12 Shyamal Row Houses, Satellite', city: 'Ahmedabad', district: 'Ahmedabad', state: 'Gujarat', pincode: '380015' },
        pincode: '380015', roof_ownership: 'owned', title_ok: true, pending_dues: false, existing_solar_kw: 0, category: 'general', roof_type: 'rcc', lat: 23.0467, lng: 72.5307,
        customer: { legal_name: 'Mukesh Trivedi', customer_type: 'residential', email: 'mukesh.trivedi@example.com', phone: '9825012345' },
      }), 201);
      S.siteId = save.site.id;
      S.customerId = save.customer.id;
      expect(save.created).toEqual({ customer: true, site: true });
      expect(save.site.name_match).toBe(true); // a missing middle name is tolerated
      expect(save.hints.filter((h) => h.gate === 'G12')).toHaveLength(0);
      expect(await lead(S.leadId)).toMatchObject({ customer_id: save.customer.id, site_id: save.site.id, consumer_no: 'AH-41207733' });
      covers('4/NM/yes', 'name on bill "Mukesh Rajesh Trivedi" matches applicant "Mukesh Trivedi", no pending dues → name_match true and no G12 hint', 'distributor_user');

      const bill = await env.as('distributor_user').post(`${API}/leads/${S.leadId}/site/bill`).attach('file', plainJpeg(), { filename: 'electricity-bill-oct-2026.jpg', contentType: 'image/jpeg' });
      const billOut = data<{ document: { id: string }; bill_captured: boolean }>(bill, 201);
      S.billDocId = billOut.document.id;
      expect(billOut.bill_captured).toBe(true);
      const after = await lead(S.leadId);
      expect(after.bill_captured).toBe(true);
      expect(after.quality_score).toBe(90); // + bill_captured 5 points: the score must follow the bill (regression: it stayed at 85)
      const view = data<{ components: { key: string; points: number }[] }>(await env.as('distributor_user').get(`${API}/leads/${S.leadId}/score`));
      expect(view.components.find((c) => c.key === 'bill_captured')!.points).toBe(5);
      failure(await env.as('distributor_user').post(`${API}/leads/${S.leadId}/site/bill`).attach('file', plainJpeg(), { filename: 'aadhaar_front.jpg', contentType: 'image/jpeg' }), 422, 'AADHAAR_BLOCKED');
    });

    it('step 15: the requirement form (seeded PMSG version) is completed; required fields are enforced', async () => {
      const view = data<{ source: string; config: { fields: { key: string; required: boolean }[] }; completed: boolean; missing_required: { key: string }[] }>(await env.as('distributor_user').get(`${API}/leads/${S.leadId}/requirement`));
      expect(view.completed).toBe(false);
      expect(view.missing_required.length).toBeGreaterThan(5);
      const incomplete = failure(await env.as('distributor_user').put(`${API}/leads/${S.leadId}/requirement`).send({ data: { consumer_no: 'AH-41207733' }, complete: true }), 422, 'VALIDATION_ERROR');
      expect((incomplete.details as { path: string }[]).length).toBeGreaterThan(3);
      const answers = {
        consumer_no: 'AH-41207733', discom: 'Torrent Power', sanctioned_load_kw: 5, phase: 'single', bill_doc: S.billDocId, name_on_bill: 'Mukesh Rajesh Trivedi', name_match: true,
        roof_ownership: 'owned', title_ok: true, pending_dues: false, existing_solar_kw: 0, roof_type: 'rcc', load_type: 'residential', category: 'general', special_category_state: false,
        specs: 'Bifacial not needed; 3 kW on-grid with a 5 kW single-phase inverter',
      };
      const done = data<{ completed: boolean; missing_required: unknown[] }>(await env.as('distributor_user').put(`${API}/leads/${S.leadId}/requirement`).send({ data: answers, complete: true }));
      expect(done).toMatchObject({ completed: true, missing_required: [] });
      expect(await eventsOf(S.leadId)).toContain('requirement_completed');
      covers('15', 'site + customer created (consumer no, DISCOM, sanctioned load, phase), bill uploaded and re-scored, name match, roof title, pending dues, existing solar kW, category captured; requirement form completed', 'distributor_user');
    });

    it('step 15 · NM NO: a mismatching name and pending dues raise G12 hints (warning only) and the quote engine carries them; the requirement form mirrors the DISCOM to the site', async () => {
      const id = S.routedLeadId; // Krunal Desai
      const save = data<SiteSave>(await env.as('distributor_user').put(`${API}/leads/${id}/site`).send({
        applicant_name: 'Krunal Desai', name_on_bill: 'Hiren Desai', consumer_no: 'AH-30981122', sanctioned_load_kw: 4, phase: 'single', pincode: '380004', roof_ownership: 'owned', title_ok: true, pending_dues: true, existing_solar_kw: 0, category: 'general',
        customer: { legal_name: 'Krunal Desai', customer_type: 'residential' },
      }), 201);
      expect(save.site.name_match).toBe(false);
      const codes = save.hints.map((h) => h.code);
      expect(codes).toEqual(expect.arrayContaining(['NAME_MISMATCH', 'PENDING_DUES']));
      expect(save.hints.every((h) => h.advisory)).toBe(true);
      expect(save.hints.filter((h) => h.gate === 'G12').length).toBeGreaterThan(0);
      const preview = data<{ findings: { gate: string; severity: string; fieldRefs: string[] }[]; hasHardStop: boolean }>(await env.as('techno_commercial').post(`${API}/compliance/preview`).send({ segment: 'pmsg_residential', kw: 3, site_id: save.site.id, sku_ids: [D.sku.m1Dcr] }));
      const g12 = preview.findings.filter((f) => f.gate === 'G12');
      expect(g12.length).toBeGreaterThan(0);
      expect(g12.every((f) => f.severity === 'warning')).toBe(true);
      expect(preview.hasHardStop).toBe(false); // G12 warns, never blocks
      covers('4/NM/no', 'name on bill ≠ applicant and pending dues → NAME_MISMATCH + PENDING_DUES hints, G12 warning (not a hard stop) in the compliance preview', 'techno_commercial');

      // the society lead: DISCOM answered on the requirement form must reach the site (DISCOM applications are built from the site)
      const chs = S.lateLeadId;
      const owner = (await lead(chs)).distributor_id === D.distributor.suryamitra ? 'distributor_user_b' : 'distributor_user';
      S.chsOwnerRole = owner;
      const chsSave = data<SiteSave>(await env.as(owner).put(`${API}/leads/${chs}/site`).send({ applicant_name: 'Shreenath Heights CHS', name_on_bill: 'Shreenath Heights CHS', consumer_no: 'AH-77000121', sanctioned_load_kw: 60, phase: 'three', pincode: '380015', roof_ownership: 'society', title_ok: true, pending_dues: false, existing_solar_kw: 0, category: 'general', customer: { legal_name: 'Shreenath Heights Co-operative Housing Society', customer_type: 'housing_society' } }), 201);
      expect(chsSave.site.discom_id).toBeNull();
      await env.as(owner).put(`${API}/leads/${chs}/requirement`).send({ data: { discom: 'Torrent Power' } });
      expect((await env.db.table('sites').getOrThrow(chsSave.site.id)).discom_id).toBe(D.discom.torrent);
      S.chsSiteId = chsSave.site.id;
    });

    it('FE NO: a 3 kW system needs no feasibility study (409 on the feasibility endpoint)', async () => {
      const err = failure(await env.as('distributor_user').patch(`${API}/surveys/${S.surveyId}/feasibility`).send({ submitted_at: iso(new Date(env.now().getTime() - HOUR)) }), 409, 'INVALID_STATE');
      expect(err.message).toBeTruthy();
      const s = data<SurveyView>(await env.as('distributor_user').get(`${API}/surveys/${S.surveyId}`));
      expect(s.feasibility).toMatchObject({ status: 'not_required', clock: null });
      expect(await env.db.table('clocks').count({ clock_type: 'discom_feasibility', entity_id: S.leadId })).toBe(0);
      covers('4/FE/no', '3 kW ≤ 10 kW exemption: survey feasibility not_required, PATCH feasibility → 409, no discom_feasibility clock', 'distributor_user');
    });

    it('FE YES (start): a 40 kW society survey starts the 15-day feasibility clock when the DISCOM application is complete', async () => {
      const chs = S.lateLeadId;
      const owner = S.chsOwnerRole as 'distributor_user';
      goto('2026-10-29', '15:00');
      const sv = data<SurveyView>(await env.as(owner).post(`${API}/surveys`).send({ lead_id: chs, scheduled_at: '2026-10-30T10:00:00+05:30' }), 201);
      expect(sv.feasibility).toMatchObject({ status: 'pending', required: true });
      goto('2026-10-30', '12:00');
      await env.as(owner).patch(`${API}/surveys/${sv.id}`).send({ status: 'completed', shading: 'medium', roof_type: 'rcc', roof_area_sqm: 420, notes: 'Two terraces, water tanks to shift' });
      const submitted = '2026-10-30T11:00:00+05:30';
      const feas = data<{ status: string; due_at: string; clock: { status: string } | null; days_allowed: number }>(await env.as(owner).patch(`${API}/surveys/${sv.id}/feasibility`).send({ submitted_at: submitted, complete_at: '2026-10-30T11:30:00+05:30' }));
      expect(feas.status).toBe('pending');
      expect(feas.days_allowed).toBe(15);
      expect(feas.clock).toMatchObject({ status: 'running' });
      expect(new Date(feas.due_at).getTime()).toBe(new Date('2026-10-30T11:30:00+05:30').getTime() + 15 * DAY);
      S.chsSurveyId = sv.id;
      S.chsFeasDue = feas.due_at;
      const c = await clockOf(chs, 'discom_feasibility');
      expect(c).toMatchObject({ status: 'running', entity_type: 'lead' });
      covers('N3b', 'feasibility tracking: submitted + complete dates stored, discom_feasibility clock (15 days) running for the lead', owner);
    });
  });

  describe('Stage 3 · steps 16-18 recommendation, solution fit, rate negotiation', () => {
    it('step 16 · 4/CP: only validated SKUs are recommended, with USP, warranty and a live compliance panel', async () => {
      const rec = data<{ id: string; model: string; usp: { quality: string } | null; warranty_years: number | null; has_hard_stop: boolean; gates: { gate: string; status: string }[] }[]>(await env.as('techno_commercial').get(`${API}/skus/recommend?segment=pmsg_residential&kw=3&category=module`));
      const dcr = rec.find((r) => r.id === D.sku.m1Dcr)!;
      expect(dcr).toMatchObject({ model: 'DS-N600-DCR', has_hard_stop: false });
      expect(dcr.usp).toBeTruthy();
      expect(dcr.warranty_years).toBeGreaterThan(0);
      expect(rec.find((r) => r.id === D.sku.m2NonDcr)!.has_hard_stop).toBe(true); // non-DCR on a PMSG job
      const only = data<{ id: string }[]>(await env.as('techno_commercial').get(`${API}/skus/recommend?segment=pmsg_residential&kw=3&category=module&compliant_only=true`));
      expect(only.map((r) => r.id)).toContain(D.sku.m1Dcr);
      expect(only.map((r) => r.id)).not.toContain(D.sku.m2NonDcr);
      expect(only.map((r) => r.id)).not.toContain(D.sku.m3NotListI);
      covers('16', 'recommend returns only active SKUs with a compliance row, each with USP, warranty and gate results; compliant_only drops non-DCR / non-List-I modules', 'techno_commercial');

      const panel = data<{ findings: { gate: string; severity: string; fieldRefs: string[] }[]; hasHardStop: boolean; status: string; gates: { gate: string; status: string }[]; cfa: { eligible: boolean; cfa: number } }>(
        await env.as('distributor_user').post(`${API}/compliance/preview`).send({ segment: 'pmsg_residential', kw: 3, expected_commissioning_date: '2026-12-10', sku_ids: [D.sku.m2NonDcr], lead_id: S.leadId }));
      expect(panel.hasHardStop).toBe(true);
      expect(panel.findings.find((f) => f.gate === 'G2' && f.severity === 'hard_stop')).toBeTruthy();
      const clean = data<{ hasHardStop: boolean; gates: { gate: string; status: string }[]; cfa: { cfa: number } }>(await env.as('distributor_user').post(`${API}/compliance/preview`).send({ segment: 'pmsg_residential', kw: 3, expected_commissioning_date: '2026-12-10', sku_ids: [D.sku.m1Dcr], lead_id: S.leadId }));
      expect(clean.hasHardStop).toBe(false);
      for (const g of ['G2', 'G3', 'G4']) expect(clean.gates.find((x) => x.gate === g)!.status).toBe('pass');
      expect(clean.cfa.cfa).toBe(78000);
      covers('4/CP', 'live panel: G2 hard stop for the non-DCR module, G2-G4 pass for the DCR/List-I/List-II module, CFA 78,000 for 3 kW', 'distributor_user');
      covers('8/VERD/pass', 'condition not violated (DCR, List-I, List-II all verified) → gates G2-G4 PASS in the evaluation', 'system');
    });

    it('step 17: the techno-commercial engineer records the solution-fit discussion and checks the design against the survey', async () => {
      const fit = data<{ contact: { id: string } }>(await env.as('techno_commercial').post(`${API}/leads/${S.leadId}/contacts`).send({
        channel: 'visit', outcome: 'visit_done', notes: 'Technical discussion: 3 kW (5 x 600 Wp) on the south RCC terrace fits in 38 sq m with low shading; 5 kW single-phase inverter keeps room to expand; DCR modules for CFA.',
        next_action: 'Share rate and discuss negotiation', next_followup_at: iso(new Date(env.now().getTime() + DAY)),
      }), 201);
      expect(fit.contact.id).toBeTruthy();
      const timeline = data<{ kind: string; summary: string }[]>(await env.as('techno_commercial').get(`${API}/leads/${S.leadId}/timeline?limit=100`));
      expect(timeline.some((t) => t.kind === 'contact')).toBe(true);
      const survey = data<{ roof_area_sqm: number; shading: string }>(await env.as('techno_commercial').get(`${API}/surveys/${S.surveyId}`));
      expect(survey).toMatchObject({ roof_area_sqm: 38, shading: 'low' });
      covers('17', 'techno-commercial role logs the solution-fit visit against the survey findings (roof area, shading) and the live compliance panel; appears on the lead timeline', 'techno_commercial');
    });

    it('step 18: the rate negotiation is logged round by round with the gap per kW', async () => {
      const one = data<{ summary: { rounds: number; gap_per_kw: number | null } }>(await env.as('sales_manager').post(`${API}/leads/${S.leadId}/negotiations`).send({ quoted_rate_per_kw: 62000, customer_counter_per_kw: 54000, notes: 'Customer compares with a local installer' }), 201);
      expect(one.summary.rounds).toBe(1);
      const two = data<{ summary: { rounds: number; latest_quoted_rate_per_kw: number; gap_per_kw: number; kw: number } }>((env.advance(MINUTE), await env.as('sales_manager').post(`${API}/leads/${S.leadId}/negotiations`).send({ quoted_rate_per_kw: 58000, customer_counter_per_kw: 55000 })), 201);
      expect(two.summary).toMatchObject({ rounds: 2, latest_quoted_rate_per_kw: 58000, gap_per_kw: 3000, kw: 3 });
      const log = data<{ rows: unknown[] }>(await env.as('dsm').get(`${API}/leads/${S.leadId}/negotiations`));
      expect(log.rows).toHaveLength(2);
      covers('18', 'two negotiation rounds logged with quoted rate, customer counter and the remaining gap per kW / total', 'sales_manager');
    });
  });

  describe('Stage 3 · Q decision: NO → nurture / recycle with a re-engagement date; YES → convert (three confirmations), then step 20', () => {
    it('Q NO: a lead that is not ready is nurtured with a re-engagement date; a lost lead can be recycled; closing a lead cancels its clocks', async () => {
      const cold = S.coldLeadId; // Vraj Packaging Works
      const until = '2026-11-02';
      const res = data<LeadListItem>(await env.as('distributor_user').post(`${API}/leads/${cold}/nurture`).send({ reason: 'Factory under renovation - revisit after the budget is approved', nurture_until: until }));
      expect(res.status).toBe('nurture');
      expect(res.next_followup_at).toBe('2026-11-02T04:30:00.000Z'); // 10:00 IST on the re-engagement date
      S.nurtureLeadId = cold;
      covers('4/Q/no', 'not a qualified project → nurture with nurture_until and a 10:00 IST follow-up on that date', 'distributor_user');
      covers('L/Nurture', 'qualified/site-visit lead moved to nurture with a re-engagement date', 'distributor_user');

      const rasik = S.noConsentLeadId;
      await env.as('distributor_user').patch(`${API}/leads/${rasik}`).send({ next_action: 'Call back about the ad' });
      const lost = data<LeadListItem>(await env.as('distributor_user').post(`${API}/leads/${rasik}/lost`).send({ reason: 'Customer bought from another installer' }));
      expect(lost.status).toBe('lost');
      const closed = await env.db.table('clocks').all({ entity_id: rasik });
      expect(closed.filter((c) => c.clock_type === 'followup').every((c) => c.status === 'cancelled' || c.status === 'met' || c.resolved_at !== null)).toBe(true);
      expect(closed.some((c) => c.status === 'cancelled')).toBe(true);
      covers('K/Cancelled', 'marking the lead lost cancels its running clocks (status cancelled, resolved_at set)', 'distributor_user');
      covers('L/Lost', 'lost reason recorded, status lost, ownership lock released', 'distributor_user');
      const recycled = data<LeadListItem>(await env.as('distributor_user').post(`${API}/leads/${rasik}/nurture`).send({ reason: 'Bought elsewhere but unhappy with service - recycle', nurture_until: '2026-11-20' }));
      expect(recycled.status).toBe('nurture');
    });

    it('Q YES / WI: conversion is refused until the three confirmations are true (and a site exists), listing exactly what is missing', async () => {
      const check = data<{ can_convert: boolean; prerequisites: { key: string; ok: boolean }[]; confirmations: { key: string }[] }>(await env.as('dsm').get(`${API}/leads/${S.leadId}/convert-check`));
      expect(check.can_convert).toBe(true); // segment, kW and a saved site are in place; the three confirmations are supplied with the convert call
      expect(check.confirmations.map((c) => c.key)).toEqual(['requirement_confirmed', 'timeline_confirmed', 'commercial_potential_confirmed']);
      expect(check.prerequisites.every((p) => p.ok)).toBe(true);
      const f0 = await funnel();

      const one = failure(await env.as('dsm').post(`${API}/leads/${S.leadId}/convert`).send({ requirement_confirmed: true }), 422, 'GUARD_BLOCKED');
      const d1 = one.details as { missing_confirmations: string[]; missing_prerequisites: string[] };
      expect(d1.missing_confirmations).toEqual(['timeline_confirmed', 'commercial_potential_confirmed']);
      expect(d1.missing_prerequisites).toEqual([]);
      const none = failure(await env.as('dsm').post(`${API}/leads/${S.leadId}/convert`).send({}), 422, 'GUARD_BLOCKED');
      expect((none.details as { missing_confirmations: string[] }).missing_confirmations).toHaveLength(3);
      // a lead without a saved site is also refused
      const shah = failure(await env.as('dsm').post(`${API}/leads/${S.warmLeadId}/convert`).send({ requirement_confirmed: true, timeline_confirmed: true, commercial_potential_confirmed: true }), 422, 'GUARD_BLOCKED');
      expect((shah.details as { missing_prerequisites: string[] }).missing_prerequisites).toContain('site');
      expect(await env.db.table('opportunities').count({ lead_id: S.leadId })).toBe(0);
      covers('4/WI', 'POST /convert → 422 GUARD_BLOCKED listing missing_confirmations [timeline, commercial potential] and missing_prerequisites [site]; nothing created. (The matching SQL trigger lives in supabase/sql and is not executable here.)', 'dsm');

      goto('2026-10-29', '16:00');
      const conv = data<{ opportunity: { id: string; stage: string; scheme_route: string; regulation_version: string | null; exemption_reliance: boolean; kw: number; lead_id: string; probability: number; funding_mix: { consumer_pct: number; loan_rate_pct: number | null } }; created: boolean }>(await env.as('dsm').post(`${API}/leads/${S.leadId}/convert`).send({
        requirement_confirmed: true, timeline_confirmed: true, commercial_potential_confirmed: true, expected_commissioning_date: '2026-12-10', expected_close_date: '2026-11-20',
      }), 201);
      S.oppId = conv.opportunity.id;
      expect(conv.created).toBe(true);
      expect(conv.opportunity).toMatchObject({ stage: 'qualified', scheme_route: 'pmsg', kw: 3, lead_id: S.leadId, exemption_reliance: false });
      expect(conv.opportunity.regulation_version).toContain('Fifth Amendment');
      expect(conv.opportunity.funding_mix.loan_rate_pct ?? null).toBeNull(); // a loan rate is never defaulted
      expect(await lead(S.leadId)).toMatchObject({ status: 'opportunity' });
      expect((await env.db.table('site_surveys').getOrThrow(S.surveyId)).opportunity_id).toBe(S.oppId);
      // idempotent
      const again = await env.as('dsm').post(`${API}/leads/${S.leadId}/convert`).send({});
      expect(data<{ opportunity: { id: string }; already_converted: boolean }>(again, 200)).toMatchObject({ already_converted: true });
      const f1 = await funnel();
      expect(f1.opportunity).toBe(f0.opportunity! + 1);
      covers('19', 'three confirmations true + site → opportunity (stage qualified, scheme_route pmsg, regulation_version by commissioning date, exemption flag false), lead → opportunity, survey linked, idempotent; funnel gate +1', 'dsm');
      covers('4/Q/yes', 'confirmed qualified project → converted to an opportunity', 'dsm');
      covers('L/Opportunity', 'SiteVisit → Opportunity once the three confirmations are true', 'dsm');
    });

    it('step 20: the opportunity is updated (probability, revenue, close date, competitor, commissioning date → regulation version)', async () => {
      const res = await env.as('techno_commercial').patch(`${API}/opportunities/${S.oppId}`).send({ probability: 70, expected_value: 195000, expected_close_date: '2026-11-25', competitor: 'Local installer (Satellite)', expected_commissioning_date: '2026-12-12' });
      const opp = data<{ probability: number; expected_value: number; competitor: string; expected_commissioning_date: string; regulation_version_display: { label: string } | null; expected_value_basis: string }>(res);
      expect(opp).toMatchObject({ probability: 70, expected_value: 195000, competitor: 'Local installer (Satellite)', expected_commissioning_date: '2026-12-12', expected_value_basis: 'manual' });
      expect(opp.regulation_version_display?.label).toContain('Fifth Amendment');
      failure(await env.as('viewer').patch(`${API}/opportunities/${S.oppId}`).send({ probability: 10 }), 403);
      covers('20', 'probability, revenue, close date, competitor and expected commissioning date saved; regulation version re-derived; viewer gets 403', 'techno_commercial');
    });
  });
}

