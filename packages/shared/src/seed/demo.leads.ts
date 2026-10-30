import type { ConsentChannel, ConsentPurpose, ContactChannel, ContactOutcome, FeasibilityStatus, FollowupKind, FollowupStatus, LeadStatus } from '../enums';
import { groupIndian } from '../format';
import { hashMobile } from '../ids';
import type {
  ContactLog, Customer, DndRegister, Followup, Lead, LeadAssignment, LeadConsent, LeadEvent, LeadScore, LeadScoreComponent, Site, SiteSurvey,
} from '../rows';
import { DEMO_IDS } from './demo.ids';
import { buildDealers, buildDistributors, fakeGstin, fakePan } from './demo.people';
import { districtOf, LEAD_SPECS, SITE_LEAD_KEYS, type LeadKey, type LeadSpec, type Step } from './demo.leads.data';
import { baseOf, DAY, demoId, fakeMobile, round2, type SeedEnv } from './util';

const I = DEMO_IDS;
const P = DEMO_IDS.profile;

/* ───────────────────────── lookups shared with the pipeline ───────────────────────── */

export const OPP_OF_LEAD: Partial<Record<LeadKey, string>> = {
  oppPmsg: I.opportunity.opA, oppPmsgOverLimit: I.opportunity.opB, oppRwa: I.opportunity.opC, oppNetMetered: I.opportunity.opD, oppOpenAccess: I.opportunity.opE,
  oppKusum: I.opportunity.opF, oppCaptiveDnd: I.opportunity.opG, oppGovernment: I.opportunity.opH,
  won1: I.opportunity.w1, won2: I.opportunity.w2, won3: I.opportunity.w3, won4: I.opportunity.w4, won5: I.opportunity.w5,
};
export const customerIdOf = (key: LeadKey): string => demoId('customer', SITE_LEAD_KEYS.indexOf(key) + 1);
export const siteIdOf = (key: LeadKey): string => demoId('site', SITE_LEAD_KEYS.indexOf(key) + 1);
export const surveyIdOf = (key: LeadKey): string => demoId('survey', SITE_LEAD_KEYS.indexOf(key) + 1);
export const hasSite = (key: LeadKey): boolean => SITE_LEAD_KEYS.includes(key);
const mobileOf = (spec: LeadSpec): string => fakeMobile(LEAD_SPECS.indexOf(spec) + 1);
export const leadMobile = (key: LeadKey): string => fakeMobile(LEAD_SPECS.findIndex((s) => s.key === key) + 1);

/* ───────────────────────── lead score (Appendix A of the engineering brief) ───────────────────────── */

export const SCORE_WEIGHTS = { requirement_clarity: 20, mw_size: 15, timeline: 25, budget: 15, decision_maker: 10, consent_present: 10, bill_captured: 5 } as const;

export function computeLeadScore(l: Pick<Lead, 'requirement_text' | 'segment' | 'capacity_kw' | 'timeline_bucket' | 'budget_inr' | 'decision_maker' | 'decision_maker_access' | 'bill_captured'>, hasActiveConsent: boolean): { score: number; components: LeadScoreComponent[] } {
  const len = (l.requirement_text ?? '').trim().length;
  const clarity = (len >= 20 ? 0.6 : len >= 1 ? 0.3 : 0) + (l.segment ? 0.2 : 0) + (l.capacity_kw !== null ? 0.2 : 0);
  const kw = l.capacity_kw;
  const mw = kw === null ? 0 : kw < 3 ? 0.3 : kw < 10 ? 0.5 : kw < 100 ? 0.75 : 1;
  const tl = ({ immediate: 1, within_30_days: 0.9, one_to_three_months: 0.6, three_to_six_months: 0.3, six_months_plus: 0.1, unknown: 0 } as const)[l.timeline_bucket ?? 'unknown'];
  const budget = l.budget_inr === null ? 0 : kw !== null && l.budget_inr >= 40_000 * kw ? 1 : 0.6;
  const dmBase = l.decision_maker === 'self' ? 1 : l.decision_maker === 'family' ? 0.8 : l.decision_maker === 'committee' ? 0.5 : 0;
  const dm = l.decision_maker_access === false ? dmBase * 0.5 : dmBase;
  const factors: [keyof typeof SCORE_WEIGHTS, string, number, string][] = [
    ['requirement_clarity', 'Requirement clarity', clarity, `Requirement text ${len} characters${l.segment ? ', segment set' : ''}${kw !== null ? ', capacity set' : ''}`],
    ['mw_size', 'System size', mw, kw === null ? 'Capacity not captured' : `${kw} kW`],
    ['timeline', 'Timeline', tl, `Timeline: ${l.timeline_bucket ?? 'not captured'}`],
    ['budget', 'Budget', budget, l.budget_inr === null ? 'Budget not captured' : `Budget ₹ ${groupIndian(l.budget_inr)}`],
    ['decision_maker', 'Decision maker', dm, `Decision maker: ${l.decision_maker ?? 'unknown'}${l.decision_maker_access === false ? ' (no access)' : ''}`],
    ['consent_present', 'Consent present', hasActiveConsent ? 1 : 0, hasActiveConsent ? 'Active consent on file' : 'No active consent'],
    ['bill_captured', 'Bill captured', l.bill_captured ? 1 : 0, l.bill_captured ? 'Electricity bill captured' : 'No bill yet'],
  ];
  const components = factors.map(([key, label, factor, note]) => ({ key, label, weight: SCORE_WEIGHTS[key], points: round2(SCORE_WEIGHTS[key] * factor), note }));
  return { score: Math.round(factors.reduce((s, [key, , f]) => s + SCORE_WEIGHTS[key] * f, 0)), components };
}

/* ───────────────────────── lead timeline ───────────────────────── */

const STEP_ORDER: Step[] = ['captured', 'validated', 'assigned', 'accepted', 'contacted', 'qualified', 'site_visit', 'opportunity', 'won'];
const RANK: Record<LeadStatus, number> = { new: 0, validated: 1, duplicate: 0, merged: 0, unassigned: 1, assigned: 2, accepted: 3, contacted: 4, qualified: 5, site_visit: 6, nurture: 5, opportunity: 7, lost: 5, won: 8 };

/** minutes ago for each milestone the lead has reached */
function milestones(s: LeadSpec): Partial<Record<Step, number>> {
  const rank = RANK[s.status];
  const out: Partial<Record<Step, number>> = {};
  STEP_ORDER.slice(0, rank + 1).forEach((step, i) => {
    out[step] = s.fixed?.[step] ?? Math.round(s.ageMin - (s.ageMin * i) / (rank + 1));
  });
  return out;
}

const SOURCE_LABEL: Record<string, string> = { website: 'the website form', call_centre: 'the call centre', whatsapp: 'WhatsApp', campaign: 'a campaign form', referral: 'a referral', dealer_upload: 'a dealer upload', manual: 'manual entry' };
const CAPTURE_SOURCE: Record<string, string> = { website: 'web_form', call_centre: 'call_script', whatsapp: 'whatsapp_optin', campaign: 'campaign_form', referral: 'referral_form', dealer_upload: 'dealer_upload', manual: 'manual_entry' };

function lastActionOf(s: LeadSpec, dist: string): { last: string; next: string } {
  switch (s.status) {
    case 'new': return { last: 'Lead captured', next: 'Validate and assign' };
    case 'unassigned': return { last: 'No eligible distributor in the territory', next: 'DSM to reassign the territory' };
    case 'assigned': return { last: `Assigned to ${dist}`, next: 'Distributor to accept the lead' };
    case 'accepted': return { last: 'Accepted by the distributor', next: 'Make the first customer contact' };
    case 'contacted': return { last: 'First contact made by call', next: 'Hold the qualification call' };
    case 'qualified': return { last: 'Qualification call completed', next: 'Schedule the site visit' };
    case 'site_visit': return { last: 'Site visit completed', next: 'Complete the requirement form and DISCOM feasibility' };
    case 'nurture': return { last: 'Moved to nurture', next: 'Re-engage on the nurture date' };
    case 'opportunity': return { last: 'Opportunity created', next: 'Work the quotation' };
    case 'lost': return { last: 'Marked lost', next: 'Review for recycle after 90 days' };
    case 'won': return { last: 'Sales order created', next: 'Hand over to installation and subsidy follow-up' };
    default: return { last: 'Updated', next: 'Review' };
  }
}

/* ───────────────────────── follow-ups and contact logs ───────────────────────── */

interface FollowupSeed { lead: LeadKey; kind: FollowupKind; dueMin: number; status: FollowupStatus; note: string; outcome?: string; escalated?: number }

const FOLLOWUP_SEEDS: FollowupSeed[] = [
  { lead: 'unassignedVadodara', kind: 'task', dueMin: 60, status: 'open', note: 'DSM to assign a distributor for the Vadodara territory.' },
  { lead: 'assignedRwa', kind: 'call', dueMin: 75, status: 'open', note: 'Accept the lead and call the society secretary.' },
  { lead: 'assignedAboutToBreach', kind: 'call', dueMin: 8, status: 'open', note: 'HOT lead — accept and call the customer now.' },
  { lead: 'acceptedKusum', kind: 'call', dueMin: 30, status: 'open', note: 'First contact: confirm the sanction letter and pump size.' },
  { lead: 'contactedOptedOut', kind: 'call', dueMin: -6 * DAY, status: 'done', note: 'Qualification call.', outcome: 'Customer asked to be left alone after the second message.' },
  { lead: 'contactedOptedOut', kind: 'whatsapp', dueMin: -2 * DAY, status: 'cancelled', note: 'Follow-up message — cancelled because the customer opted out.' },
  { lead: 'qualifiedOpenAccess', kind: 'visit', dueMin: DAY, status: 'open', note: 'Schedule the site visit with the plant engineer.' },
  { lead: 'siteVisitFeasibility', kind: 'task', dueMin: 2 * DAY, status: 'open', note: 'Chase the DGVCL feasibility response (15-day clock running).' },
  { lead: 'nurture', kind: 'call', dueMin: 120 * DAY, status: 'open', note: 'Re-engage after the monsoon roof repair.' },
  { lead: 'oppPmsg', kind: 'call', dueMin: -DAY, status: 'open', note: 'Share the revised quotation and confirm the legacy CFA timeline.' },
  { lead: 'oppPmsgOverLimit', kind: 'call', dueMin: -2 * DAY, status: 'open', note: 'Discuss payment terms — dealer credit position under review.', escalated: 1 },
  { lead: 'oppRwa', kind: 'visit', dueMin: DAY, status: 'open', note: 'Present the quotation to the society committee.' },
  { lead: 'oppNetMetered', kind: 'call', dueMin: -DAY, status: 'open', note: 'Follow up on the quotation sent on day 1.' },
  { lead: 'oppOpenAccess', kind: 'email', dueMin: 2 * DAY, status: 'open', note: 'Send the revised commissioning plan.' },
  { lead: 'oppKusum', kind: 'call', dueMin: DAY, status: 'open', note: 'Confirm land record and bill name before the quotation.' },
  { lead: 'oppCaptiveDnd', kind: 'call', dueMin: -3 * DAY, status: 'open', note: 'Promotional contact barred (DND) — call only on the service number about the quotation.', escalated: 1 },
  { lead: 'oppGovernment', kind: 'task', dueMin: 3 * DAY, status: 'open', note: 'Submit the techno-commercial bid documents.' },
  { lead: 'won5', kind: 'task', dueMin: -DAY, status: 'open', note: 'Remind the customer about the advance on the proforma invoice.', escalated: 1 },
];

function contactLogsFor(env: SeedEnv, s: LeadSpec, ms: Partial<Record<Step, number>>, rows: ContactLog[]): void {
  const contacted = ms.contacted;
  if (contacted === undefined) return;
  const by = s.owner;
  const add = (channel: ContactChannel, direction: ContactLog['direction'], outcome: ContactOutcome, notes: string, agoMin: number, duration: number | null): void => {
    rows.push({ ...baseOf(env, demoId('contact-log', rows.length + 1), agoMin, by), lead_id: I.lead[s.key], channel, direction, outcome, notes, duration_min: duration, occurred_at: env.t(-agoMin), logged_by: by });
  };
  switch (s.key) {
    case 'contactedOptedOut':
      add('call', 'outbound', 'connected_interested', 'Explained the PM Surya Ghar subsidy; customer will discuss with the family.', contacted, 9);
      add('whatsapp', 'outbound', 'message_delivered', 'Sent the brochure and bill-upload link.', contacted - 2 * DAY, null);
      add('whatsapp', 'inbound', 'message_replied', 'Customer replied STOP — all consents withdrawn, 90-day suppression started.', 5 * DAY, null);
      return;
    case 'nurture':
      add('call', 'outbound', 'connected_not_now', 'Roof repair planned; asked to call after the monsoon.', contacted, 4);
      add('call', 'outbound', 'no_answer', 'No answer on the follow-up call.', contacted - 10 * DAY, null);
      return;
    case 'siteVisitFeasibility':
      add('call', 'outbound', 'connected_interested', 'Plant manager interested; asked for a site visit.', contacted, 12);
      add('visit', 'outbound', 'visit_done', 'Roof inspected; DGVCL feasibility application filed.', 6 * DAY, 90);
      add('whatsapp', 'outbound', 'message_replied', 'Customer sent the SLD and last three bills.', 5 * DAY, null);
      return;
    case 'qualifiedOpenAccess':
      add('call', 'outbound', 'connected_interested', 'Discussed open-access economics and the 31-Dec-2026 List-II window.', contacted, 25);
      add('email', 'outbound', 'message_delivered', 'Sent the qualification checklist.', contacted - DAY, null);
      add('call', 'outbound', 'connected_interested', 'Qualification call: contracted demand 2,500 kVA, board approval within 30 days.', 3 * DAY, 30);
      return;
    case 'lost':
      add('call', 'outbound', 'connected_interested', 'Tender discussion with the trust office.', contacted, 15);
      add('call', 'outbound', 'connected_not_interested', 'Trust informed us the tender went to another bidder.', 20 * DAY, 3);
      return;
    default:
      add('call', 'outbound', 'connected_interested', 'First contact: requirement and timeline confirmed.', contacted, 10);
      add(s.source === 'whatsapp' ? 'whatsapp' : 'call', 'outbound', s.status === 'won' ? 'connected_interested' : 'message_delivered', 'Follow-up with the quotation details.', Math.max(60, Math.round(contacted / 2)), s.source === 'whatsapp' ? null : 6);
  }
}

/* ───────────────────────── builders ───────────────────────── */

export interface LeadLayer {
  leads: Lead[];
  consents: LeadConsent[];
  events: LeadEvent[];
  assignments: LeadAssignment[];
  followups: Followup[];
  contactLogs: ContactLog[];
  dnd: DndRegister[];
  scores: LeadScore[];
  customers: Customer[];
  sites: Site[];
  surveys: SiteSurvey[];
}

const SITE_GEO: Record<string, [number, number]> = { Ahmedabad: [23.0225, 72.5714], Gandhinagar: [23.2156, 72.6369], Surat: [21.1702, 72.8311], Vadodara: [22.3072, 73.1812], Rajkot: [22.3039, 70.8022] };
const DISCOM_OF_TERRITORY: Record<string, string> = {
  [I.territory.ahmedabad]: I.discom.torrent, [I.territory.gandhinagar]: I.discom.ugvcl, [I.territory.surat]: I.discom.dgvcl, [I.territory.vadodara]: I.discom.mgvcl, [I.territory.rajkot]: I.discom.pgvcl,
};
const FEASIBILITY: Partial<Record<LeadKey, { status: FeasibilityStatus; sub: number; comp: number; due: number }>> = {
  siteVisitFeasibility: { status: 'pending', sub: -6, comp: -5, due: 10 }, oppRwa: { status: 'approved', sub: -25, comp: -24, due: -9 }, oppNetMetered: { status: 'approved', sub: -30, comp: -29, due: -14 },
  oppOpenAccess: { status: 'pending', sub: -13, comp: -12, due: 3 }, oppCaptiveDnd: { status: 'deemed', sub: -20, comp: -19, due: -4 }, oppGovernment: { status: 'approved', sub: -34, comp: -33, due: -18 },
  won4: { status: 'approved', sub: -70, comp: -69, due: -54 },
};

export function buildLeadLayer(env: SeedEnv): LeadLayer {
  const distributors = buildDistributors(env);
  const distNames = new Map(distributors.map((d) => [d.id, d.legal_name]));
  const distScores = new Map(distributors.map((d) => [d.id, d.score]));
  const dealerNames = new Map(buildDealers(env).map((d) => [d.id, d.legal_name]));
  const out: LeadLayer = { leads: [], consents: [], events: [], assignments: [], followups: [], contactLogs: [], dnd: [], scores: [], customers: [], sites: [], surveys: [] };
  const leadIdByKey = (key: LeadKey): string => I.lead[key];

  LEAD_SPECS.forEach((s, idx) => {
    const n = idx + 1;
    const id = leadIdByKey(s.key);
    const ms = milestones(s);
    const ago = (step: Step): string | null => (ms[step] === undefined ? null : env.t(-(ms[step] as number)));
    const distName = s.dist ? (distNames.get(s.dist) ?? 'the distributor') : '';
    const hasActiveConsent = s.consent === 'standard' || s.consent === 'service_only';
    const { last, next } = lastActionOf(s, distName);
    const lastStep = STEP_ORDER.slice(0, RANK[s.status] + 1).reverse().find((st) => ms[st] !== undefined) ?? 'captured';
    const afterQualified = Math.max(1, (ms.qualified ?? s.ageMin) - 240);
    const lastActionAgo = s.status === 'lost' || s.status === 'nurture' ? afterQualified : (ms[lastStep] ?? s.ageMin);
    const own = FOLLOWUP_SEEDS.filter((f) => f.lead === s.key && f.status === 'open').sort((a, b) => a.dueMin - b.dueMin)[0];
    const slaMinutes = s.temp === 'hot' ? 30 : s.temp === 'warm' ? 120 : 480;
    const assignedAt = ago('assigned');
    const dnd = s.dnd;

    const lead: Lead = {
      ...baseOf(env, id, s.ageMin, s.source === 'manual' || s.source === 'call_centre' ? s.owner : null),
      source: s.source, source_ref: `${CAPTURE_SOURCE[s.source]}-demo-${String(n).padStart(3, '0')}`, source_detail: s.source === 'campaign' ? { campaign: 'rooftop-oct-2026', medium: 'meta' } : s.source === 'website' ? { utm_source: 'google', page: '/rooftop-solar' } : {},
      notice_version: s.consent === 'none' ? null : 'v1',
      name: s.name, mobile: mobileOf(s), email: s.email, pincode: s.pin, city: s.city, district: districtOf(s.city), state: 'Gujarat',
      segment: s.segment, customer_type: s.ctype, capacity_kw: s.kw, product_interest: s.segment === 'pm_kusum' ? ['solar_pump'] : s.ctype === 'residential' ? ['modules', 'inverter', 'structure'] : ['modules', 'inverter', 'structure', 'monitoring'],
      status: s.status, temperature: s.temp, quality_score: null,
      owner_id: s.owner, distributor_id: s.dist, dealer_id: s.dealer, territory_id: s.territory,
      customer_id: hasSite(s.key) ? customerIdOf(s.key) : null, site_id: hasSite(s.key) ? siteIdOf(s.key) : null, consumer_no: hasSite(s.key) ? `DEMO-CN-${String(n).padStart(6, '0')}` : null,
      last_action: last, last_action_at: env.t(-lastActionAgo), next_action: next, next_followup_at: own ? env.t(own.dueMin) : s.status === 'new' ? env.t(30) : null,
      assigned_at: assignedAt, accepted_at: ago('accepted'), sla_due_at: assignedAt ? env.t(-(ms.assigned as number) + slaMinutes) : null, first_contacted_at: ago('contacted'),
      language: s.lang, lock_status: s.locked ? 'locked' : 'open', locked_by_dealer_id: s.locked ? s.dealer : null, duplicate_of: null,
      dnd_status: dnd, dnd_checked_at: s.dndAgeDays !== undefined ? env.t(-s.dndAgeDays * DAY) : null,
      requirement_text: s.req, timeline_bucket: s.timeline, budget_inr: s.budget, decision_maker: s.dm, decision_maker_access: s.access,
      bill_captured: s.bill, nurture_until: s.nurtureInDays !== undefined ? env.d(s.nurtureInDays) : null, nurture_reason: s.nurtureReason ?? null, lost_reason: s.lostReason ?? null,
      notes: s.key === 'oppCaptiveDnd' ? 'Registered on the DND preference register — promotional contact is blocked; service contact about the open quotation is allowed.' : s.key === 'newNoConsent' ? 'Captured by a call-centre agent without a consent record — obtain consent before any outbound message.' : null,
      deadline_uplift: s.uplift ?? false, anonymised_at: null, deleted_at: null,
    };

    // score + consent first: the score needs to know whether an active consent exists
    if (s.status !== 'new') {
      const sc = computeLeadScore(lead, hasActiveConsent);
      lead.quality_score = sc.score;
      out.scores.push({ ...baseOf(env, demoId('lead-score', out.scores.length + 1), Math.min(s.ageMin, 2 * DAY)), lead_id: id, score: sc.score, components: sc.components, computed_at: env.t(-Math.min(s.ageMin, 2 * DAY)) });
    }
    out.leads.push(lead);

    // consent ledger
    if (s.consent !== 'none') {
      const purposes: ConsentPurpose[] = s.consent === 'service_only' ? ['service', 'quotation'] : ['service', 'quotation', 'promotional'];
      if (s.consent !== 'service_only' && (s.segment === 'pmsg_residential' || s.segment === 'rwa_ghs' || s.segment === 'pm_kusum')) purposes.push('subsidy_processing');
      if (s.key === 'won2') purposes.push('financing');
      const channels: ConsentChannel[] = s.consent === 'service_only' ? ['call', 'whatsapp'] : ['call', 'whatsapp', 'sms'];
      const recipients = [s.dist ? distNames.get(s.dist) : undefined, s.dealer ? dealerNames.get(s.dealer) : undefined].filter((x): x is string => !!x);
      const web = s.source === 'website' || s.source === 'campaign';
      out.consents.push({
        ...baseOf(env, demoId('lead-consent', out.consents.length + 1), s.ageMin - 1), lead_id: id, notice_version: 'v1', purposes, channels, recipients_named: recipients,
        granted_at: env.t(-(s.ageMin - 1)), ip: web ? `203.0.113.${n}` : null, user_agent: web ? 'Mozilla/5.0 (Linux; Android 14) DemoBrowser/1.0' : null,
        proof_ref: `consent-proof/demo/${String(n).padStart(3, '0')}.json`, capture_source: CAPTURE_SOURCE[s.source] ?? 'manual_entry',
        withdrawn_at: s.consent === 'withdrawn' ? env.t(-5 * DAY) : null, withdrawn_by: null, withdrawal_channel: s.consent === 'withdrawn' ? 'whatsapp_stop' : null,
        optout_suppress_until: s.consent === 'withdrawn' ? env.t(85 * DAY) : null,
      });
    }

    // timeline
    const ev = (type: string, summary: string, agoMin: number, actor: string | null, detail: Lead['source_detail'] = {}): void => {
      out.events.push({ id: demoId('lead-event', out.events.length + 1), org_id: env.org, created_at: env.t(-agoMin), lead_id: id, event_type: type, summary, actor_id: actor, detail });
    };
    const rank = RANK[s.status];
    ev('captured', `Lead captured from ${SOURCE_LABEL[s.source] ?? s.source}`, ms.captured ?? s.ageMin, null, { source: s.source });
    ev(s.consent === 'none' ? 'consent_missing' : 'consent_recorded', s.consent === 'none' ? 'No consent record on file — outbound messages are blocked' : 'Consent recorded (notice v1)', (ms.captured ?? s.ageMin) - 1, null);
    if (dnd === 'registered') ev('dnd_flagged', 'Mobile is on the DND register — promotional contact blocked', (ms.captured ?? s.ageMin) - 2, null);
    if (rank >= 1) ev('validated', 'Mobile, e-mail and duplicate checks passed', ms.validated ?? s.ageMin, null);
    if (s.status === 'unassigned') ev('unassigned', 'No eligible distributor in the Vadodara territory — escalated to the DSM', Math.max(1, (ms.validated ?? 1) - 1), null);
    if (rank >= 2 && s.dist) ev('assigned', `Auto-assigned to ${distName}`, ms.assigned ?? s.ageMin, null, { distributor_id: s.dist });
    if (s.key === 'acceptedKusum') {
      ev('reminder_sent', 'Acceptance reminder sent — SLA missed by the first distributor', 150, null);
      ev('reassigned', 'Auto-reassigned to the next best distributor', 158, null);
    }
    if (rank >= 3) ev('accepted', `Accepted by ${distName}`, ms.accepted ?? s.ageMin, s.owner);
    if (rank >= 4) ev('contacted', 'First contact made by call', ms.contacted ?? s.ageMin, s.owner);
    if (s.key === 'contactedOptedOut') {
      ev('consent_withdrawn', 'Customer replied STOP — all consents withdrawn', 5 * DAY, null, { channel: 'whatsapp' });
      ev('suppression_propagated', '90-day promotional suppression applied and shared with the named distributor and dealer', 5 * DAY - 1, null, { until: env.d(85) });
    }
    if (rank >= 5 && s.status !== 'contacted') ev('qualified', 'Qualification call completed; quality score computed', ms.qualified ?? s.ageMin, s.owner, { score: lead.quality_score });
    if (rank >= 6 && s.status !== 'nurture' && s.status !== 'lost') ev('site_visit', 'Site visit completed', ms.site_visit ?? s.ageMin, s.owner);
    if (s.status === 'nurture') ev('moved_to_nurture', `Moved to nurture until ${env.d(s.nurtureInDays ?? 0)}: ${s.nurtureReason ?? ''}`, afterQualified, s.owner);
    if (s.status === 'lost') ev('lost', `Marked lost: ${s.lostReason ?? ''}`, afterQualified, s.owner);
    if (rank >= 7) ev('opportunity_created', 'Converted to opportunity — requirement, timeline and commercial potential confirmed', ms.opportunity ?? s.ageMin, s.owner);
    if (rank >= 8) ev('won', 'Sales order created', ms.won ?? s.ageMin, s.owner);

    // assignments
    if (s.dist) {
      const assignedMin = ms.assigned ?? s.ageMin;
      const base = (kind: number, distributor: string, status: LeadAssignment['status'], step: LeadAssignment['step'], reason: string, agoMin: number, responded: number | null): LeadAssignment => ({
        ...baseOf(env, demoId('lead-assignment', out.assignments.length + kind), agoMin), lead_id: id, distributor_id: distributor, dealer_id: s.dealer, assigned_to: P.dsm, step, status, reason,
        assigned_at: env.t(-agoMin), due_at: env.t(-agoMin + slaMinutes), responded_at: responded === null ? null : env.t(-responded), score_snapshot: { distributor_score: distScores.get(distributor) ?? null, basis: 'territory, capacity band, capability tags, score' },
      });
      if (s.key === 'acceptedKusum') {
        out.assignments.push(base(1, I.distributor.suryamitra, 'expired', 'auto', 'No response within the acceptance SLA', 280, null));
        out.assignments.push(base(1, I.distributor.saurashtra, 'accepted', 'reassignment', 'Auto-reassignment to the next best distributor', assignedMin, ms.accepted ?? 40));
      } else if (rank >= 3) {
        out.assignments.push(base(1, s.dist, 'accepted', 'auto', 'Territory, capacity band and capability match', assignedMin, ms.accepted ?? assignedMin));
      } else {
        out.assignments.push(base(1, s.dist, 'pending', 'auto', 'Territory, capacity band and capability match', assignedMin, null));
      }
    }

    // contact logs
    contactLogsFor(env, s, ms, out.contactLogs);

    // DND register
    if (dnd !== 'unchecked') {
      out.dnd.push({ ...baseOf(env, demoId('dnd', out.dnd.length + 1), (s.dndAgeDays ?? 1) * DAY), mobile_hash: hashMobile(lead.mobile), status: dnd === 'registered' ? 'registered' : 'clear', checked_at: env.t(-(s.dndAgeDays ?? 1) * DAY), source: 'demo-dnd-registry-mock' });
    }
  });

  // follow-ups
  FOLLOWUP_SEEDS.forEach((f) => {
    const spec = LEAD_SPECS.find((x) => x.key === f.lead)!;
    const due = f.dueMin;
    out.followups.push({
      ...baseOf(env, demoId('followup', out.followups.length + 1), Math.max(60, Math.abs(due))), lead_id: I.lead[f.lead], kind: f.kind, due_at: env.t(due), note: f.note, status: f.status,
      done_at: f.status === 'done' ? env.t(due + 30) : null, owner_id: spec.owner, outcome: f.outcome ?? null, reminder_sent_at: due < 0 && f.status === 'open' ? env.t(due + 60) : null, escalated_level: f.escalated ?? 0,
    });
  });

  // customers, sites, surveys
  SITE_LEAD_KEYS.forEach((key, i) => {
    const s = LEAD_SPECS.find((x) => x.key === key)!;
    const n = LEAD_SPECS.indexOf(s) + 1;
    const company = s.ctype !== 'residential' && s.ctype !== 'farmer';
    const pan = company ? fakePan('DMCUS', i + 1, 'C') : null;
    const addr = { line1: `${7 + i * 3}, Demo Nagar`, city: s.city, district: districtOf(s.city), state: 'Gujarat', pincode: s.pin };
    out.customers.push({
      ...baseOf(env, customerIdOf(key), Math.max(s.ageMin - 60, 60), s.owner), legal_name: s.name, display_name: s.name.replace(' (Demo)', ''), customer_type: s.ctype, gstin: pan ? fakeGstin(pan) : null, pan,
      email: s.email, phone: mobileOf(s), billing_address: addr, shipping_address: addr, state: 'Gujarat', lead_id: I.lead[key], aadhaar_last4: null, anonymised_at: null,
    });

    const [lat0, lng0] = SITE_GEO[s.city] ?? [23.0, 72.5];
    const mismatch = key === 'oppKusum';
    const ci = s.segment === 'ci_captive' || s.segment === 'ci_net_metered' || s.segment === 'open_access' || s.segment === 'government_bid';
    out.sites.push({
      ...baseOf(env, siteIdOf(key), Math.max(s.ageMin - 90, 60), s.owner), customer_id: customerIdOf(key), lead_id: I.lead[key], name_on_bill: mismatch ? 'Dhulabhai Rabari' : s.name.replace(' (Demo)', ''), applicant_name: s.name.replace(' (Demo)', ''),
      name_match: !mismatch, consumer_no: `DEMO-CN-${String(n).padStart(6, '0')}`, discom_id: DISCOM_OF_TERRITORY[s.territory] ?? null,
      sanctioned_load_kw: ci ? null : s.kw <= 3 ? 5 : Math.max(5, Math.round(s.kw * 1.2)), contracted_demand_kva: ci ? Math.round(s.kw * 1.3) : null, phase: s.kw <= 5 && !ci ? 'single' : 'three',
      address: addr, pincode: s.pin, city: s.city, district: districtOf(s.city), state: 'Gujarat', lat: Math.round((lat0 + i * 0.0021) * 1e6) / 1e6, lng: Math.round((lng0 + i * 0.0017) * 1e6) / 1e6,
      roof_ownership: s.segment === 'rwa_ghs' ? 'society' : s.segment === 'government_bid' ? 'government' : 'owned', title_ok: true, pending_dues: mismatch, existing_solar_kw: 0, category: 'general', special_category_state: false,
      roof_type: s.segment === 'pm_kusum' ? 'ground_mount' : ci ? 'metal_sheet' : 'rcc', load_type: s.segment === 'pm_kusum' ? 'agricultural' : s.segment === 'rwa_ghs' ? 'common_facility' : s.ctype === 'residential' ? 'residential' : s.ctype === 'industrial' ? 'industrial' : 'commercial', bill_doc_id: null,
    });

    const fz = FEASIBILITY[key];
    const surveyedAgo = key === 'siteVisitFeasibility' ? 6 * DAY : Math.max(3 * DAY, Math.round(s.ageMin * 0.4));
    out.surveys.push({
      ...baseOf(env, surveyIdOf(key), surveyedAgo + DAY, s.owner), site_id: siteIdOf(key), lead_id: I.lead[key], opportunity_id: OPP_OF_LEAD[key] ?? null, status: 'completed', scheduled_at: env.t(-(surveyedAgo + DAY)), surveyed_at: env.t(-surveyedAgo), surveyor_id: P.techno_commercial,
      photos: [
        { path: `demo/survey/${String(n).padStart(3, '0')}/roof-1.jpg`, lat: Math.round((lat0 + i * 0.0021) * 1e6) / 1e6, lng: Math.round((lng0 + i * 0.0017) * 1e6) / 1e6, taken_at: env.t(-surveyedAgo), caption: 'Roof overview' },
        { path: `demo/survey/${String(n).padStart(3, '0')}/meter-1.jpg`, lat: Math.round((lat0 + i * 0.0021) * 1e6) / 1e6, lng: Math.round((lng0 + i * 0.0017) * 1e6) / 1e6, taken_at: env.t(-surveyedAgo), caption: 'Meter and distribution board' },
      ],
      shading: i % 3 === 0 ? 'none' : i % 3 === 1 ? 'low' : 'medium', roof_type: s.segment === 'pm_kusum' ? 'ground_mount' : ci ? 'metal_sheet' : 'rcc', roof_area_sqm: Math.round(s.kw * 9 + 10), sld_ref: ci ? `DEMO-SLD-${String(n).padStart(3, '0')}` : null,
      notes: 'Demo survey record.',
      feasibility_status: fz ? fz.status : 'not_required',
      feasibility_application_submitted_at: fz ? env.t(fz.sub * DAY) : null, feasibility_application_complete_at: fz ? env.t(fz.comp * DAY) : null, feasibility_due_at: fz ? env.t(fz.due * DAY) : null,
    });
  });

  return out;
}
