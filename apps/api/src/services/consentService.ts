/**
 * Gate G1 — may we send this purpose on this channel to this lead right now? (Appendix A “Consent rules”, flow diagram §9.)
 *
 *  promotional           → a non-withdrawn consent covering purpose `promotional` AND the channel;
 *                          on telecom channels (call / SMS / WhatsApp) DND must be `clear` and the scrub not older than
 *                          `compliance.dnd_scrub_max_age_days` (30); no opt-out suppression (`trai.optout_reconsent_block_days`, 90).
 *  service / transactional → a non-withdrawn consent covering `service` (or `quotation`) AND the channel,
 *                          OR (WhatsApp only) an open customer-service window (last inbound < `whatsapp.service_window_hours`, 24).
 *
 * DND is not applied to e-mail: the preference register concerns telecom traffic; an e-mail needs consent + no suppression.
 */
import { hashMobile, type ConsentChannel, type DndStatus, type Lead, type LeadConsent, type MessagePurpose } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { notFound } from '../http/errors';
import type { ConsentService, OutboundBlockCode, OutboundCheck } from './contracts';
import { ruleOr, TELECOM_CHANNELS } from './leadServiceSettings';

const DAY_MS = 24 * 3600 * 1000;
export const OPTOUT_TEMPLATE_KEY = 'inbound_optout';

export const getWindowHours = (ctx: AppContext): Promise<number> => ruleOr<number>(ctx, 'whatsapp.service_window_hours', 24);
export const getDndMaxAgeDays = (ctx: AppContext): Promise<number> => ruleOr<number>(ctx, 'compliance.dnd_scrub_max_age_days', 30);
export const getOptoutBlockDays = (ctx: AppContext): Promise<number> => ruleOr<number>(ctx, 'trai.optout_reconsent_block_days', 90);

/* ───────────── WhatsApp customer-service window ───────────── */
/** Time of the customer's latest genuine inbound WhatsApp message (an opt-out keyword never opens the window). */
export async function lastInboundWhatsAppAt(ctx: AppContext, leadId: string): Promise<string | null> {
  const { rows } = await ctx.db.table('message_log').list({ where: { lead_id: leadId, direction: 'inbound', channel: 'whatsapp' }, orderBy: { col: 'created_at', dir: 'desc' }, limit: 20 });
  return rows.find((r) => r.template_key !== OPTOUT_TEMPLATE_KEY && r.status !== 'blocked')?.created_at ?? null;
}
export const windowClosesAt = (lastInbound: string | null, windowHours: number): Date | null => (lastInbound ? new Date(new Date(lastInbound).getTime() + windowHours * 3600 * 1000) : null);
export const isWindowOpen = (lastInbound: string | null, windowHours: number, now: Date): boolean => {
  const closes = windowClosesAt(lastInbound, windowHours);
  return !!closes && closes.getTime() > now.getTime();
};

/* ───────────── pure evaluation ───────────── */
export interface OutboundFacts {
  lead: Pick<Lead, 'dnd_status' | 'dnd_checked_at' | 'mobile' | 'email' | 'anonymised_at'>;
  consents: LeadConsent[]; now: Date; windowHours: number; dndMaxAgeDays: number; lastInboundAt: string | null;
}

export const activeSuppressionUntil = (consents: Pick<LeadConsent, 'optout_suppress_until'>[], now: Date): Date | null => {
  let latest: Date | null = null;
  for (const c of consents) {
    if (!c.optout_suppress_until) continue;
    const d = new Date(c.optout_suppress_until);
    if (d.getTime() > now.getTime() && (!latest || d > latest)) latest = d;
  }
  return latest;
};

export function dndFreshness(lead: Pick<Lead, 'dnd_status' | 'dnd_checked_at'>, now: Date, maxAgeDays: number): { status: DndStatus; fresh: boolean } {
  const checked = lead.dnd_checked_at ? new Date(lead.dnd_checked_at) : null;
  return { status: lead.dnd_status, fresh: !!checked && now.getTime() - checked.getTime() <= maxAgeDays * DAY_MS };
}

export function evaluateOutbound(f: OutboundFacts, channel: ConsentChannel, purpose: MessagePurpose): OutboundCheck {
  const reasons: OutboundCheck['reasons'] = [];
  const add = (code: OutboundBlockCode, message: string) => reasons.push({ code, message });
  const promo = purpose === 'promotional';
  const windowOpen = channel === 'whatsapp' ? isWindowOpen(f.lastInboundAt, f.windowHours, f.now) : undefined;
  const base: Pick<OutboundCheck, 'whatsapp_window_open'> = channel === 'whatsapp' ? { whatsapp_window_open: windowOpen === true } : {};

  const hasContact = channel === 'email' ? !!f.lead.email : !!f.lead.mobile;
  if (f.lead.anonymised_at || !hasContact) {
    add('NO_CONTACT', channel === 'email' ? 'No e-mail address on file for this lead' : 'No mobile number on file for this lead');
    return { allowed: false, consent_id: null, reasons, ...base };
  }

  const active = f.consents.filter((c) => !c.withdrawn_at);
  const wanted: string[] = promo ? ['promotional'] : ['service', 'quotation'];
  const covering = active
    .filter((c) => c.channels.includes(channel) && c.purposes.some((p) => wanted.includes(p)))
    .sort((a, b) => b.granted_at.localeCompare(a.granted_at));
  const suppressed = activeSuppressionUntil(f.consents, f.now);
  const serviceViaWindow = !promo && windowOpen === true;

  if (!covering.length && !serviceViaWindow) {
    if (!f.consents.length) add('NO_CONSENT', 'No consent has been recorded for this person yet');
    else if (!active.length) add('WITHDRAWN', 'The customer has withdrawn consent');
    else if (!active.some((c) => c.purposes.some((p) => wanted.includes(p)))) add('PURPOSE_NOT_CONSENTED', promo ? 'The customer has not consented to promotional messages' : 'The customer has not consented to service messages');
    else add('CHANNEL_NOT_CONSENTED', `The customer has not consented to ${channel === 'sms' ? 'SMS' : channel === 'whatsapp' ? 'WhatsApp' : channel} contact`);
  }

  if (suppressed && !serviceViaWindow) {
    add('SUPPRESSED_90_DAY', `The customer opted out; contact is suppressed until ${suppressed.toISOString().slice(0, 10)}`);
  }

  if (promo && (TELECOM_CHANNELS as readonly string[]).includes(channel)) {
    const dnd = dndFreshness(f.lead, f.now, f.dndMaxAgeDays);
    if (dnd.status === 'registered' || dnd.status === 'blocked') add('DND_REGISTERED', 'The number is on the Do-Not-Disturb register — promotional contact is not allowed');
    else if (dnd.status === 'unchecked') add('DND_UNCHECKED', 'The number has not been scrubbed against the DND register yet');
    else if (!dnd.fresh) add('DND_STALE', `The DND scrub is older than ${f.dndMaxAgeDays} days — scrub the number again`);
  }

  const allowed = reasons.length === 0;
  return { allowed, consent_id: allowed ? covering[0]?.id ?? null : null, reasons, ...base };
}

/* ───────────── DND scrub ───────────── */
export interface DndScrubResult { status: DndStatus; checked_at: string | null; source: string; cached: boolean }

/**
 * Scrubs a mobile (E.164) against the DND register through the provider and upserts the hashed result in `dnd_register`.
 * A scrub newer than `compliance.dnd_scrub_max_age_days` is reused unless `force`. A provider failure leaves the number `unchecked`.
 */
export async function scrubDnd(ctx: AppContext, mobile: string, opts: { force?: boolean } = {}): Promise<DndScrubResult> {
  const hash = hashMobile(mobile);
  const reg = ctx.db.table('dnd_register');
  const row = await reg.one({ mobile_hash: hash });
  const maxAge = await getDndMaxAgeDays(ctx);
  if (row && !opts.force && ctx.now().getTime() - new Date(row.checked_at).getTime() <= maxAge * DAY_MS) {
    return { status: row.status, checked_at: row.checked_at, source: row.source, cached: true };
  }
  let result: 'clear' | 'registered' | 'blocked';
  try {
    result = await ctx.providers.dnd.check(mobile);
  } catch (e) {
    ctx.log.warn({ err: e }, 'DND scrub failed — number left unchecked');
    return { status: 'unchecked', checked_at: null, source: ctx.providers.dnd.name, cached: false };
  }
  const checked_at = ctx.now().toISOString();
  if (row) await reg.update(row.id, { status: result, checked_at, source: ctx.providers.dnd.name });
  else await reg.insert({ mobile_hash: hash, status: result, checked_at, source: ctx.providers.dnd.name });
  return { status: result, checked_at, source: ctx.providers.dnd.name, cached: false };
}

/** Scrub and mirror the result on `leads.dnd_status` / `dnd_checked_at`. */
export async function scrubLeadDnd(ctx: AppContext, lead: Pick<Lead, 'id' | 'mobile'>, opts: { force?: boolean } = {}): Promise<DndScrubResult> {
  const r = await scrubDnd(ctx, lead.mobile, opts);
  if (r.status !== 'unchecked') await ctx.db.table('leads').update(lead.id, { dnd_status: r.status, dnd_checked_at: r.checked_at });
  return r;
}

/* ───────────── the service other modules use through ctx.svc.consent ───────────── */
export async function loadOutboundFacts(ctx: AppContext, lead: Lead, channel: ConsentChannel): Promise<OutboundFacts> {
  const [consents, windowHours, dndMaxAgeDays, lastInboundAt] = await Promise.all([
    ctx.db.table('lead_consents').all({ lead_id: lead.id }), getWindowHours(ctx), getDndMaxAgeDays(ctx),
    channel === 'whatsapp' ? lastInboundWhatsAppAt(ctx, lead.id) : Promise.resolve(null),
  ]);
  return { lead, consents, now: ctx.now(), windowHours, dndMaxAgeDays, lastInboundAt };
}

export function createConsentService(ctx: AppContext): ConsentService {
  return {
    async checkOutbound(leadId, input) {
      const lead = await ctx.db.table('leads').get(leadId);
      if (!lead) throw notFound('Lead');
      return evaluateOutbound(await loadOutboundFacts(ctx, lead, input.channel), input.channel, input.purpose);
    },
  };
}
