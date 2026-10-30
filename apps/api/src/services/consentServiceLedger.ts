/**
 * The consent ledger: immutable `lead_consents` rows, one-click withdrawal with 90-day suppression that propagates to every
 * named recipient, and the HMAC-signed unsubscribe token that goes into outbound templates.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { formatDate, type ConsentChannel, type ConsentPurpose, type Json, type Lead, type LeadConsent } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { audit } from '../lib/audit';
import { activeSuppressionUntil, getOptoutBlockDays } from './consentService';
import { actorId, getLead, logLeadEvent, notifyStaff } from './leadServiceStore';
import { recomputeLeadScore } from './scoring';

/* ───────────── recipients ───────────── */
/** Legal names the customer is told will contact them: Future Solar plus the routed distributor and dealer. */
export async function resolveRecipients(ctx: AppContext, lead: Pick<Lead, 'distributor_id' | 'dealer_id'>, extra: string[] = []): Promise<string[]> {
  const names: string[] = [];
  const org = await ctx.db.table('organizations').get(ctx.org_id);
  if (org) names.push(org.legal_name);
  if (lead.distributor_id) { const d = await ctx.db.table('distributors').get(lead.distributor_id); if (d) names.push(d.legal_name); }
  if (lead.dealer_id) { const d = await ctx.db.table('dealers').get(lead.dealer_id); if (d) names.push(d.legal_name); }
  return [...new Set([...names, ...extra].map((n) => n.trim()).filter(Boolean))];
}

export interface RecordConsentInput {
  lead: Pick<Lead, 'id' | 'distributor_id' | 'dealer_id'>;
  notice_version: string; purposes: ConsentPurpose[]; channels: ConsentChannel[]; proof_ref?: string | null; capture_source?: string | null;
  recipients_named?: string[]; granted_at?: string; ip?: string | null; user_agent?: string | null;
}

/** Appends one row to the ledger (never edited afterwards, only withdrawn), logs it and refreshes the lead score. */
export async function recordConsent(ctx: AppContext, i: RecordConsentInput): Promise<LeadConsent> {
  const recipients = i.recipients_named ?? (await resolveRecipients(ctx, i.lead));
  const row = await ctx.db.table('lead_consents').insert({
    lead_id: i.lead.id, notice_version: i.notice_version, purposes: [...new Set(i.purposes)], channels: [...new Set(i.channels)], recipients_named: recipients,
    granted_at: i.granted_at ?? ctx.now().toISOString(), ip: i.ip === undefined ? ctx.ip : i.ip, user_agent: i.user_agent === undefined ? ctx.userAgent : i.user_agent, proof_ref: i.proof_ref ?? null,
    capture_source: i.capture_source ?? null, withdrawn_at: null, withdrawn_by: null, withdrawal_channel: null, optout_suppress_until: null,
    created_by: ctx.system ? null : ctx.user.id,
  });
  await logLeadEvent(ctx, i.lead.id, 'consent_recorded', `Consent recorded for ${row.purposes.join(', ')} on ${row.channels.join(', ')}`, {
    consent_id: row.id, notice_version: row.notice_version, purposes: row.purposes, channels: row.channels, recipients, capture_source: row.capture_source, proof_ref: row.proof_ref,
  });
  await audit(ctx, { action: 'consent.record', table: 'lead_consents', record_id: row.id, new: { lead_id: row.lead_id, notice_version: row.notice_version, purposes: row.purposes, channels: row.channels } as Json });
  await recomputeLeadScore(ctx, i.lead.id);
  return row;
}

/* ───────────── withdrawal and suppression ───────────── */
export interface WithdrawResult { withdrawn: number; suppress_until: string; propagated_lead_ids: string[]; recipients: string[]; notified: number }

async function withdrawOnLead(ctx: AppContext, leadId: string, untilIso: string, channel: string, reason: string | null): Promise<{ rows: number; recipients: string[] }> {
  const repo = ctx.db.table('lead_consents');
  const rows = await repo.all({ lead_id: leadId });
  const now = ctx.now().toISOString();
  const recipients = new Set<string>(rows.flatMap((r) => r.recipients_named));
  let touched = 0;
  for (const r of rows) {
    if (!r.withdrawn_at) {
      await repo.update(r.id, { withdrawn_at: now, withdrawn_by: actorId(ctx), withdrawal_channel: channel, optout_suppress_until: untilIso });
      touched++;
    } else if (!r.optout_suppress_until || r.optout_suppress_until < untilIso) {
      await repo.update(r.id, { optout_suppress_until: untilIso }); // an extra STOP extends the bar
    }
  }
  if (!rows.length) {
    // opt-out before any consent was ever recorded: a withdrawn marker row carries the suppression date
    await repo.insert({
      lead_id: leadId, notice_version: 'opt-out', purposes: [], channels: [], recipients_named: [], granted_at: now, ip: ctx.ip, user_agent: ctx.userAgent,
      proof_ref: reason, capture_source: 'optout_marker', withdrawn_at: now, withdrawn_by: actorId(ctx), withdrawal_channel: channel, optout_suppress_until: untilIso,
      created_by: ctx.system ? null : ctx.user.id,
    });
    touched++;
  }
  return { rows: touched, recipients: [...recipients] };
}

/**
 * Full opt-out. Withdraws every active consent on the lead (and on every other lead with the same mobile — it is the same person),
 * bars promotional contact for `trai.optout_reconsent_block_days` (90), tells every named recipient (distributor and dealer users
 * and the lead owners) and writes `lead_events` + `audit_log`.
 */
export async function withdrawConsents(ctx: AppContext, leadId: string, opts: { channel: string; reason?: string | null }): Promise<WithdrawResult> {
  const lead = await getLead(ctx, leadId);
  const days = await getOptoutBlockDays(ctx);
  const until = new Date(ctx.now().getTime() + days * 24 * 3600 * 1000).toISOString();
  const same = (await ctx.db.table('leads').all({ mobile: lead.mobile })).filter((l) => l.id !== lead.id && !l.deleted_at && l.status !== 'merged');
  const targets = [lead, ...same];
  const recipients = new Set<string>();
  let withdrawn = 0;
  for (const t of targets) {
    const r = await withdrawOnLead(ctx, t.id, until, opts.channel, opts.reason ?? null);
    withdrawn += r.rows;
    r.recipients.forEach((n) => recipients.add(n));
    for (const n of await resolveRecipients(ctx, t)) recipients.add(n);
    await recomputeLeadScore(ctx, t.id);
  }
  const names = [...recipients];
  const propagated = same.map((l) => l.id);

  // tell the named recipients' users and the people working the leads
  const userIds = new Set<string>();
  const distributors = names.length ? await ctx.db.table('distributors').all({ legal_name: names }) : [];
  const dealers = names.length ? await ctx.db.table('dealers').all({ legal_name: names }) : [];
  for (const d of distributors) for (const p of await ctx.db.table('profiles').all({ distributor_id: d.id, role: 'distributor_user', active: true })) userIds.add(p.id);
  for (const d of dealers) for (const p of await ctx.db.table('profiles').all({ dealer_id: d.id, role: 'dealer_user', active: true })) userIds.add(p.id);
  for (const t of targets) if (t.owner_id) userIds.add(t.owner_id);
  const notified = await notifyStaff(ctx, {
    user_ids: [...userIds], kind: 'consent.withdrawn', severity: 'warning', lead_id: lead.id, email: true,
    title: 'Customer opted out of contact', body: `${lead.name} withdrew consent. Do not send promotional messages until ${formatDate(until)}.`,
  });

  const detail: Record<string, Json> = { channel: opts.channel, reason: opts.reason ?? null, suppress_until: until, block_days: days, recipients: names, propagated_to: propagated };
  await logLeadEvent(ctx, lead.id, 'consent_withdrawn', `Consent withdrawn (${opts.channel}); promotional contact suppressed until ${formatDate(until)}`, detail);
  for (const t of same) await logLeadEvent(ctx, t.id, 'consent_suppression_propagated', `Opt-out on another enquiry from the same number; contact suppressed until ${formatDate(until)}`, { source_lead_id: lead.id, suppress_until: until });
  await audit(ctx, { action: 'consent.withdraw', table: 'leads', record_id: lead.id, detail: { ...detail, rows_withdrawn: withdrawn } as Json });
  return { withdrawn, suppress_until: until, propagated_lead_ids: propagated, recipients: names, notified };
}

/** A new enquiry from a number that opted out in the last 90 days inherits the suppression (a withdrawn marker row on the new lead). */
export async function inheritSuppression(ctx: AppContext, lead: Pick<Lead, 'id' | 'mobile'>): Promise<string | null> {
  const others = (await ctx.db.table('leads').all({ mobile: lead.mobile })).filter((l) => l.id !== lead.id);
  if (!others.length) return null;
  const consents = await ctx.db.table('lead_consents').all({ lead_id: others.map((l) => l.id) });
  const until = activeSuppressionUntil(consents, ctx.now());
  if (!until) return null;
  const now = ctx.now().toISOString();
  await ctx.db.table('lead_consents').insert({
    lead_id: lead.id, notice_version: 'opt-out', purposes: [], channels: [], recipients_named: [], granted_at: now, ip: ctx.ip, user_agent: ctx.userAgent,
    proof_ref: 'inherited from an earlier opt-out of the same number', capture_source: 'optout_marker', withdrawn_at: now, withdrawn_by: null, withdrawal_channel: 'inherited',
    optout_suppress_until: until.toISOString(), created_by: null,
  });
  await logLeadEvent(ctx, lead.id, 'consent_suppression_inherited', `This number opted out earlier; promotional contact is suppressed until ${formatDate(until.toISOString())}`, { suppress_until: until.toISOString() });
  return until.toISOString();
}

/* ───────────── unsubscribe token (HMAC-signed, no expiry — it lives in old messages) ───────────── */
const fallbackSecret = randomBytes(32).toString('hex');
const secret = (): string => process.env['UNSUBSCRIBE_TOKEN_SECRET'] || process.env['FILE_TOKEN_SECRET'] || fallbackSecret;
const sign = (body: string): string => createHmac('sha256', secret()).update(`unsubscribe:${body}`).digest('base64url');

/** Token placed in outbound templates (`{{unsubscribe_url}}`). Set UNSUBSCRIBE_TOKEN_SECRET so links survive restarts and span instances. */
export function unsubscribeToken(leadId: string): string {
  const body = Buffer.from(JSON.stringify({ l: leadId, v: 1 })).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** Lead id inside a valid token, otherwise null. */
export function verifyUnsubscribeToken(token: string): string | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const good = sign(body);
  if (good.length !== sig.length || !timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { l?: unknown; v?: unknown };
    return p.v === 1 && typeof p.l === 'string' ? p.l : null;
  } catch { return null; }
}
