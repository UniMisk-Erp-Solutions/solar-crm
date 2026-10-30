import type { ClockStatus, ClockType, MessageChannel, MessagePurpose, TemplateCategory } from '../enums';
import { maskMobile } from '../format';
import type { AuditLog, BreachIncident, Clock, DataRequest, JobRun, KpiSnapshot, MessageLog, NotificationRow } from '../rows';
import { DEMO_IDS } from './demo.ids';
import type { LeadLayer } from './demo.leads';
import { surveyIdOf } from './demo.leads';
import type { LeadKey } from './demo.leads.data';
import { baseOf, demoId, refId, DAY, HOUR, MIN, type SeedEnv } from './util';

const I = DEMO_IDS;
const P = DEMO_IDS.profile;

/* ───────────────────────── clocks ───────────────────────── */

export function buildClocks(env: SeedEnv, layer: LeadLayer): Clock[] {
  const rows: Clock[] = [];
  const leadOf = (k: LeadKey) => layer.leads.find((l) => l.id === I.lead[k])!;
  const add = (entityType: string, entityId: string, type: ClockType, startedMin: number, dueMin: number, status: ClockStatus, owner: string | null, level = 0, meta: Clock['meta'] = {}): void => {
    const total = dueMin - startedMin;
    const breached = status === 'breached';
    rows.push({
      ...baseOf(env, demoId('clock', rows.length + 1), Math.abs(startedMin)), entity_type: entityType, entity_id: entityId, clock_type: type, started_at: env.t(startedMin), due_at: env.t(dueMin), warn_at: env.t(startedMin + Math.round(total * 0.7)),
      status, escalated_level: level, owner_id: owner, warned_at: dueMin < 0 || breached || startedMin + total * 0.7 < 0 ? env.t(startedMin + Math.round(total * 0.7)) : null, breached_at: breached ? env.t(dueMin) : null,
      resolved_at: null, last_escalated_at: level > 0 ? env.t(dueMin + 4 * HOUR) : null, meta,
    });
  };
  // lead acceptance: one comfortable, one about to breach
  const rwa = leadOf('assignedRwa'), hot = leadOf('assignedAboutToBreach');
  add('lead', rwa.id, 'lead_acceptance', -45, 75, 'running', rwa.owner_id, 0, { temperature: 'warm' });
  add('lead', hot.id, 'lead_acceptance', -22, 8, 'running', hot.owner_id, 0, { temperature: 'hot' });
  // overdue follow-ups
  for (const [k, level] of [['oppPmsg', 1], ['oppNetMetered', 1], ['oppCaptiveDnd', 2]] as [LeadKey, number][]) {
    const l = leadOf(k);
    add('lead', l.id, 'followup', -4 * DAY, -(level === 2 ? 3 : 1) * DAY, 'breached', l.owner_id, level);
  }
  add('lead', leadOf('oppRwa').id, 'followup', -DAY, DAY, 'running', leadOf('oppRwa').owner_id);
  // quote follow-up cadence and approval SLA
  add('quotation', I.quote.pendingH, 'approval', -DAY, 20 * HOUR, 'running', P.regional_head, 0, { lane: 'commercial' });
  // DISCOM clocks
  add('site_survey', surveyIdOf('siteVisitFeasibility'), 'discom_feasibility', -5 * DAY, 10 * DAY, 'running', P.distributor_user_b, 0, { discom: 'DGVCL', kw: 150 });
  add('site_survey', surveyIdOf('oppOpenAccess'), 'discom_feasibility', -12 * DAY, 3 * DAY, 'running', P.distributor_user_b, 0, { discom: 'DGVCL', kw: 290 });
  add('installation', I.installation.inst2, 'discom_commissioning', -25 * DAY, -10 * DAY, 'breached', P.dispatch, 1, { discom: 'UGVCL' });
  add('installation', I.installation.inst1, 'discom_commissioning', -36 * DAY, -21 * DAY, 'met', P.dispatch, 0);
  // subsidy
  add('subsidy_claim', demoId('subsidy-claim', 3), 'cfa_release', -15 * DAY, 0, 'running', P.accounts, 0, { note: 'DISCOM approval recorded; CFA release due in 15 days' });
  add('subsidy_claim', demoId('subsidy-claim', 3), 'legacy_cfa_claim_deadline', -40 * DAY, 0, 'running', P.accounts, 0, { deadline: '2026-11-30', confidence: 'medium' });
  add('subsidy_claim', demoId('subsidy-claim', 2), 'grievance', -3 * DAY, 27 * DAY, 'running', P.accounts, 0, { reason: 'photos_unclear rejection under review' });
  add('opportunity', I.opportunity.opE, 'almm_exemption_commissioning', -30 * DAY, 0, 'running', P.compliance_officer, 0, { until: '2026-12-31' });
  // SOP tracker
  add('sop_case', demoId('sop-case', 1), 'sop_reply', -12 * DAY, -4 * DAY, 'breached', P.compliance_officer, 1);
  add('sop_case', demoId('sop-case', 1), 'sop_show_cause', -3 * DAY, 3 * DAY, 'running', P.compliance_officer, 0);
  // finance, warranty, payments
  add('loan', demoId('loan', 2), 'loan_ageing', -6 * DAY, 24 * DAY, 'running', P.distributor_user, 0);
  add('warranty_ticket', demoId('warranty-ticket', 1), 'warranty_rma', -20 * DAY, 10 * DAY, 'running', P.dispatch, 0);
  add('sales_order', I.salesOrder.so5, 'payment_reminder', -2 * DAY, -3 * HOUR, 'breached', P.accounts, 1, { reminders_sent: 2 });
  return rows;
}

/* ───────────────────────── notifications ───────────────────────── */

export function buildNotifications(env: SeedEnv): NotificationRow[] {
  const rows: NotificationRow[] = [];
  const add = (target: { user?: string; role?: NotificationRow['target_role'] }, kind: string, title: string, body: string, severity: NotificationRow['severity'], link: string, entityType: string, entityId: string, agoMin: number, read: boolean): void => {
    rows.push({
      ...baseOf(env, demoId('notification', rows.length + 1), agoMin), user_id: target.user ?? null, target_role: target.role ?? null, kind, title, body, severity, link, entity_type: entityType, entity_id: entityId,
      read_at: read ? env.t(-agoMin + 20) : null,
    });
  };
  add({ user: P.distributor_user }, 'lead.sla_warning', 'Lead about to breach acceptance SLA', 'Jignesh Parmar (HOT) must be accepted in 8 minutes.', 'critical', `/leads/${I.lead.assignedAboutToBreach}`, 'lead', I.lead.assignedAboutToBreach, 6, false);
  add({ user: P.distributor_user }, 'lead.assigned', 'New lead assigned', 'Shreeji Residency CHS (Demo) — 45 kW RWA / GHS, Gandhinagar.', 'info', `/leads/${I.lead.assignedRwa}`, 'lead', I.lead.assignedRwa, 44, false);
  add({ user: P.dsm2 }, 'lead.unassigned', 'Lead has no eligible distributor', 'Vasant Industrial Works (Demo) in Vadodara — reassign the territory.', 'warning', `/leads/${I.lead.unassignedVadodara}`, 'lead', I.lead.unassignedVadodara, 170, false);
  add({ user: P.distributor_user }, 'followup.overdue', 'Follow-up overdue', 'Kavita Joshi — share the revised quotation.', 'warning', `/leads/${I.lead.oppPmsg}`, 'lead', I.lead.oppPmsg, 1300, false);
  add({ user: P.regional_head }, 'approval.pending', 'Approval waiting', 'Quotation Q-DEMO-P01 — 7 % discount, commercial lane step 2.', 'info', '/approvals', 'approval', I.quote.pendingH, 55, false);
  add({ role: 'compliance_officer' }, 'approval.pending', 'Compliance review requested', 'Quotation Q-DEMO-P01 needs compliance review.', 'info', '/approvals', 'approval', I.quote.pendingH, 50, false);
  add({ role: 'accounts' }, 'credit.override_requested', 'Credit override requested', 'Anand Rooftop Solutions is ₹ 2.5 lakh over its limit.', 'warning', `/dealers/${I.dealer.d1}`, 'dealer', I.dealer.d1, 1400, false);
  add({ role: 'accounts' }, 'calendar.countdown', 'Legacy CFA claim deadline in 35 days', 'Two legacy-cohort subsidy claims are still open: one ready, one rejected.', 'warning', '/post-sale?tab=subsidy', 'subsidy_claim', demoId('subsidy-claim', 3), 120, false);
  add({ role: 'compliance_officer' }, 'calendar.countdown', 'DPDP Consent Manager registration in 18 days', 'Review consent flows ahead of 13-Nov-2026.', 'info', '/calendar', 'calendar', refId('calendar', 1), 600, true);
  add({ role: 'dsm' }, 'dealer.bg_expiring', 'Bank guarantee expiring in 40 days', 'Gandhinagar Green Power (Demo) — renewal reminder.', 'warning', `/dealers/${I.dealer.d3}`, 'dealer', I.dealer.d3, 2880, true);
  add({ role: 'compliance_officer' }, 'sop.reply_overdue', 'MNRE SOP reply overdue', 'Complaint DEMO-SOP-2026-014 against Tapi Solar Installers (Demo) is past the 8-day reply date.', 'critical', `/dealers/${I.dealer.d4}`, 'sop_case', demoId('sop-case', 1), 3000, false);
  add({ user: P.dispatch }, 'dispatch.blocked', 'Dispatch blocked by compliance', 'DSP-DEMO-004 has serials whose cells are not on ALMM List-II (gate G4).', 'critical', `/dispatch/${I.dispatch.dsp4}`, 'dispatch', I.dispatch.dsp4, 90, false);
  add({ user: P.accounts }, 'order.on_hold', 'Sales order on hold', 'SO-DEMO-W5 is waiting for the 30 % advance.', 'warning', `/orders/${I.salesOrder.so5}`, 'sales_order', I.salesOrder.so5, 200, false);
  add({ role: 'compliance_officer' }, 'rule.requote_flagged', 'Open quotes flagged for re-quote', 'The ALMM snapshot of DS-N595-ST is stale; 1 open quote depends on it.', 'info', `/quotes/${I.quote.g10}`, 'quotation', I.quote.g10, 700, true);
  return rows;
}

/* ───────────────────────── message log ───────────────────────── */

export function buildMessageLog(env: SeedEnv, layer: LeadLayer): MessageLog[] {
  const rows: MessageLog[] = [];
  const consentOf = (lead: string): string | null => layer.consents.find((c) => c.lead_id === lead)?.id ?? null;
  const mobileOf = (lead: string): string => layer.leads.find((l) => l.id === lead)!.mobile;
  const add = (lead: LeadKey, channel: MessageChannel, purpose: MessagePurpose, category: TemplateCategory | null, template: string | null, status: MessageLog['status'], preview: string, agoMin: number, blockReason: string | null = null, direction: MessageLog['direction'] = 'outbound'): void => {
    const id = I.lead[lead];
    rows.push({
      id: demoId('message', rows.length + 1), org_id: env.org, created_at: env.t(-agoMin), lead_id: id, channel, purpose, category, template_key: template, direction, to_masked: maskMobile(mobileOf(id)), body_preview: preview, status,
      block_reason: blockReason, consent_id: status === 'blocked' ? null : consentOf(id), provider: status === 'blocked' ? null : 'mock', provider_ref: status === 'sent' ? `mock-${String(rows.length + 1).padStart(5, '0')}` : null, created_by: P.distributor_user,
    });
  };
  add('assignedAboutToBreach', 'whatsapp', 'transactional', 'utility', 'wa.acknowledgement', 'sent', 'Namaste Jignesh, thank you for your solar enquiry with Future Solar…', 20 * MIN);
  add('acceptedKusum', 'sms', 'transactional', 'utility', 'sms.acknowledgement', 'sent', 'Dear Ramesh, thank you for your solar enquiry with Future Solar…', 3 * HOUR);
  add('oppPmsg', 'whatsapp', 'transactional', 'utility', 'wa.quote_sent', 'sent', 'Namaste Kavita, your Future Solar quotation is ready…', 2 * DAY);
  add('oppPmsg', 'whatsapp', 'service', 'utility', 'wa.followup_reminder', 'sent', 'Namaste Kavita, this is a reminder from Future Solar…', DAY);
  add('contactedOptedOut', 'whatsapp', 'promotional', 'marketing', null, 'sent', 'Brochure and bill-upload link', 6 * DAY);
  add('contactedOptedOut', 'whatsapp', 'service', 'service', 'wa.optout_confirmation', 'sent', 'You have been opted out of messages from Future Solar…', 5 * DAY - 2);
  add('contactedOptedOut', 'whatsapp', 'promotional', 'marketing', null, 'blocked', 'Subsidy deadline reminder', 2 * DAY, 'G1: within the 90-day opt-out suppression period');
  add('newNoConsent', 'whatsapp', 'promotional', 'marketing', null, 'blocked', 'Welcome message', 15 * MIN, 'G1: no consent record on file');
  add('oppCaptiveDnd', 'sms', 'promotional', 'marketing', 'sms.promo_subsidy_deadline', 'blocked', 'Subsidy and ALMM deadlines are near…', DAY, 'G1: mobile is on the DND register');
  add('nurture', 'sms', 'promotional', 'marketing', 'sms.promo_subsidy_deadline', 'blocked', 'Subsidy and ALMM deadlines are near…', 3 * HOUR, 'G1: DND scrub is older than 30 days — scrub again before sending');
  add('oppPmsg', 'whatsapp', 'service', 'service', null, 'sent', 'Thanks, I have received the bill photo.', 4 * DAY, null, 'inbound');
  add('won5', 'whatsapp', 'transactional', 'utility', 'wa.payment_reminder', 'sent', 'Namaste Lalji, a payment of ₹ … against proforma invoice PI-DEMO-W5 is due…', 30 * HOUR);
  add('won5', 'sms', 'transactional', 'utility', 'sms.payment_reminder', 'failed', 'Dear Lalji, Rs … against proforma invoice … is due…', 6 * HOUR);
  return rows;
}

/* ───────────────────────── jobs, KPIs, audit, incidents, requests ───────────────────────── */

export function buildJobRuns(env: SeedEnv): JobRun[] {
  const rows: JobRun[] = [];
  const add = (name: string, agoMin: number, durationSec: number, status: JobRun['status'], details: JobRun['details']): void => {
    rows.push({ ...baseOf(env, demoId('job-run', rows.length + 1), agoMin), job_name: name, started_at: env.t(-agoMin), finished_at: status === 'running' ? null : env.t(-agoMin + Math.ceil(durationSec / 60)), status, details });
  };
  add('clock_tick', 1, 2, 'ok', { running: 20, warned: 2, breached: 5 });
  add('nightly_requote_scan', 9 * HOUR, 40, 'ok', { rules_changed: 0, quotes_flagged: 0 });
  add('retention_scan', 9 * HOUR + 10, 25, 'ok', { candidates: 0, mode: 'report_only' });
  add('dnd_rescrub', 14 * HOUR, 120, 'ok', { scrubbed: 18, registered: 1 });
  add('kpi_snapshot', 9 * HOUR + 20, 15, 'ok', { kpis: 6 });
  add('breach_watch', 3 * HOUR, 1, 'failed', { error: 'Notification service timed out (demo)', retry: true });
  return rows;
}

export function buildKpis(env: SeedEnv): KpiSnapshot[] {
  const rows: KpiSnapshot[] = [];
  const period = env.d(0).slice(0, 7);
  const add = (key: string, value: number, dims: KpiSnapshot['dims'] = {}): void => {
    rows.push({ ...baseOf(env, demoId('kpi', rows.length + 1), 9 * HOUR), kpi_key: key, period, value, dims, computed_at: env.t(-9 * HOUR) });
  };
  add('funnel.inquiry_to_qualified_pct', 61.5);
  add('funnel.qualified_to_opportunity_pct', 54.2);
  add('funnel.opportunity_to_quotation_pct', 88.9);
  add('funnel.quotation_to_pi_pct', 31.3);
  add('lead.first_response_24h_pct', 82.6);
  add('lead.acceptance_sla_met_pct', 76.9, { segment: 'all' });
  add('consent.coverage_pct', 91.3);
  add('compliance.block_rate_pct', 43.8);
  return rows;
}

export function buildAuditLog(env: SeedEnv): AuditLog[] {
  const rows: AuditLog[] = [];
  const add = (actor: string | null, action: string, table: string, record: string, agoMin: number, detail: AuditLog['detail'], oldData: AuditLog['old_data'] = null, newData: AuditLog['new_data'] = null): void => {
    rows.push({ id: demoId('audit', rows.length + 1), org_id: env.org, created_at: env.t(-agoMin), actor_id: actor, action, table_name: table, record_id: record, old_data: oldData, new_data: newData, detail, source: 'api', request_id: `demo-req-${String(rows.length + 1).padStart(4, '0')}`, ip: '203.0.113.10' });
  };
  add(P.distributor_user_c, 'lead.accept', 'leads', I.lead.acceptedKusum, 40, { reason: 'Within SLA after reassignment' }, { status: 'assigned' }, { status: 'accepted' });
  add(P.compliance_officer, 'rule.activate', 'rule_config', 'demo-rule', 2 * DAY, { path: 'pmsg.dcr_required_for_cfa', note: 'Activated as hard stop (demo entry)' });
  add(P.accounts, 'credit.override_decided', 'credit_overrides', I.creditOverride.approved, 19 * DAY, { decision: 'approved' }, { status: 'pending' }, { status: 'approved' });
  add(P.management, 'quote.approval_rejected', 'quotations', I.quote.w2v1, 75 * DAY, { lane: 'commercial', step: 3, reason: 'Margin too thin at 12 %' });
  add(P.accounts, 'lead.reveal_mobile', 'leads', I.lead.oppPmsg, 3 * DAY, { reason: 'Payment follow-up call' });
  add(P.admin, 'consent.withdrawn', 'lead_consents', I.lead.contactedOptedOut, 5 * DAY, { channel: 'whatsapp_stop', suppress_until: env.d(85), propagated_to: ['Suryamitra Energy Distribution Pvt. Ltd. (Demo)', 'Hazira Industrial Solar (Demo)'] });
  return rows;
}

export function buildBreachIncidents(env: SeedEnv): BreachIncident[] {
  return [{
    ...baseOf(env, demoId('breach', 1), 20 * HOUR, P.compliance_officer), title: 'Quotation PDF sent to a wrong WhatsApp number (demo)', description: 'A quotation PDF for a demo customer was sent to a number with one transposed digit. The recipient has been asked to delete it.',
    detected_at: env.t(-20 * HOUR), report_due_at: env.t(52 * HOUR), status: 'open', evidence: [
      { at: env.t(-20 * HOUR), by: P.compliance_officer, note: 'Incident logged from the message log; recipient number masked in all records.' },
      { at: env.t(-18 * HOUR), by: P.dsm, note: 'Customer informed by phone; recipient confirmed deletion.' },
    ], reported_at: null,
  }];
}

export function buildDataRequests(env: SeedEnv): DataRequest[] {
  return [
    { ...baseOf(env, demoId('data-request', 1), 2 * DAY, P.compliance_officer), lead_id: I.lead.contactedOptedOut, customer_id: null, kind: 'export', status: 'requested', requested_at: env.t(-2 * DAY), completed_at: null, notes: 'Customer asked for a copy of their data after opting out.' },
    { ...baseOf(env, demoId('data-request', 2), 10 * DAY, P.compliance_officer), lead_id: I.lead.lost, customer_id: null, kind: 'erasure', status: 'requested', requested_at: env.t(-10 * DAY), completed_at: null, notes: 'Trust asked for erasure after the tender was lost; no open order exists.' },
    { ...baseOf(env, demoId('data-request', 3), 30 * DAY, P.compliance_officer), lead_id: I.lead.nurture, customer_id: null, kind: 'export', status: 'completed', requested_at: env.t(-30 * DAY), completed_at: env.t(-28 * DAY), notes: 'Export delivered as a spreadsheet by e-mail.' },
  ];
}
