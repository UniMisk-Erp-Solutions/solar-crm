import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import {
  LEAD_CLOSED_STATUSES, LEAD_KANBAN_COLUMNS, followupListQuerySchema, leadAcceptSchema, leadRequestsSchema, leadConsentAddSchema, leadConsentWithdrawSchema, leadContactInputSchema, leadCreateSchema,
  leadFollowupCompleteSchema, leadFollowupCreateSchema, leadListQuerySchema, leadLockOverrideDecisionSchema, leadLockOverrideRequestSchema, leadLostSchema, leadMergeSchema,
  leadMessageSendSchema, leadNurtureSchema, leadPatchSchema, leadQualificationSchema, leadReassignSchema, leadRejectSchema, leadSourceKeyCreateSchema, leadSourceKeyPatchSchema,
  leadUnmaskSchema, maskMobile, sha256Hex, type Json, type Lead, type LeadKanbanView, type SourceApiKey,
} from '@solar/shared';
import { assertCanRead, canSeeMobile, scopedWhere } from '../auth/access';
import { allow } from '../auth/authorize';
import type { AppContext } from '../auth/context';
import type { Where } from '../db/types';
import { runList, whereFromQuery } from '../http/crud';
import { AppError, notFound } from '../http/errors';
import { body, handle, param, parse, query, respondPage, wrap } from '../http/handler';
import { audit } from '../lib/audit';
import { scrubLeadDnd } from '../services/consentService';
import { recordConsent, resolveRecipients, withdrawConsents } from '../services/consentServiceLedger';
import { completeFollowup, listFollowups, scheduleFollowup } from '../services/followupService';
import {
  buildConsentSummary, createManualLead, decorateLeads, getLeadDetail, leadScoreView, leadTimeline, markLeadLost, nurtureLead, slaIdSets, unmaskLead, updateLead, visibleDuplicates,
} from '../services/leadService';
import { suggestDistributors, sendRequests } from '../services/leadServiceRequests';
import { acceptLead, reassignLead, rejectLead } from '../services/leadServiceAcceptance';
import { decideLockOverride, mergeLeads, requestLockOverride } from '../services/leadServiceDuplicates';
import { logContact, qualifyLead } from '../services/leadServiceStage2';
import { getLead, logLeadEvent } from '../services/leadServiceStore';

const router = Router();

/* roles (admin is always allowed by `allow`) */
const SALES = ['regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'distributor_user', 'dealer_user'] as const;
const MANAGERS = ['regional_head', 'sales_manager', 'dsm'] as const;
const CAN_UNMASK = ['management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts', 'compliance_officer', 'dispatch', 'distributor_user', 'dealer_user'] as const;

const FILTER_COLS = ['status', 'source', 'segment', 'temperature', 'owner_id', 'distributor_id', 'dealer_id', 'territory_id', 'lock_status', 'dnd_status', 'customer_type', 'duplicate_of', 'created_at', 'next_followup_at', 'quality_score'];
const SORT_COLS = ['created_at', 'updated_at', 'next_followup_at', 'quality_score', 'sla_due_at', 'name', 'last_action_at', 'status', 'temperature'];
const SEARCH_COLS = ['name', 'mobile', 'email', 'city', 'pincode', 'consumer_no', 'source_ref'];

/** Loads a lead the current user is allowed to see (404 / 403 otherwise). */
async function readable(ctx: AppContext, id: string): Promise<Lead> {
  const lead = await getLead(ctx, id);
  await assertCanRead(ctx, 'leads', lead);
  return lead;
}
const one = async (ctx: AppContext, lead: Lead) => (await decorateLeads(ctx, [lead]))[0]!;

/** Extra list filters that are not plain columns: SLA state and overdue follow-ups. */
async function extraWhere(ctx: AppContext, q: z.output<typeof leadListQuerySchema>, hasStatusFilter: boolean): Promise<Where> {
  const where: Where = { deleted_at: null };
  if (q.sla_state) {
    const sets = await slaIdSets(ctx);
    where['id'] = q.sla_state === 'breached' ? sets.breached : q.sla_state === 'due_soon' ? sets.due_soon : { nin: [...sets.breached, ...sets.due_soon] };
  }
  if (q.followup_overdue === true) {
    where['next_followup_at'] = { lt: ctx.now().toISOString() };
    if (!hasStatusFilter) where['status'] = { nin: [...LEAD_CLOSED_STATUSES, 'nurture'] };
  }
  return where;
}

/* ───────────── list, kanban, create, read, update ───────────── */
router.get('/leads', wrap(async (req, res) => {
  const ctx = req.ctx!;
  const q = query(leadListQuerySchema, req);
  const hasStatus = typeof req.query['status'] === 'string' && req.query['status'] !== '';
  const base = await extraWhere(ctx, q, hasStatus);

  if (q.view === 'kanban') {
    const filters = whereFromQuery(req.query, FILTER_COLS.filter((c) => c !== 'status'));
    const search = typeof req.query['q'] === 'string' && req.query['q'].trim() ? { cols: SEARCH_COLS, text: req.query['q'].trim() } : undefined;
    const scoped = await scopedWhere(ctx, 'leads', { ...base, ...filters });
    const columns = await Promise.all(LEAD_KANBAN_COLUMNS.map(async (c) => {
      const page = await ctx.db.table('leads').list({ where: { ...scoped, status: c.status }, search, orderBy: [{ col: 'next_followup_at', dir: 'asc' }], limit: q.per_column });
      return { status: c.status, label: c.label, count: page.total, rows: page.rows };
    }));
    const items = await decorateLeads(ctx, columns.flatMap((c) => c.rows));
    const byId = new Map(items.map((i) => [i.id, i]));
    const view: LeadKanbanView = { columns: columns.map((c) => ({ status: c.status, label: c.label, count: c.count, items: c.rows.map((r) => byId.get(r.id)!) })), total: columns.reduce((n, c) => n + c.count, 0) };
    res.json({ data: view });
    return;
  }

  const page = await runList<Lead>(ctx, req, { table: 'leads', searchCols: SEARCH_COLS, filterCols: FILTER_COLS, sortCols: SORT_COLS, defaultSort: { col: 'created_at', dir: 'desc' }, baseWhere: base });
  respondPage(res, await decorateLeads(ctx, page.rows), page.total, page.limit, page.offset);
}));

router.post('/leads', allow(...SALES), handle(async (ctx, req, res) => {
  const result = await createManualLead(ctx, body(leadCreateSchema, req));
  res.status(result.created ? 201 : 200);
  const [leadView, duplicates] = await Promise.all([one(ctx, result.lead), visibleDuplicates(ctx, result.lead, result.created ? result.duplicates : undefined)]);
  return {
    lead: leadView, created: result.created, duplicate_of: result.duplicate_of, lock_conflict: result.lock_conflict, assigned: result.assigned,
    consent_id: result.consent_id, duplicates, hints: result.hints,
  };
}));

router.get('/leads/:id', handle(async (ctx, req) => {
  await readable(ctx, param(req, 'id'));
  return getLeadDetail(ctx, param(req, 'id'));
}));

router.patch('/leads/:id', allow(...SALES), handle(async (ctx, req) => {
  await readable(ctx, param(req, 'id'));
  return one(ctx, await updateLead(ctx, param(req, 'id'), body(leadPatchSchema, req)));
}));

const pageQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });
router.get('/leads/:id/timeline', wrap(async (req, res) => {
  const ctx = req.ctx!;
  await readable(ctx, param(req, 'id'));
  const p = parse(pageQuery, req.query);
  const t = await leadTimeline(ctx, param(req, 'id'), p.limit, p.offset);
  respondPage(res, t.items, t.total, p.limit, p.offset);
}));

router.post('/leads/:id/unmask', allow(...CAN_UNMASK), handle(async (ctx, req) => {
  await readable(ctx, param(req, 'id'));
  return unmaskLead(ctx, param(req, 'id'), body(leadUnmaskSchema, req).reason);
}));

/* ───────────── acceptance loop ───────────── */
router.post('/leads/:id/accept', allow('dsm', 'sales_manager', 'regional_head', 'distributor_user', 'dealer_user'), handle(async (ctx, req) => {
  await readable(ctx, param(req, 'id'));
  const input = body(leadAcceptSchema, req);
  return one(ctx, await acceptLead(ctx, param(req, 'id'), { note: input.note, distributor_id: input.distributor_id }));
}));

router.post('/leads/:id/reject', allow('dsm', 'sales_manager', 'regional_head', 'distributor_user', 'dealer_user'), handle(async (ctx, req) => {
  await readable(ctx, param(req, 'id'));
  const input = body(leadRejectSchema, req);
  const r = await rejectLead(ctx, param(req, 'id'), input.reason, input.distributor_id);
  // after a rejection an external user may no longer be allowed to see the lead — return what they can
  return { lead: ctx.user.role === 'distributor_user' || ctx.user.role === 'dealer_user' ? { id: r.lead.id, status: r.lead.status } : await one(ctx, r.lead), reassigned: r.reassigned };
}));

/** The ranked distributors for this lead (best first, with the reasons against the others). Nothing is written. */
router.get('/leads/:id/suggestions', allow(...SALES), handle(async (ctx, req) => {
  await readable(ctx, param(req, 'id'));
  return suggestDistributors(ctx, param(req, 'id'));
}));

/** Send the request to the distributors a person picked. The first to accept gets the lead. */
router.post('/leads/:id/requests', allow(...SALES), handle(async (ctx, req) => {
  await readable(ctx, param(req, 'id'));
  const input = body(leadRequestsSchema, req);
  // the e-mail links point at the web app the person is using right now (its address arrives in the Origin header)
  const origin = typeof req.headers.origin === 'string' && /^https?:\/\//.test(req.headers.origin) ? req.headers.origin : null;
  const sent = await sendRequests(ctx, param(req, 'id'), { ...input, appUrl: origin });
  return { ...(await one(ctx, sent.lead)), emails: sent.emails };
}));

router.post('/leads/:id/reassign', allow(...MANAGERS), handle(async (ctx, req) => {
  await readable(ctx, param(req, 'id'));
  return one(ctx, await reassignLead(ctx, param(req, 'id'), body(leadReassignSchema, req)));
}));

/* ───────────── Stage 2: contact, qualification, score, follow-ups ───────────── */
router.post('/leads/:id/contacts', allow(...SALES), handle(async (ctx, req, res) => {
  await readable(ctx, param(req, 'id'));
  const r = await logContact(ctx, param(req, 'id'), body(leadContactInputSchema, req));
  res.status(201);
  return { contact: r.contact, lead: await one(ctx, r.lead) };
}));

router.get('/leads/:id/contacts', handle(async (ctx, req) => {
  await readable(ctx, param(req, 'id'));
  return ctx.db.table('contact_logs').all({ lead_id: param(req, 'id') }, { orderBy: { col: 'occurred_at', dir: 'desc' } });
}));

router.post('/leads/:id/qualification', allow(...SALES), handle(async (ctx, req) => {
  await readable(ctx, param(req, 'id'));
  const r = await qualifyLead(ctx, param(req, 'id'), body(leadQualificationSchema, req));
  return { lead: await one(ctx, r.lead), gaps: r.gaps, qualified: r.qualified, score: r.score, temperature: r.temperature, deadline_uplift: r.deadline_uplift };
}));

router.get('/leads/:id/score', handle(async (ctx, req) => {
  await readable(ctx, param(req, 'id'));
  return leadScoreView(ctx, param(req, 'id'), false);
}));
router.post('/leads/:id/score/recompute', allow(...SALES, 'compliance_officer'), handle(async (ctx, req) => {
  await readable(ctx, param(req, 'id'));
  return leadScoreView(ctx, param(req, 'id'), true);
}));

router.post('/leads/:id/followups', allow(...SALES), handle(async (ctx, req, res) => {
  await readable(ctx, param(req, 'id'));
  const input = body(leadFollowupCreateSchema, req);
  const followup = await scheduleFollowup(ctx, param(req, 'id'), { kind: input.kind, due_at: new Date(input.due_at), note: input.note });
  res.status(201);
  return { followup, lead: await one(ctx, await getLead(ctx, param(req, 'id'))) };
}));

router.get('/leads/:id/followups', handle(async (ctx, req) => {
  await readable(ctx, param(req, 'id'));
  return ctx.db.table('followups').all({ lead_id: param(req, 'id') }, { orderBy: { col: 'due_at', dir: 'desc' } });
}));

router.post('/followups/:id/complete', allow(...SALES), handle(async (ctx, req) => {
  const fu = await ctx.db.table('followups').get(param(req, 'id'));
  if (!fu) throw notFound('Follow-up');
  await readable(ctx, fu.lead_id);
  const input = body(leadFollowupCompleteSchema, req);
  const r = await completeFollowup(ctx, fu.id, { outcome: input.outcome, next_action: input.next_action, next_followup_at: new Date(input.next_followup_at), next_kind: input.next_kind, last_action: input.last_action });
  return { followup: r.followup, next: r.next, lead: await one(ctx, r.lead) };
}));

/** My work-list: due today, overdue, upcoming. `scope=team` widens it to every lead the user may see. */
router.get('/followups', wrap(async (req, res) => {
  const ctx = req.ctx!;
  const q = parse(followupListQuerySchema, req.query);
  let leadScope: string[] | null = null;
  if (q.scope === 'team') {
    const where = await scopedWhere(ctx, 'leads', { deleted_at: null, status: { nin: [...LEAD_CLOSED_STATUSES] } });
    leadScope = (await ctx.db.table('leads').all(where)).map((l) => l.id);
  }
  const page = await listFollowups(ctx, q, leadScope);
  respondPage(res, page.rows.map((r) => (canSeeMobile(ctx.user.role) ? r : { ...r, lead_mobile: maskMobile(r.lead_mobile) })), page.total, q.limit, q.offset);
}));

/* ───────────── consent ledger, DND, messages ───────────── */
router.get('/leads/:id/consents', handle(async (ctx, req) => {
  const lead = await readable(ctx, param(req, 'id'));
  const consents = await ctx.db.table('lead_consents').all({ lead_id: lead.id }, { orderBy: { col: 'granted_at', dir: 'desc' } });
  return { consents, summary: await buildConsentSummary(ctx, lead, consents) };
}));

router.post('/leads/:id/consents', allow(...SALES, 'compliance_officer'), handle(async (ctx, req, res) => {
  const lead = await readable(ctx, param(req, 'id'));
  const input = body(leadConsentAddSchema, req);
  const consent = await recordConsent(ctx, {
    lead, notice_version: input.notice_version, purposes: input.purposes, channels: input.channels, proof_ref: input.proof_ref, capture_source: input.capture_source,
    recipients_named: await resolveRecipients(ctx, lead, input.recipients_named), granted_at: input.granted_at, ip: null, user_agent: null,
  });
  res.status(201);
  const fresh = await getLead(ctx, lead.id);
  return { consent, summary: await buildConsentSummary(ctx, fresh, await ctx.db.table('lead_consents').all({ lead_id: lead.id })) };
}));

router.post('/leads/:id/consents/withdraw', allow(...SALES, 'compliance_officer'), handle(async (ctx, req) => {
  const lead = await readable(ctx, param(req, 'id'));
  const input = body(leadConsentWithdrawSchema, req);
  const result = await withdrawConsents(ctx, lead.id, { channel: input.channel, reason: input.reason });
  const fresh = await getLead(ctx, lead.id);
  return { ...result, summary: await buildConsentSummary(ctx, fresh, await ctx.db.table('lead_consents').all({ lead_id: lead.id })) };
}));

router.post('/leads/:id/dnd-scrub', allow(...SALES, 'compliance_officer'), handle(async (ctx, req) => {
  const lead = await readable(ctx, param(req, 'id'));
  const r = await scrubLeadDnd(ctx, lead, { force: true });
  await logLeadEvent(ctx, lead.id, 'dnd_scrubbed', r.status === 'unchecked' ? 'DND scrub unavailable — number left unchecked' : `DND scrub: ${r.status}`, { status: r.status, checked_at: r.checked_at, source: r.source });
  await audit(ctx, { action: 'dnd.scrub', table: 'leads', record_id: lead.id, detail: { status: r.status } as Json });
  return r;
}));

router.get('/leads/:id/messages', handle(async (ctx, req) => {
  await readable(ctx, param(req, 'id'));
  return ctx.db.table('message_log').all({ lead_id: param(req, 'id') }, { orderBy: { col: 'created_at', dir: 'desc' } });
}));

/** Sends through the consent-aware pipeline. A blocked message is a 422 CONSENT_BLOCKED whose details carry every reason. */
router.post('/leads/:id/messages', allow(...SALES), handle(async (ctx, req, res) => {
  const lead = await readable(ctx, param(req, 'id'));
  const input = body(leadMessageSendSchema, req);
  if (input.refresh_dnd && input.channel !== 'email') await scrubLeadDnd(ctx, lead, { force: true });
  const result = await ctx.svc.messaging.send({ lead_id: lead.id, channel: input.channel, purpose: input.purpose, template_key: input.template_key, body: input.body, subject: input.subject, vars: input.vars });
  if (result.blocked) {
    throw new AppError(422, 'CONSENT_BLOCKED', `This message was not sent: ${result.reasons.map((r) => r.message).join('; ')}`, { reasons: result.reasons, message_log_id: result.message_log_id, status: result.status });
  }
  res.status(result.status === 'failed' ? 502 : 201);
  return result;
}));

/* ───────────── nurture, lost, merge, lock override ───────────── */
router.post('/leads/:id/nurture', allow(...SALES), handle(async (ctx, req) => {
  await readable(ctx, param(req, 'id'));
  return one(ctx, await nurtureLead(ctx, param(req, 'id'), body(leadNurtureSchema, req)));
}));

router.post('/leads/:id/lost', allow(...SALES), handle(async (ctx, req) => {
  await readable(ctx, param(req, 'id'));
  return one(ctx, await markLeadLost(ctx, param(req, 'id'), body(leadLostSchema, req).reason));
}));

router.post('/leads/:id/merge', allow(...MANAGERS), handle(async (ctx, req) => {
  await readable(ctx, param(req, 'id'));
  const input = body(leadMergeSchema, req);
  await readable(ctx, input.into_lead_id);
  const r = await mergeLeads(ctx, param(req, 'id'), input.into_lead_id, input.note);
  return { source: await one(ctx, r.source), target: await one(ctx, r.target) };
}));

router.post('/leads/:id/lock-override', allow(...MANAGERS, 'distributor_user', 'dealer_user'), handle(async (ctx, req) => {
  await readable(ctx, param(req, 'id'));
  return one(ctx, await requestLockOverride(ctx, param(req, 'id'), body(leadLockOverrideRequestSchema, req).reason));
}));

router.post('/leads/:id/lock-override/decide', allow('sales_manager', 'regional_head'), handle(async (ctx, req) => {
  await readable(ctx, param(req, 'id'));
  const input = body(leadLockOverrideDecisionSchema, req);
  return one(ctx, await decideLockOverride(ctx, param(req, 'id'), input.decision, input.note));
}));

/* ───────────── per-source API keys for the public intake endpoints (administrator) ───────────── */
const keyView = (k: SourceApiKey) => ({ id: k.id, source: k.source, label: k.label, key_prefix: k.key_prefix, active: k.active, last_used_at: k.last_used_at, created_at: k.created_at });

router.get('/lead-source-keys', allow(), handle(async (ctx) => (await ctx.db.table('source_api_keys').all(undefined, { orderBy: { col: 'created_at', dir: 'desc' } })).map(keyView)));

/** The plain key is returned once, here; only its SHA-256 is stored. */
router.post('/lead-source-keys', allow(), handle(async (ctx, req, res) => {
  const input = body(leadSourceKeyCreateSchema, req);
  const key = `fs_${input.source}_${randomBytes(24).toString('hex')}`;
  const row = await ctx.db.table('source_api_keys').insert({ source: input.source, label: input.label, key_hash: sha256Hex(key), key_prefix: key.slice(0, 12), active: true, last_used_at: null, created_by: ctx.user.id });
  await audit(ctx, { action: 'lead_source_key.create', table: 'source_api_keys', record_id: row.id, new: { source: row.source, label: row.label, key_prefix: row.key_prefix } as Json });
  res.status(201);
  return { ...keyView(row), key, note: 'Copy this key now — it cannot be shown again.' };
}));

router.patch('/lead-source-keys/:id', allow(), handle(async (ctx, req) => {
  const before = await ctx.db.table('source_api_keys').get(param(req, 'id'));
  if (!before) throw notFound('API key');
  const row = await ctx.db.table('source_api_keys').update(before.id, body(leadSourceKeyPatchSchema, req));
  await audit(ctx, { action: 'lead_source_key.update', table: 'source_api_keys', record_id: row.id, old: { active: before.active, label: before.label } as Json, new: { active: row.active, label: row.label } as Json });
  return keyView(row);
}));

export default router;
