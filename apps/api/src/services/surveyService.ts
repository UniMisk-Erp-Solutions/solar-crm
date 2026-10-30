/**
 * Site visit & survey (step 14): schedule → remind the surveyor → complete (shading, roof, SLD) → the lead moves to `site_visit`.
 * Photos live in surveyPhotos.ts, DISCOM feasibility in surveyFeasibility.ts.
 */
import type { Request } from 'express';
import { formatDateTime, formatDuration, type Json, type Lead, type LeadStatus, type SiteSurvey, type SurveyScheduleInput, type SurveyUpdateInput } from '@solar/shared';
import { SALES_ROLES } from '../auth/authorize';
import type { AppContext } from '../auth/context';
import { audit } from '../lib/audit';
import { addDays } from '../lib/time';
import { AppError, conflict, invalidState, notFound } from '../http/errors';
import { actorId, assertLeadEditable, getVisibleLead, invalidField, listViaLead, logLeadEvent, profileNames } from './siteAccess';
import { buildFeasibilityView, initialFeasibilityStatus, loadFeasibilityRules, refreshFeasibilityRequirement } from './surveyFeasibility';
import { registerJob } from './hooks';

const SCHEDULABLE: LeadStatus[] = ['accepted', 'contacted', 'qualified', 'site_visit', 'nurture', 'opportunity'];
const TO_SITE_VISIT: LeadStatus[] = ['accepted', 'contacted', 'qualified', 'nurture'];
const PAST_TOLERANCE_MS = 15 * 60_000;
const FUTURE_TOLERANCE_MS = 5 * 60_000;
const link = (leadId: string): string => `/leads/${leadId}?tab=site`;
const asJson = (v: unknown): Json => v as Json;

/** Load a survey together with its (visible) lead. */
export async function loadSurvey(ctx: AppContext, id: string): Promise<{ survey: SiteSurvey; lead: Lead }> {
  const survey = await ctx.db.table('site_surveys').get(id);
  if (!survey) throw notFound('Survey');
  const lead = await getVisibleLead(ctx, survey.lead_id);
  return { survey, lead };
}

async function assertSurveyor(ctx: AppContext, surveyorId: string, lead: Lead): Promise<void> {
  const p = await ctx.db.table('profiles').get(surveyorId);
  if (!p || !p.active) throw invalidField('surveyor_id', 'That user does not exist or is inactive');
  if (p.role !== 'admin' && !SALES_ROLES.includes(p.role)) throw invalidField('surveyor_id', `A ${p.role.replace('_', ' ')} cannot be sent on a site visit`);
  if (p.role === 'distributor_user' && p.distributor_id !== lead.distributor_id) throw invalidField('surveyor_id', 'That distributor user belongs to a different distributor than this lead');
  if (p.role === 'dealer_user' && p.dealer_id !== lead.dealer_id && p.distributor_id !== lead.distributor_id) throw invalidField('surveyor_id', 'That dealer user does not belong to this lead’s channel');
}

const requireFutureish = (iso: string, now: Date, path: string): void => {
  if (new Date(iso).getTime() < now.getTime() - PAST_TOLERANCE_MS) throw invalidField(path, 'Pick a date and time in the future');
};

/* ───────────── schedule ───────────── */

export async function scheduleSurvey(ctx: AppContext, input: SurveyScheduleInput): Promise<SiteSurvey> {
  const lead = await getVisibleLead(ctx, input.lead_id);
  assertLeadEditable(lead);
  if (!SCHEDULABLE.includes(lead.status)) throw invalidState(`A site visit can be scheduled once the lead is accepted (current status: ${lead.status})`, { status: lead.status });
  const now = ctx.now();
  requireFutureish(input.scheduled_at, now, 'scheduled_at');
  const existing = await ctx.db.table('site_surveys').one({ lead_id: lead.id, status: 'scheduled' });
  if (existing) throw conflict('A site visit is already scheduled for this lead — reschedule it instead', { survey_id: existing.id, scheduled_at: existing.scheduled_at });

  const surveyorId = input.surveyor_id ?? (ctx.system ? lead.owner_id : ctx.user.id);
  if (!surveyorId) throw invalidField('surveyor_id', 'Choose who will visit the site');
  await assertSurveyor(ctx, surveyorId, lead);

  const opp = await ctx.db.table('opportunities').one({ lead_id: lead.id });
  const rules = await loadFeasibilityRules(ctx);
  const scheduledAt = new Date(input.scheduled_at).toISOString();
  const survey = await ctx.db.table('site_surveys').insert({
    site_id: lead.site_id, lead_id: lead.id, opportunity_id: opp?.id ?? null, status: 'scheduled', scheduled_at: scheduledAt, surveyed_at: null, surveyor_id: surveyorId, photos: [],
    shading: null, roof_type: null, roof_area_sqm: null, sld_ref: null, notes: input.notes ?? null,
    feasibility_status: initialFeasibilityStatus(opp?.kw ?? lead.capacity_kw, rules), feasibility_application_submitted_at: null, feasibility_application_complete_at: null, feasibility_due_at: null,
    created_by: actorId(ctx),
  });
  await ctx.db.table('leads').update(lead.id, { last_action: 'Site visit scheduled', last_action_at: now.toISOString(), next_action: 'Site visit', next_followup_at: scheduledAt });
  await logLeadEvent(ctx, lead.id, 'survey_scheduled', `Site visit scheduled for ${formatDateTime(scheduledAt)}`, { survey_id: survey.id, scheduled_at: scheduledAt, surveyor_id: surveyorId });
  await audit(ctx, { action: 'survey.schedule', table: 'site_surveys', record_id: survey.id, new: { lead_id: lead.id, scheduled_at: scheduledAt, surveyor_id: surveyorId } });
  if (surveyorId !== actorId(ctx)) {
    await ctx.svc.notify.notify({
      user_ids: [surveyorId], kind: 'survey.scheduled', title: `Site visit assigned — ${lead.name}`, body: `${formatDateTime(scheduledAt)}${lead.city ? ` · ${lead.city}` : ''}${lead.pincode ? ` ${lead.pincode}` : ''}`,
      severity: 'info', entity_type: 'survey', entity_id: survey.id, link: link(lead.id),
    });
  }
  return survey;
}

/* ───────────── read ───────────── */

export async function listSurveys(ctx: AppContext, req: Request) {
  const q = req.query;
  const range: Record<string, string> = {};
  if (typeof q['scheduled_from'] === 'string' && q['scheduled_from']) range['gte'] = q['scheduled_from'];
  if (typeof q['scheduled_to'] === 'string' && q['scheduled_to']) range['lte'] = q['scheduled_to'];
  const page = await listViaLead(ctx, req, {
    table: 'site_surveys', filterCols: ['status', 'lead_id', 'surveyor_id', 'feasibility_status', 'site_id', 'opportunity_id'], sortCols: ['scheduled_at', 'surveyed_at'], defaultSort: { col: 'scheduled_at', dir: 'desc' },
    extraWhere: {
      ...(Object.keys(range).length ? { scheduled_at: range } : {}),
      ...(q['mine'] === 'true' ? { surveyor_id: ctx.user.id } : {}),
    },
  });
  const leads = new Map((await ctx.db.table('leads').all({ id: [...new Set(page.rows.map((s) => s.lead_id))] })).map((l) => [l.id, l]));
  const names = await profileNames(ctx, page.rows.map((s) => s.surveyor_id));
  return {
    ...page,
    rows: page.rows.map((s) => {
      const l = leads.get(s.lead_id);
      return {
        ...s, photo_count: s.photos.length,
        lead_name: l?.name ?? null, lead_status: l?.status ?? null, lead_city: l?.city ?? null, lead_pincode: l?.pincode ?? null, capacity_kw: l?.capacity_kw ?? null,
        surveyor_name: s.surveyor_id ? names.get(s.surveyor_id) ?? null : null,
      };
    }),
  };
}

export async function getSurveyView(ctx: AppContext, id: string) {
  const { survey, lead } = await loadSurvey(ctx, id);
  return hydrateSurvey(ctx, survey, lead);
}

export async function hydrateSurvey(ctx: AppContext, survey: SiteSurvey, lead: Lead) {
  const names = await profileNames(ctx, [survey.surveyor_id]);
  const site = survey.site_id ? await ctx.db.table('sites').get(survey.site_id) : lead.site_id ? await ctx.db.table('sites').get(lead.site_id) : null;
  return {
    ...survey,
    photo_count: survey.photos.length,
    lead: { id: lead.id, name: lead.name, status: lead.status, segment: lead.segment, capacity_kw: lead.capacity_kw, temperature: lead.temperature, city: lead.city, pincode: lead.pincode, distributor_id: lead.distributor_id, dealer_id: lead.dealer_id },
    site: site ? { id: site.id, consumer_no: site.consumer_no, discom_id: site.discom_id, sanctioned_load_kw: site.sanctioned_load_kw, phase: site.phase, roof_type: site.roof_type, state: site.state, name_match: site.name_match, pending_dues: site.pending_dues } : null,
    surveyor: survey.surveyor_id ? { id: survey.surveyor_id, full_name: names.get(survey.surveyor_id) ?? null } : null,
    feasibility: await buildFeasibilityView(ctx, survey, lead),
  };
}

/* ───────────── update / complete / cancel ───────────── */

export async function updateSurvey(ctx: AppContext, id: string, input: SurveyUpdateInput) {
  const { survey, lead } = await loadSurvey(ctx, id);
  assertLeadEditable(lead);
  if (survey.status === 'cancelled') throw invalidState('This site visit was cancelled and can no longer be changed');
  const now = ctx.now();
  const wasScheduled = survey.status === 'scheduled';
  const target = input.status ?? survey.status;
  if (input.status && input.status !== survey.status && !wasScheduled) throw invalidState(`A ${survey.status} visit cannot be moved to ${input.status}`);
  if (input.status === 'scheduled' && !wasScheduled) throw invalidState('A completed visit cannot go back to scheduled');

  const patch: Partial<SiteSurvey> = {};
  let rescheduled = false;
  if (input.scheduled_at !== undefined) {
    if (!wasScheduled || target !== 'scheduled') throw invalidState('Only a scheduled visit can be rescheduled');
    requireFutureish(input.scheduled_at, now, 'scheduled_at');
    patch.scheduled_at = new Date(input.scheduled_at).toISOString();
    rescheduled = patch.scheduled_at !== survey.scheduled_at;
  }
  let surveyorChanged = false;
  if (input.surveyor_id !== undefined) {
    if (input.surveyor_id === null) throw invalidField('surveyor_id', 'A site visit must have a surveyor');
    await assertSurveyor(ctx, input.surveyor_id, lead);
    patch.surveyor_id = input.surveyor_id;
    surveyorChanged = input.surveyor_id !== survey.surveyor_id;
  }
  if (input.shading !== undefined) patch.shading = input.shading;
  if (input.roof_type !== undefined) patch.roof_type = input.roof_type;
  if (input.roof_area_sqm !== undefined) patch.roof_area_sqm = input.roof_area_sqm;
  if (input.sld_ref !== undefined) patch.sld_ref = input.sld_ref;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.surveyed_at !== undefined && !(wasScheduled && target === 'completed')) throw invalidField('surveyed_at', 'surveyed_at can only be set when completing the visit');

  const completing = wasScheduled && target === 'completed';
  const cancelling = wasScheduled && target === 'cancelled';
  if (completing) {
    const merged = { ...survey, ...patch };
    const issues = (['shading', 'roof_type', 'roof_area_sqm'] as const).filter((k) => merged[k] === null || merged[k] === undefined);
    if (issues.length) {
      throw new AppError(422, 'VALIDATION_ERROR', 'Add the survey findings before completing the visit', issues.map((k) => ({ path: k, message: 'Required to complete the site visit' })));
    }
    const surveyedAt = input.surveyed_at ?? now.toISOString();
    if (new Date(surveyedAt).getTime() > now.getTime() + FUTURE_TOLERANCE_MS) throw invalidField('surveyed_at', 'The visit date cannot be in the future');
    patch.status = 'completed';
    patch.surveyed_at = new Date(surveyedAt).toISOString();
    if (!survey.site_id && lead.site_id) patch.site_id = lead.site_id;
  }
  if (cancelling) {
    if (!input.cancel_reason) throw invalidField('cancel_reason', 'Give a reason for cancelling the visit');
    patch.status = 'cancelled';
    patch.notes = [patch.notes !== undefined ? patch.notes : survey.notes, `Cancelled: ${input.cancel_reason}`].filter(Boolean).join('\n');
  }

  let row = Object.keys(patch).length ? await ctx.db.table('site_surveys').update(id, patch) : survey;

  if (completing) {
    if (row.site_id && row.roof_type) {
      const site = await ctx.db.table('sites').get(row.site_id);
      if (site && site.roof_type !== row.roof_type) await ctx.db.table('sites').update(site.id, { roof_type: row.roof_type });
    }
    row = await refreshFeasibilityRequirement(ctx, row, lead);
    const days = await ctx.svc.rules.value<number>('survey.post_visit_followup_days', undefined, 2) ?? 2;
    const leadPatch: Partial<Lead> = { last_action: 'Site visit completed', last_action_at: now.toISOString() };
    if (TO_SITE_VISIT.includes(lead.status)) leadPatch.status = 'site_visit';
    if (lead.status !== 'opportunity' && lead.status !== 'won') { leadPatch.next_action = 'Share recommendation and discuss rate'; leadPatch.next_followup_at = addDays(now, days).toISOString(); }
    await ctx.db.table('leads').update(lead.id, leadPatch);
    await logLeadEvent(ctx, lead.id, 'site_visit_completed', 'Site visit completed', { survey_id: id, shading: row.shading, roof_type: row.roof_type, roof_area_sqm: row.roof_area_sqm, photos: row.photos.length });
    await audit(ctx, { action: 'survey.complete', table: 'site_surveys', record_id: id, old: { status: survey.status }, new: { status: 'completed', surveyed_at: row.surveyed_at } });
    if (lead.owner_id && lead.owner_id !== actorId(ctx)) {
      await ctx.svc.notify.notify({ user_ids: [lead.owner_id], kind: 'survey.completed', title: `Site visit completed — ${lead.name}`, body: 'Capture the requirement form and discuss the rate.', severity: 'success', entity_type: 'survey', entity_id: id, link: link(lead.id) });
    }
  } else if (cancelling) {
    await ctx.db.table('leads').update(lead.id, { last_action: 'Site visit cancelled', last_action_at: now.toISOString(), next_action: 'Reschedule site visit' });
    await logLeadEvent(ctx, lead.id, 'survey_cancelled', 'Site visit cancelled', { survey_id: id, reason: input.cancel_reason ?? null });
    await audit(ctx, { action: 'survey.cancel', table: 'site_surveys', record_id: id, old: { status: survey.status }, new: { status: 'cancelled' }, detail: { reason: input.cancel_reason ?? null } });
    const who = [row.surveyor_id, lead.owner_id].filter((x): x is string => !!x && x !== actorId(ctx));
    if (who.length) await ctx.svc.notify.notify({ user_ids: who, kind: 'survey.cancelled', title: `Site visit cancelled — ${lead.name}`, body: input.cancel_reason ?? null, severity: 'warning', entity_type: 'survey', entity_id: id, link: link(lead.id) });
  } else {
    if (rescheduled && row.scheduled_at) {
      await ctx.db.table('leads').update(lead.id, { next_action: 'Site visit', next_followup_at: row.scheduled_at });
      await logLeadEvent(ctx, lead.id, 'survey_rescheduled', `Site visit moved to ${formatDateTime(row.scheduled_at)}`, { survey_id: id, from: survey.scheduled_at, to: row.scheduled_at });
    }
    if (Object.keys(patch).length) await audit(ctx, { action: 'survey.update', table: 'site_surveys', record_id: id, old: { scheduled_at: survey.scheduled_at, surveyor_id: survey.surveyor_id }, new: asJson(patch) });
    const notifyUser = surveyorChanged ? row.surveyor_id : rescheduled ? row.surveyor_id : null;
    if (notifyUser && notifyUser !== actorId(ctx)) {
      await ctx.svc.notify.notify({
        user_ids: [notifyUser], kind: surveyorChanged ? 'survey.scheduled' : 'survey.rescheduled', title: `${surveyorChanged ? 'Site visit assigned' : 'Site visit rescheduled'} — ${lead.name}`,
        body: row.scheduled_at ? formatDateTime(row.scheduled_at) : null, severity: 'info', entity_type: 'survey', entity_id: id, link: link(lead.id),
      });
    }
  }
  return hydrateSurvey(ctx, row, (await ctx.db.table('leads').get(lead.id)) ?? lead);
}

/* ───────────── reminders before the visit ───────────── */

/**
 * Notify surveyors ahead of their visits (rule survey.reminder_hours_before, default [24, 2] hours). One reminder per level,
 * de-duplicated through the lead timeline so it is safe to run on any schedule; when a visit is booked at short notice only the
 * most relevant level is sent.
 */
export async function sendSurveyReminders(ctx: AppContext): Promise<{ scanned: number; sent: number }> {
  const raw = await ctx.svc.rules.value<unknown>('survey.reminder_hours_before', undefined, [24, 2]);
  const hours = (Array.isArray(raw) ? raw : [24, 2]).filter((h): h is number => typeof h === 'number' && h > 0).sort((a, b) => b - a);
  if (!hours.length) return { scanned: 0, sent: 0 };
  const now = ctx.now();
  const horizon = new Date(now.getTime() + hours[0]! * 3_600_000);
  const upcoming = await ctx.db.table('site_surveys').all({ status: 'scheduled', scheduled_at: { gt: now.toISOString(), lte: horizon.toISOString() } });
  let sent = 0;
  for (const s of upcoming) {
    if (!s.surveyor_id || !s.scheduled_at) continue;
    const at = new Date(s.scheduled_at).getTime();
    const due = hours.filter((h) => at - h * 3_600_000 <= now.getTime());
    if (!due.length) continue;
    const events = await ctx.db.table('lead_events').all({ lead_id: s.lead_id, event_type: 'survey_reminder' });
    const done = new Set(events.map((e) => e.detail as unknown as { survey_id?: string; scheduled_at?: string; hours?: number }).filter((d) => d.survey_id === s.id && d.scheduled_at === s.scheduled_at).map((d) => d.hours));
    const pending = due.filter((h) => !done.has(h));
    if (!pending.length) continue;
    const current = Math.min(...pending);
    const lead = await ctx.db.table('leads').get(s.lead_id);
    if (!lead) continue;
    await ctx.svc.notify.notify({
      user_ids: [s.surveyor_id], kind: `survey.reminder.${current}`, title: `Site visit in ${formatDuration(at - now.getTime())} — ${lead.name}`,
      body: `${formatDateTime(s.scheduled_at)}${lead.city ? ` · ${lead.city}` : ''}${lead.pincode ? ` ${lead.pincode}` : ''}`, severity: 'info', entity_type: 'survey', entity_id: s.id, link: link(lead.id),
    });
    for (const h of pending) {
      await logLeadEvent(ctx, s.lead_id, 'survey_reminder', h === current ? `Reminder sent to the surveyor (${h} h before the visit)` : `Reminder level ${h} h skipped — visit booked at short notice`, { survey_id: s.id, scheduled_at: s.scheduled_at, hours: h, notified: h === current });
    }
    sent++;
  }
  return { scanned: upcoming.length, sent };
}

registerJob({ name: 'site_survey_reminders', schedule: '*/15 * * * *', run: async (ctx) => ({ ...(await sendSurveyReminders(ctx)) }) });
