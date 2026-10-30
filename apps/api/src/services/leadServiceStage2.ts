/**
 * Stage 2 — initial contact (step 8) and the qualification call (step 9); temperature (10) and quality score (11) are derived
 * from the answers, then the follow-up engine plans the next action (12).
 */
import {
  CONTACT_CONNECTED_OUTCOMES, CONTACT_OUTCOME_LABEL, type ContactLog, type ContactChannel, type FollowupKind, type Lead, type LeadQualificationInput, type LeadContactInput,
} from '@solar/shared';
import type { AppContext } from '../auth/context';
import { AppError } from '../http/errors';
import { audit } from '../lib/audit';
import { assertFollowupDate, dueFor, nextStepFor, planNextAction } from './followupService';
import { ensureAcceptedForWork } from './leadServiceAcceptance';
import { defaultFollowupAt, ruleOr } from './leadServiceSettings';
import { completeLeadClock, getLead, logLeadEvent, saveLead } from './leadServiceStore';
import { recomputeLeadScore } from './scoring';

const iso = (d: Date): string => d.toISOString();
const CHANNEL_LABEL: Record<ContactChannel, string> = { call: 'Call', whatsapp: 'WhatsApp', visit: 'Visit', sms: 'SMS', email: 'E-mail' };
const KIND_OF: Record<ContactChannel, FollowupKind> = { call: 'call', whatsapp: 'whatsapp', visit: 'visit', sms: 'task', email: 'email' };

/** The follow-up that this contact fulfils: the earliest open one that is overdue or due within the next day. */
async function fulfilDueFollowup(ctx: AppContext, leadId: string, outcome: string): Promise<void> {
  const first = (await ctx.db.table('followups').all({ lead_id: leadId, status: 'open' }, { orderBy: { col: 'due_at', dir: 'asc' } }))[0];
  if (!first || new Date(first.due_at).getTime() > ctx.now().getTime() + 86_400_000) return;
  const clock = (await ctx.svc.clocks.forEntity('lead', leadId)).find((c) => c.clock_type === 'followup' && !c.resolved_at);
  if (clock && (clock.meta as { followup_id?: string }).followup_id === first.id) await completeLeadClock(ctx, leadId, 'followup', { completed_followup_id: first.id });
  await ctx.db.table('followups').update(first.id, { status: 'done', done_at: iso(ctx.now()), outcome });
}

export async function logContact(ctx: AppContext, leadId: string, input: LeadContactInput): Promise<{ contact: ContactLog; lead: Lead }> {
  let lead = await getLead(ctx, leadId);
  lead = await ensureAcceptedForWork(ctx, lead);
  const now = ctx.now();
  const occurred = input.occurred_at ? new Date(input.occurred_at) : now;
  if (occurred.getTime() > now.getTime() + 5 * 60_000) throw new AppError(422, 'VALIDATION_ERROR', 'The contact time cannot be in the future', [{ path: 'occurred_at', message: 'Choose a time that has already passed' }]);
  const step = nextStepFor(input.outcome);
  const nextDue = input.next_followup_at ? new Date(input.next_followup_at) : null;
  if (nextDue) await assertFollowupDate(ctx, nextDue);

  const contact = await ctx.db.table('contact_logs').insert({
    lead_id: leadId, channel: input.channel, direction: input.direction, outcome: input.outcome, notes: input.notes ?? null, duration_min: input.duration_min ?? null,
    occurred_at: iso(occurred), logged_by: ctx.system ? null : ctx.user.id, created_by: ctx.system ? null : ctx.user.id,
  });

  const connected = CONTACT_CONNECTED_OUTCOMES.includes(input.outcome);
  const statusPatch: Partial<Lead> = {};
  if (connected && (lead.status === 'accepted' || lead.status === 'nurture')) {
    statusPatch.status = 'contacted';
    if (lead.status === 'nurture') Object.assign(statusPatch, { nurture_until: null, nurture_reason: null });
  }
  const firstResponse = !lead.first_contacted_at && input.direction === 'outbound';
  const label = `${CHANNEL_LABEL[input.channel]} — ${CONTACT_OUTCOME_LABEL[input.outcome]}`;
  await saveLead(ctx, leadId, { ...statusPatch, last_action: label, last_action_at: iso(occurred), ...(firstResponse ? { first_contacted_at: iso(occurred) } : {}) });

  await fulfilDueFollowup(ctx, leadId, CONTACT_OUTCOME_LABEL[input.outcome]);
  const fresh = await getLead(ctx, leadId);
  await planNextAction(ctx, leadId, {
    note: input.next_action ?? step.action, kind: input.next_action ? KIND_OF[input.channel] : step.kind, due_at: nextDue ?? (await dueFor(ctx, step, fresh)), lastAction: label, replaceOpen: true,
  });
  await logLeadEvent(ctx, leadId, 'contact_logged', `${label}${input.direction === 'inbound' ? ' (inbound)' : ''}${firstResponse ? ' — first response' : ''}`, {
    contact_id: contact.id, channel: input.channel, direction: input.direction, outcome: input.outcome, first_response: firstResponse,
    response_minutes: firstResponse ? Math.round((occurred.getTime() - new Date(lead.created_at).getTime()) / 60000) : null,
  });
  await audit(ctx, { action: 'lead.contact', table: 'contact_logs', record_id: contact.id, new: { lead_id: leadId, channel: input.channel, outcome: input.outcome } });
  return { contact, lead: await getLead(ctx, leadId) };
}

/* ───────────── qualification ───────────── */
const REQUIRED_FIELD_LABEL: Record<string, string> = {
  requirement_text: 'requirement', timeline_bucket: 'timeline', decision_maker: 'decision maker', capacity_kw: 'system size (kW)', budget_inr: 'budget', segment: 'segment',
};

/** What is still unknown before the lead can be called Qualified (`lead.qualification_required_fields`). */
export async function qualificationGaps(ctx: AppContext, lead: Lead): Promise<string[]> {
  const required = await ruleOr<string[]>(ctx, 'lead.qualification_required_fields', ['requirement_text', 'timeline_bucket', 'decision_maker', 'capacity_kw']);
  const known: Record<string, boolean> = {
    requirement_text: !!lead.requirement_text?.trim(), timeline_bucket: !!lead.timeline_bucket,
    decision_maker: !!lead.decision_maker, capacity_kw: lead.capacity_kw !== null, budget_inr: lead.budget_inr !== null, segment: !!lead.segment,
  };
  return required.filter((f) => f in known && !known[f]).map((f) => REQUIRED_FIELD_LABEL[f] ?? f);
}

export interface QualificationResult { lead: Lead; gaps: string[]; qualified: boolean; score: number; temperature: Lead['temperature']; deadline_uplift: boolean }

export async function qualifyLead(ctx: AppContext, leadId: string, input: LeadQualificationInput): Promise<QualificationResult> {
  let lead = await getLead(ctx, leadId);
  lead = await ensureAcceptedForWork(ctx, lead);
  const nextDue = input.next_followup_at ? new Date(input.next_followup_at) : null;
  if (nextDue) await assertFollowupDate(ctx, nextDue);
  const now = iso(ctx.now());

  const patch: Partial<Lead> = {
    requirement_text: input.requirement_text, timeline_bucket: input.timeline_bucket, decision_maker: input.decision_maker,
    ...(input.budget_inr !== undefined ? { budget_inr: input.budget_inr } : {}), ...(input.decision_maker_access !== undefined ? { decision_maker_access: input.decision_maker_access } : {}),
    ...(input.capacity_kw !== undefined ? { capacity_kw: input.capacity_kw } : {}), ...(input.segment !== undefined ? { segment: input.segment } : {}),
    ...(input.customer_type !== undefined ? { customer_type: input.customer_type } : {}), ...(input.product_interest !== undefined ? { product_interest: input.product_interest } : {}),
    ...(input.bill_captured !== undefined ? { bill_captured: input.bill_captured } : {}), ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(lead.first_contacted_at ? {} : { first_contacted_at: now }),
  };
  let { after } = await saveLead(ctx, leadId, patch);
  const scored = await recomputeLeadScore(ctx, leadId, { force: true });
  after = scored.lead;
  const gaps = await qualificationGaps(ctx, after);
  const qualified = gaps.length === 0;
  const status = qualified && ['accepted', 'contacted', 'nurture'].includes(after.status) ? 'qualified' : ['accepted', 'nurture'].includes(after.status) ? 'contacted' : after.status;
  const lastAction = qualified ? 'Qualification call completed' : 'Qualification call — more information needed';
  await saveLead(ctx, leadId, { status, last_action: lastAction, last_action_at: now, ...(after.status === 'nurture' ? { nurture_until: null, nurture_reason: null } : {}) });
  const note = input.next_action ?? (qualified ? 'Schedule the site visit' : `Complete the qualification — still needed: ${gaps.join(', ')}`);
  const due = nextDue ?? (await defaultFollowupAt(ctx, scored.lead.temperature));
  await planNextAction(ctx, leadId, { note, kind: 'call', due_at: due, lastAction, replaceOpen: true });
  await logLeadEvent(ctx, leadId, qualified ? 'qualified' : 'qualification_updated', `${lastAction}. Score ${scored.score.score}/100, ${scored.lead.temperature}${scored.temperature.deadline_uplift ? ' (raised for a compliance deadline)' : ''}`, {
    score: scored.score.score, temperature: scored.lead.temperature, deadline_uplift: scored.temperature.deadline_uplift, gaps, status,
  });
  await audit(ctx, { action: 'lead.qualify', table: 'leads', record_id: leadId, old: { status: lead.status, quality_score: lead.quality_score, temperature: lead.temperature }, new: { status, quality_score: scored.score.score, temperature: scored.lead.temperature } });
  const final = await getLead(ctx, leadId);
  return { lead: final, gaps, qualified, score: scored.score.score, temperature: final.temperature, deadline_uplift: final.deadline_uplift };
}
