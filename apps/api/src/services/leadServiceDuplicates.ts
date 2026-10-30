/**
 * Duplicate handling after capture: merge into the canonical lead, and the ownership-lock override workflow
 * (request → Sales Manager decision). Lifecycle: New → Duplicate → (manager override → Validated | merge → Merged).
 */
import type { Json, Lead } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { invalidState, notFound } from '../http/errors';
import { audit } from '../lib/audit';
import { recordConsent } from './consentServiceLedger';
import { cancelFollowups } from './followupService';
import { routeLead } from './leadServiceAcceptance';
import { workingMinutesFrom } from './leadServiceSettings';
import { actorId, dsmIds, getLead, logLeadEvent, notifyStaff, saveLead } from './leadServiceStore';
import { recomputeLeadScore } from './scoring';

const iso = (d: Date): string => d.toISOString();

/** Merge `sourceId` into `intoId`: the source becomes `merged`, the target keeps working and inherits missing details and the source's active consents. */
export async function mergeLeads(ctx: AppContext, sourceId: string, intoId: string, note?: string | null): Promise<{ source: Lead; target: Lead }> {
  if (sourceId === intoId) throw invalidState('A lead cannot be merged into itself');
  const src = await getLead(ctx, sourceId);
  const dst = await getLead(ctx, intoId);
  if (['merged', 'won', 'opportunity'].includes(src.status)) throw invalidState(`A lead that is ${src.status} cannot be merged into another lead`);
  if (dst.status === 'merged') throw invalidState('The target lead has itself been merged — merge into the lead it points to');

  // the target inherits what it is missing (never overwrites)
  const fill: Partial<Lead> = {};
  for (const k of ['email', 'pincode', 'city', 'district', 'state', 'consumer_no', 'segment', 'customer_type', 'capacity_kw', 'requirement_text', 'timeline_bucket', 'budget_inr', 'decision_maker'] as const) {
    if ((dst[k] === null || dst[k] === undefined || dst[k] === '') && src[k] !== null && src[k] !== undefined && src[k] !== '') (fill as Record<string, unknown>)[k] = src[k];
  }
  if (Object.keys(fill).length) await saveLead(ctx, dst.id, fill);

  // active consents are carried over as new ledger rows that point back at their origin
  const existing = await ctx.db.table('lead_consents').all({ lead_id: dst.id, withdrawn_at: null });
  for (const c of await ctx.db.table('lead_consents').all({ lead_id: src.id, withdrawn_at: null })) {
    const dup = existing.some((e) => e.notice_version === c.notice_version && e.purposes.slice().sort().join() === c.purposes.slice().sort().join() && e.channels.slice().sort().join() === c.channels.slice().sort().join());
    if (!dup) await recordConsent(ctx, { lead: dst, notice_version: c.notice_version, purposes: c.purposes, channels: c.channels, proof_ref: `merged from lead ${src.id}${c.proof_ref ? `: ${c.proof_ref}` : ''}`, capture_source: 'merge', granted_at: c.granted_at, recipients_named: c.recipients_named, ip: c.ip, user_agent: c.user_agent });
  }

  await cancelFollowups(ctx, src.id, 'merged');
  await ctx.svc.clocks.cancel('lead', src.id);
  const { after } = await saveLead(ctx, src.id, {
    status: 'merged', duplicate_of: dst.id, last_action: `Merged into ${dst.name}`, last_action_at: iso(ctx.now()), next_action: 'None — merged into another lead',
    next_followup_at: src.next_followup_at ?? iso(ctx.now()), owner_id: src.owner_id ?? dst.owner_id,
  });
  await logLeadEvent(ctx, src.id, 'merged', `Merged into lead ${dst.name}${note ? ` — ${note}` : ''}`, { into_lead_id: dst.id, note: note ?? null });
  await logLeadEvent(ctx, dst.id, 'merged_in', `Lead from ${src.source} merged in${note ? ` — ${note}` : ''}`, { source_lead_id: src.id, filled_fields: Object.keys(fill), note: note ?? null });
  await audit(ctx, { action: 'lead.merge', table: 'leads', record_id: src.id, old: { status: src.status } as Json, new: { status: 'merged', duplicate_of: dst.id } as Json });
  await recomputeLeadScore(ctx, dst.id);
  return { source: after, target: await getLead(ctx, dst.id) };
}

/** A dealer or manager asks for a duplicate (locked to someone else) to be released as an independent lead. */
export async function requestLockOverride(ctx: AppContext, leadId: string, reason: string): Promise<Lead> {
  const lead = await getLead(ctx, leadId);
  if (lead.status !== 'duplicate') throw invalidState('Only a lead marked as a duplicate can be put forward for a lock override');
  const { after } = await saveLead(ctx, leadId, { lock_status: 'override_pending', last_action: 'Lock override requested', last_action_at: iso(ctx.now()), next_action: 'Sales Manager to approve or reject the lock override' });
  await logLeadEvent(ctx, leadId, 'lock_override_requested', `Lock override requested: ${reason}`, { reason, requested_by: actorId(ctx), duplicate_of: lead.duplicate_of });
  await audit(ctx, { action: 'lead.lock_override_request', table: 'leads', record_id: leadId, detail: { reason, duplicate_of: lead.duplicate_of } as Json });
  const managers = await ctx.db.table('profiles').all({ role: ['sales_manager', 'regional_head'], active: true });
  await notifyStaff(ctx, {
    user_ids: [...managers.map((m) => m.id), ...(await dsmIds(ctx, lead.territory_id))], kind: 'lead.lock_override_requested', severity: 'warning', lead_id: leadId, email: true,
    title: `Lock override requested — ${lead.name}`, body: reason,
  });
  return after;
}

/** Sales Manager decision. Approve → the lead becomes independent and is routed; reject → it stays a duplicate and the existing owner's lock stands. */
export async function decideLockOverride(ctx: AppContext, leadId: string, decision: 'approve' | 'reject', note?: string | null): Promise<Lead> {
  const lead = await getLead(ctx, leadId);
  if (lead.status !== 'duplicate') throw invalidState('Only a lead marked as a duplicate has an override to decide');
  const now = iso(ctx.now());
  const original = lead.duplicate_of ? await ctx.db.table('leads').get(lead.duplicate_of) : null;
  if (lead.duplicate_of && !original) throw notFound('Original lead');

  if (decision === 'reject') {
    const { after } = await saveLead(ctx, leadId, {
      lock_status: 'locked', locked_by_dealer_id: original?.locked_by_dealer_id ?? lead.locked_by_dealer_id, last_action: 'Lock override rejected', last_action_at: now,
      next_action: 'None — the existing owner keeps this customer', next_followup_at: lead.next_followup_at ?? now,
    });
    await logLeadEvent(ctx, leadId, 'lock_override_rejected', `Lock override rejected${note ? `: ${note}` : ''}`, { note: note ?? null, duplicate_of: lead.duplicate_of });
    await audit(ctx, { action: 'lead.lock_override_reject', table: 'leads', record_id: leadId, detail: { note: note ?? null } as Json });
    if (lead.owner_id) await notifyStaff(ctx, { user_ids: [lead.owner_id], kind: 'lead.lock_override_rejected', severity: 'info', lead_id: leadId, title: `Lock override rejected — ${lead.name}`, body: note ?? 'The existing owner keeps this customer.' });
    return after;
  }

  const nextCheck = await workingMinutesFrom(ctx, 120);
  await saveLead(ctx, leadId, {
    status: 'validated', duplicate_of: null, lock_status: lead.dealer_id ? 'locked' : 'open', locked_by_dealer_id: lead.dealer_id,
    last_action: 'Lock override approved — independent lead', last_action_at: now, next_action: 'Route the lead to a distributor', next_followup_at: iso(nextCheck),
  });
  await logLeadEvent(ctx, leadId, 'lock_override_approved', `Lock override approved${note ? `: ${note}` : ''} — now an independent lead`, { note: note ?? null, previously_duplicate_of: lead.duplicate_of });
  await audit(ctx, { action: 'lead.lock_override_approve', table: 'leads', record_id: leadId, detail: { note: note ?? null, previously_duplicate_of: lead.duplicate_of } as Json });
  const routed = await routeLead(ctx, await getLead(ctx, leadId), { step: 'auto', reason: 'Manager approved the lock override — routed as an independent lead' });
  return routed.lead;
}
