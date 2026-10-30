/** Dashboards, audit, notifications, calendar and the security checks (diagram sections 10 and 10a; prompt Section 18 "Done means"). */
import { describe, expect, it } from 'vitest';
import { entityPath, verhoeffCheckDigit, type FunnelDashboard } from '@solar/shared';
import { covers } from './flowCoverage';
import { API, D, KEYS, S, data, env, notificationsOf } from './flowKit';
import { failure } from './flowHarness';

const binary = (res: import('superagent').Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const aadhaarLike = (): string => { const p = '23456789012'; return `${p}${verhoeffCheckDigit(p)}`; };

interface HomeSection { key: string; count: number; items: unknown[]; meta: Record<string, unknown> }
interface Home { sections: HomeSection[]; summary: { key: string; value: number }[]; next_best_action: { text: string; path: string } | null; user: { role: string } }

export function stage7(): void {
  describe('10a · the six conversion gates, KPIs and dashboards reflect the whole journey', () => {
    it('10a/gates: the funnel counts every gate in order and each gate has gone up since the journey began', async () => {
      const f = data<FunnelDashboard>(await env.as('management').get(`${API}/dashboards/funnel?segment=pmsg_residential&from=2026-07-30`));
      expect(f.gates.map((g) => g.key)).toEqual(['valid_lead', 'qualified_lead', 'opportunity', 'quotation', 'pi', 'sales_order']);
      const now = Object.fromEntries(f.gates.map((g) => [g.key, g.count]));
      const base = JSON.parse(S.f0) as Record<string, number>;
      expect(now.valid_lead).toBeGreaterThanOrEqual(base.valid_lead!);
      expect(now.qualified_lead).toBeGreaterThan(base.qualified_lead!);
      expect(now.opportunity).toBeGreaterThan(base.opportunity!);
      expect(now.quotation).toBeGreaterThan(base.quotation!);
      expect(now.pi).toBeGreaterThan(base.pi!);
      expect(now.sales_order).toBeGreaterThan(base.sales_order!);
      const row = f.by_segment.find((s) => s.segment === 'pmsg_residential')!;
      expect(row.counts.sales_order).toBeGreaterThanOrEqual(1);
      expect(row.conversions.pi_to_sales_order).not.toBeNull();
      expect(row.conversions.quotation_to_pi).not.toBeNull();
      const keys = f.kpis.map((k) => k.key);
      expect(keys).toEqual(expect.arrayContaining(['funnel_gates', 'conv_inquiry_to_qualified', 'conv_qualified_to_opportunity', 'conv_opportunity_to_quotation', 'conv_quotation_to_pi', 'conv_pi_to_sales_order', 'survey_to_quote_pct', 'loan_approval_pct']));
      expect(f.kpis.find((k) => k.key === 'loan_approval_pct')!.value, 'loan_approval_pct').not.toBeNull();
      covers('10a/gates', 'six gates valid lead → qualified → opportunity → quotation → PI → sales order, each higher than at the start of the journey (counted step by step in the stage tests), per-segment conversions and KPI tiles present', 'management');
    });

    it('the Today queue is role-aware and always carries the compliance calendar', async () => {
      for (const role of ['dsm', 'accounts', 'management', 'dispatch', 'compliance_officer', 'distributor_user', 'viewer'] as const) {
        const h = data<Home>(await env.as(role).get(`${API}/dashboards/home`));
        expect(h.user.role).toBe(role);
        expect(h.summary.map((s) => s.key)).toEqual(['open_leads', 'hot_leads', 'pipeline_inr', 'orders_this_month']);
        expect(h.next_best_action).toBeTruthy();
        expect(h.sections.some((s) => s.key === 'compliance_calendar')).toBe(true);
      }
      const accounts = data<Home>(await env.as('accounts').get(`${API}/dashboards/home`));
      expect(accounts.sections.map((s) => s.key)).toEqual(expect.arrayContaining(['payments_credit', 'legacy_cfa_claims', 'dealer_alerts']));
      const dist = data<Home>(await env.as('distributor_user').get(`${API}/dashboards/home`));
      expect(dist.sections.map((s) => s.key)).not.toContain('stock_exposure'); // internal-only section
    });

    it('SLA, DISCOM, CFA, dealer, compliance and consent dashboards show what the flow produced', async () => {
      const sla = data<{ kpis: { key: string; value: number | null }[]; breaches: unknown[]; escalations_by_level: { level: number; count: number }[]; escalation_triggers: { trigger: string; count: number }[] }>(await env.as('management').get(`${API}/dashboards/sla`));
      expect(sla.kpis.find((k) => k.key === 'lead_acceptance_breaches')!.value).toBeGreaterThan(0);
      expect(sla.escalations_by_level.map((e) => e.level)).toEqual([1, 2, 3]);
      expect(sla.escalation_triggers.length).toBeGreaterThanOrEqual(5);
      expect(sla.kpis.find((k) => k.key === 'first_response_24h_pct')!.value, 'first_response_24h_pct').not.toBeNull();

      const disc = data<{ deemed_breach_list: { application_id: string; clock: string }[]; overall: { applications: number } }>(await env.as('management').get(`${API}/dashboards/discom-ageing`));
      expect(disc.deemed_breach_list.some((b) => b.application_id === S.discomAppId && b.clock === 'commissioning')).toBe(true);

      const cfa = data<{ legacy: { deadline: string; days_to_deadline: number; rule: { path: string; status: string | null; active: boolean }; count: number } }>(await env.as('accounts').get(`${API}/dashboards/cfa-pending`));
      expect(cfa.legacy.rule.path).toBe('pmsg.claim_deadline.legacy_cohort');
      expect(cfa.legacy.deadline).toBe('2026-11-30');
      expect(cfa.legacy.days_to_deadline).toBeLessThan(0); // the claim of this journey was filed on 29-Nov; the seeded W3 claim is now past the deadline
      expect(cfa.legacy.rule.status).not.toBe('verified'); // advisory countdown only

      const dealers = data<{ flagged: { under_sop: { dealer_id: string }[]; deactivated: { dealer_id: string }[]; over_limit: { dealer_id: string }[]; bg_expiring: { dealer_id: string }[] } }>(await env.as('accounts').get(`${API}/dashboards/dealer-exposure`));
      expect(dealers.flagged.over_limit.map((d) => d.dealer_id)).toContain(D.dealer.d1);
      expect(dealers.flagged.deactivated.map((d) => d.dealer_id)).toContain(D.dealer.d5);
      expect(dealers.flagged.under_sop.map((d) => d.dealer_id)).toContain(D.dealer.d4);
      expect(dealers.flagged.bg_expiring.map((d) => d.dealer_id)).toContain(D.dealer.d3);

      const comp = data<{ blocked_by_gate: { gate: string; quotes: number }[]; kpis: { key: string; value: number | null }[]; open_overrides: unknown[] }>(await env.as('compliance_officer').get(`${API}/dashboards/compliance`));
      expect(comp.blocked_by_gate.find((g) => g.gate === 'G2')!.quotes).toBeGreaterThan(0);
      expect(comp.kpis.find((k) => k.key === 'compliance_block_rate_pct')!.value).toBeGreaterThan(0);
      expect(comp.kpis.find((k) => k.key === 'requote_rate_pct')!.value).toBeGreaterThan(0);
      expect(comp.kpis.find((k) => k.key === 'rma_turnaround_days')!.value, 'rma_turnaround_days').not.toBeNull();

      const consent = data<{ blocked_reasons: { code: string; count: number }[]; coverage: { leads: number; covered: number } }>(await env.as('compliance_officer').get(`${API}/dashboards/consent`));
      const codes = consent.blocked_reasons.map((b) => b.code);
      expect(codes).toEqual(expect.arrayContaining(['NO_CONSENT', 'DND_REGISTERED', 'WHATSAPP_WINDOW_CLOSED']));
      expect(consent.coverage.covered).toBeGreaterThan(0);

      failure(await env.as('distributor_user').get(`${API}/dashboards/stock-exposure`), 403);
      const xl = await env.as('management').get(`${API}/reports/export?kpi=funnel_gates`).buffer(true).parse(binary);
      expect(xl.status).toBe(200);
      expect(xl.headers['content-type']).toContain('spreadsheetml');
      expect((xl.body as Buffer).subarray(0, 2).toString()).toBe('PK');
      expect(await env.db.table('audit_log').count({ action: 'report.export' })).toBeGreaterThan(0);
    });

    it('the compliance calendar strip: the next three upcoming dates, soonest first, with countdowns', async () => {
      const cal = data<{ due_date: string; days_left: number; countdown_label: string; urgency: string; title: string }[]>(await env.as('viewer').get(`${API}/calendar?next=3`));
      expect(cal).toHaveLength(3);
      expect(cal.every((c) => c.days_left >= 0)).toBe(true);
      expect([...cal].sort((a, b) => a.due_date.localeCompare(b.due_date))).toEqual(cal);
      expect(cal[0]!.countdown_label).toMatch(/left|Due today/);
      expect(['info', 'warning', 'critical']).toContain(cal[0]!.urgency);
      const all = data<{ due_date: string; title: string }[]>(await env.as('viewer').get(`${API}/calendar`));
      expect(all.some((c) => c.due_date === '2026-11-30')).toBe(true); // the legacy CFA claim date stays on the calendar (past)
    });
  });

  describe('Audit and notifications record the journey', () => {
    it('the audit log holds business-action rows (who, what, which record) for the key mutations of every module', async () => {
      const actions = new Set((await env.db.table('audit_log').all({ source: 'api' })).map((a) => a.action));
      for (const a of ['api_key.create', 'lead.accept', 'lead.qualify', 'lead.convert', 'lead.reassign', 'lead.lock_override_approve', 'consent.withdraw', 'site.save', 'site.bill_upload', 'quote.create', 'quote.evaluate', 'quote.request_approval',
        'quote.send', 'quote.revise', 'quote.accept', 'approval.approved', 'compliance.override_approved', 'pi.issue', 'payment.record', 'credit_override.request', 'credit_override.approved', 'dispatch.create', 'dispatch.dispatch', 'installation.certificate',
        'installation.commissioned', 'discom.deemed_breach', 'loan.status_change', 'rule.deactivate', 'rule.activate', 'clock.breached']) {
        expect(actions.has(a), `audit action ${a}`).toBe(true);
      }
      expect([...actions].filter((a) => a.startsWith('so.')).length).toBeGreaterThanOrEqual(2);
      // the viewer endpoint answers for the compliance officer, with the actor resolved
      const rows = data<{ action: string; actor_name: string | null; record_id: string | null }[]>(await env.as('compliance_officer').get(`${API}/admin/audit?action=pi.issue&record=${S.piId}`));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]!.actor_name).toBeTruthy();
      failure(await env.as('distributor_user').get(`${API}/admin/audit`), 403);
      // personal data never lands in a business-action row
      const unmask = (await env.db.table('audit_log').all()).filter((a) => JSON.stringify(a.detail ?? {}).includes('9825012345'));
      expect(unmask).toEqual([]);
    });

    it('escalations produced notifications for the right people, which the owner can read and clear', async () => {
      const kinds = async (userId: string) => new Set((await env.db.table('notifications').all({ user_id: userId })).map((n) => n.kind));
      const dsm = await kinds(D.profile.dsm);
      for (const k of ['lead.acceptance.dsm_alert', 'clock.lead_acceptance.breach', 'clock.followup.breach', 'discom.deemed_breach']) expect(dsm.has(k), `DSM notification ${k}`).toBe(true);
      expect((await kinds(D.profile.distributor_user)).has('followup.missed')).toBe(true); // the owner is told first
      expect((await kinds(D.profile.sales_manager)).has('clock.lead_acceptance.level2')).toBe(true);
      expect((await kinds(D.profile.management)).has('clock.followup.level3')).toBe(true);
      expect((await kinds(D.profile.accounts)).has('credit_check.pending')).toBe(true);
      expect((await kinds(D.profile.dispatch)).has('so.handover')).toBe(true);

      const unread = data<{ count: number }>(await env.as('dsm').get(`${API}/notifications/unread-count`));
      expect(unread.count).toBeGreaterThan(0);
      const first = (await env.as('dsm').get(`${API}/notifications?unread=true&limit=5`)).body.data as { id: string; kind: string }[];
      expect(first.length).toBeGreaterThan(0);
      data(await env.as('dsm').post(`${API}/notifications/${first[0]!.id}/read`).send({}));
      failure(await env.as('accounts').post(`${API}/notifications/${first[0]!.id}/read`).send({}), 404); // someone else's notification
      const all = data<{ updated: number }>(await env.as('dsm').post(`${API}/notifications/read-all`).send({}));
      expect(all.updated).toBeGreaterThan(0);
      expect(data<{ count: number }>(await env.as('dsm').get(`${API}/notifications/unread-count`)).count).toBe(0);
      expect((await notificationsOf(D.profile.dsm, 'lead.acceptance.dsm_alert'))[0]!.read_at).toBeTruthy();
    });
  });

  describe('Security · party isolation and the Aadhaar guard (G14)', () => {
    it('a distributor user cannot read another distributor\'s lead, quote, invoice, order, dispatch or installation, and lists never leak them', async () => {
      const other = env.as('distributor_user_b'); // Suryamitra; the journey belongs to Sunrise
      for (const url of [`/leads/${S.leadId}`, `/quotes/${S.quoteId}`, `/pis/${S.piId}`, `/sales-orders/${S.soId}`, `/dispatches/${S.dispatchId}`, `/installations/${S.instId}`, `/opportunities/${S.oppId}`, `/subsidy-claims/${S.claimId}`]) {
        const res = await other.get(`${API}${url}`);
        expect([403, 404], `${url} -> ${res.status}`).toContain(res.status);
      }
      const leads = (await other.get(`${API}/leads?q=Trivedi`)).body as { data: { id: string }[]; total: number };
      expect(leads.data.map((l) => l.id)).not.toContain(S.leadId);
      const quotes = (await other.get(`${API}/quotes?limit=200`)).body as { data: { id: string }[] };
      expect(quotes.data.map((q) => q.id)).not.toContain(S.quoteId);
      const search = (await other.get(`${API}/search?q=Trivedi`)).body as { data: { groups: { hits: { id: string }[] }[] } };
      expect(JSON.stringify(search.data.groups)).not.toContain(S.leadId);
      // the owner distributor and the dealer of the project do see it
      expect((await env.as('distributor_user').get(`${API}/sales-orders/${S.soId}`)).status).toBe(200);
      expect((await env.as('dealer_user').get(`${API}/quotes/${S.quoteId}`)).status).toBe(200);
    });

    it('a dealer user cannot see another dealer\'s data', async () => {
      const d2 = env.as('dealer_user_2'); // Bharat Sun: same distributor, different dealer
      for (const url of [`/leads/${S.leadId}`, `/quotes/${S.quoteId}`, `/pis/${S.piId}`, `/sales-orders/${S.soId}`, `/dealers/${D.dealer.d1}`, `/credit-position/${D.dealer.d1}`]) {
        const res = await d2.get(`${API}${url}`);
        expect([403, 404], `${url} -> ${res.status}`).toContain(res.status);
      }
      const dealers = (await d2.get(`${API}/dealers`)).body as { data: { id: string }[] };
      expect(dealers.data.map((d) => d.id)).toEqual([D.dealer.d2]);
      const receivables = (await d2.get(`${API}/receivables?limit=200`)).body as { data: { dealer_id: string }[] };
      expect(receivables.data.every((r) => r.dealer_id === D.dealer.d2)).toBe(true);
      failure(await d2.get(`${API}/sop-cases`), 403);
      failure(await d2.get(`${API}/vendor-registrations`), 403);
    });

    it('G14: a Verhoeff-valid 12-digit number in any free-text field is refused (422 AADHAAR_BLOCKED) while a UUID-shaped value is not', async () => {
      const number = aadhaarLike();
      const spaced = `${number.slice(0, 4)} ${number.slice(4, 8)} ${number.slice(8)}`;
      for (const text of [`Customer gave ${number} on the phone`, `UID ${spaced}`]) {
        failure(await env.as('distributor_user').post(`${API}/leads/${S.leadId}/contacts`).send({ channel: 'call', outcome: 'connected_interested', notes: text }), 422, 'AADHAAR_BLOCKED');
        failure(await env.as('distributor_user').patch(`${API}/leads/${S.leadId}`).send({ notes: text }), 422, 'AADHAAR_BLOCKED');
      }
      failure(await env.as('distributor_user').post(`${API}/leads/${S.leadId}/negotiations`).send({ notes: `PAN ok, Aadhaar ${number}` }), 422, 'AADHAAR_BLOCKED');
      failure(await env.as('techno_commercial').put(`${API}/leads/${S.leadId}/requirement`).send({ data: { specs: `reference ${number}` } }), 422, 'AADHAAR_BLOCKED');
      failure(await env.as('distributor_user').put(`${API}/leads/${S.leadId}/site`).send({ customer: { legal_name: 'Mukesh Trivedi', aadhaar: number } }), 422, 'AADHAAR_BLOCKED'); // an Aadhaar-named field
      const blocked = (await env.db.table('audit_log').all({ action: 'aadhaar.blocked' })).length;
      expect(blocked).toBeGreaterThan(0);
      expect(JSON.stringify(await env.db.table('leads').getOrThrow(S.leadId))).not.toContain(number);

      // a UUID whose last group is a Verhoeff-valid run of 12 digits is an identifier, not an Aadhaar number
      const uuid = `00000000-0000-4000-8000-${number}`;
      const ok = await env.anon().post(`${API}/public/leads`).set('X-Api-Key', KEYS.website!).send({ name: 'Uuid Reference Person', mobile: '9825088888', pincode: '380008', segment: 'pmsg_residential', capacity_kw: 3, product_interest: ['residential'], source_ref: uuid });
      expect([200, 201]).toContain(ok.status);
      expect(await env.db.table('leads').count({ source_ref: uuid })).toBe(1);
      const owner = await env.as('dsm').patch(`${API}/leads/${S.leadId}`).send({ owner_id: D.profile.distributor_user, next_action: `Check record ${uuid}` });
      expect(owner.status).toBe(200);
    });
  });
}

export function stage7b(): void {
  describe('Cross-module consistency · entity types, links and statuses written by one module are understood by the others', () => {
    it('every clock and notification entity type resolves to a screen, and every notification link is a web route', async () => {
      const clocks = await env.db.table('clocks').all();
      const notes = await env.db.table('notifications').all();
      // the link a person lands on: the explicit link of the notification, else the screen of its record
      const lost = [...new Set([
        ...clocks.filter((c) => entityPath(c.entity_type, c.entity_id) === '/').map((c) => `clock:${c.entity_type}`),
        ...notes.filter((n) => !n.link && n.entity_type && entityPath(n.entity_type, n.entity_id ?? 'id') === '/').map((n) => `notification:${n.kind}(${n.entity_type})`),
      ])];
      expect(lost, 'clocks / notifications that open the home page instead of their record').toEqual([]);
      const routes = /^\/(leads|opportunities|surveys|quotes|approvals|invoices|orders|dispatch|post-sale|dealers|distributors|catalogue|calendar|reports|notifications|admin)(\/|\?|$)|^\/$/;
      const bad = (await env.db.table('notifications').all()).filter((n) => n.link && !routes.test(n.link)).map((n) => `${n.kind} -> ${n.link}`);
      expect([...new Set(bad)]).toEqual([]);
    });

    it('the pipeline ends consistent: lead won, opportunity won, order dispatched, serials installed or in RMA, quote accepted', async () => {
      expect((await env.db.table('leads').getOrThrow(S.leadId)).status).toBe('won');
      expect((await env.db.table('opportunities').getOrThrow(S.oppId)).stage).toBe('won');
      expect((await env.db.table('quotations').getOrThrow(S.quoteId)).status).toBe('accepted');
      expect((await env.db.table('proforma_invoices').getOrThrow(S.piId)).status).toMatch(/issued|partially_paid|paid/);
      const so = await env.db.table('sales_orders').getOrThrow(S.soId);
      expect(so.status).toBe('dispatched');
      expect(so.dispatch_handover_at).toBeTruthy();
      const serials = await env.db.table('inventory_serials').all({ sales_order_id: S.soId });
      expect(serials.length).toBe(6);
      expect(serials.every((s) => ['installed', 'rma'].includes(s.status))).toBe(true);
      const inst = await env.db.table('installations').getOrThrow(S.instId);
      expect(inst).toMatchObject({ status: 'commissioned', sales_order_id: S.soId });
      const claim = await env.db.table('subsidy_claims').getOrThrow(S.claimId);
      expect(claim).toMatchObject({ status: 'released', sales_order_id: S.soId, installation_id: S.instId, opportunity_id: S.oppId });
    });
  });
}
