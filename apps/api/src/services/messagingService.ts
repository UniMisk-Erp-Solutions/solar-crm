/**
 * The consent-aware send pipeline — the ONLY way application code sends a customer message (flow diagram §9).
 * Consent / DND / suppression / WhatsApp window are checked through `ctx.svc.consent` first; every attempt, including blocked
 * ones, is written to `message_log` with the structured reasons. Calls are logged only (no provider).
 */
import { maskEmail, maskMobile, type Lead, type MessageLog, type MessageTemplate, type TemplateCategory } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { notFound } from '../http/errors';
import type { MessagingService, OutboundBlockCode, OutboundCheck, SendInput, SendResult } from './contracts';
import { OPTOUT_TEMPLATE_KEY } from './consentService';
import { unsubscribeToken } from './consentServiceLedger';
import { actorId, notifyStaff } from './leadServiceStore';

type Reason = OutboundCheck['reasons'][number];

/** `{{name}}` / `{{unsubscribe_url}}` plus caller variables; unknown placeholders render empty. */
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => vars[key] ?? '');
}

export function unsubscribeUrl(ctx: AppContext, leadId: string): string {
  const base = ctx.config.corsOrigins[0] ?? ctx.config.PUBLIC_API_URL;
  return `${base.replace(/\/$/, '')}/unsubscribe?token=${unsubscribeToken(leadId)}`;
}

/** Template for this key and channel: the lead's language first, then English, highest version. */
export async function findTemplate(ctx: AppContext, key: string, channel: MessageTemplate['channel'], language: Lead['language']): Promise<MessageTemplate | null> {
  const all = await ctx.db.table('message_templates').all({ key, channel, active: true });
  if (!all.length) return null;
  const rank = (t: MessageTemplate) => (t.language === language ? 0 : t.language === 'en' ? 1 : 2);
  return [...all].sort((a, b) => rank(a) - rank(b) || b.version - a.version)[0]!;
}

/** Template purpose and WhatsApp category must fit the purpose of the message being sent. */
function templateFits(t: MessageTemplate, purpose: SendInput['purpose']): string | null {
  const promoTemplate = t.purpose === 'promotional';
  if ((purpose === 'promotional') !== promoTemplate) return purpose === 'promotional' ? 'This template is registered for service messages, not promotional use' : 'This template is registered as promotional and cannot carry a service message';
  if (t.channel === 'whatsapp') {
    if (purpose === 'promotional' && t.category !== 'marketing') return 'Promotional WhatsApp messages must use a marketing-category template';
    if (purpose !== 'promotional' && t.category === 'marketing') return 'A marketing-category template cannot be used for a service message';
  }
  return null;
}

const preview = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 160);

interface FinishExtra {
  tpl?: MessageTemplate | null; body?: string; category?: TemplateCategory | null; consent_id?: string | null;
  provider?: string | null; provider_ref?: string | null; block_reason?: string | null;
}
type ProviderCall = () => Promise<{ ok: boolean; provider: string; ref: string | null; error?: string }>;

export function createMessagingService(ctx: AppContext): MessagingService {
  return {
    async send(input: SendInput): Promise<SendResult> {
      const lead = await ctx.db.table('leads').get(input.lead_id);
      if (!lead || lead.deleted_at) throw notFound('Lead');
      const { channel, purpose } = input;
      const toMasked = channel === 'email' ? (lead.email ? maskEmail(lead.email) : null) : lead.mobile ? maskMobile(lead.mobile) : null;

      /** Writes the message_log row (blocked attempts included) and builds the result. */
      const finish = async (status: SendResult['status'], reasons: Reason[], x: FinishExtra = {}): Promise<SendResult> => {
        const row = await ctx.db.table('message_log').insert({
          lead_id: lead.id, channel, purpose, category: x.category ?? null, template_key: x.tpl?.key ?? input.template_key ?? null, direction: 'outbound', to_masked: toMasked,
          body_preview: x.body ? preview(x.body) : null, status, block_reason: reasons.length ? reasons.map((r) => r.code).join(',') : x.block_reason ?? null,
          consent_id: x.consent_id ?? null, provider: x.provider ?? null, provider_ref: x.provider_ref ?? null, created_by: actorId(ctx),
        });
        if (status === 'blocked' && lead.owner_id && lead.owner_id !== actorId(ctx)) {
          await notifyStaff(ctx, {
            user_ids: [lead.owner_id], kind: 'message.blocked', severity: 'warning', lead_id: lead.id, title: 'A message to a customer was blocked',
            body: `${lead.name}: ${reasons.map((r) => r.message).join('; ')}`,
          });
        }
        return { status, blocked: status === 'blocked', reasons, message_log_id: row.id, template_category: x.category ?? null };
      };
      const block = (code: OutboundBlockCode, message: string, x: FinishExtra = {}) => finish('blocked', [{ code, message }], x);

      // in-app is staff-facing: a notification to the lead owner, no customer consent involved
      if (channel === 'in_app') {
        if (lead.owner_id) await notifyStaff(ctx, { user_ids: [lead.owner_id], kind: 'lead.note', lead_id: lead.id, title: input.subject ?? 'Lead update', body: input.body });
        return finish('sent', [], { body: input.body ?? input.subject ?? '', provider: 'in-app' });
      }

      const check = await ctx.svc.consent.checkOutbound(lead.id, { channel, purpose });
      if (!check.allowed) return finish('blocked', check.reasons, { body: input.body });

      // ── find and render the template ──
      let tpl: MessageTemplate | null = null;
      if (input.template_key) {
        tpl = await findTemplate(ctx, input.template_key, channel, lead.language);
        const bad = !tpl ? `Template “${input.template_key}” was not found or is inactive for ${channel}` : templateFits(tpl, purpose);
        if (bad) return block('NO_TEMPLATE', bad, { body: input.body });
      }
      const vars = { name: lead.name.split(/\s+/)[0] ?? lead.name, unsubscribe_url: unsubscribeUrl(ctx, lead.id), ...(input.vars ?? {}) };
      const text = renderTemplate(input.body ?? tpl?.body ?? '', vars);
      const base: FinishExtra = { tpl, body: text, consent_id: check.consent_id };

      const deliver = async (category: TemplateCategory, body: string, go: ProviderCall): Promise<SendResult> => {
        try {
          const r = await go();
          if (!r.ok) return finish('failed', [], { ...base, body, category, provider: r.provider, provider_ref: r.ref, block_reason: `provider_error: ${r.error ?? 'rejected'}` });
          return finish('sent', [], { ...base, body, category, provider: r.provider, provider_ref: r.ref });
        } catch (e) {
          ctx.log.error({ err: e }, 'message provider threw');
          return finish('failed', [], { ...base, body, category, block_reason: 'provider_error: provider unavailable' });
        }
      };
      const freeCategory: TemplateCategory = purpose === 'promotional' ? 'marketing' : 'service';

      // ── channel specifics ──
      if (channel === 'call') return finish('sent', [], { ...base, provider: 'call-log' }); // calls are only logged

      if (channel === 'sms') {
        if (!tpl || !tpl.dlt_template_id || !tpl.dlt_header) {
          return block('NO_TEMPLATE', 'SMS can only be sent with a DLT-registered template (template id and sender header are mandatory)', base);
        }
        const t = tpl;
        const body = renderTemplate(t.body, vars);
        return deliver(t.category, body, () => ctx.providers.sms.send({ to: lead.mobile, body, dlt_template_id: t.dlt_template_id!, dlt_header: t.dlt_header! }));
      }

      if (channel === 'email') {
        if (!text.trim()) return block('NO_TEMPLATE', 'The e-mail has no body', base);
        const subject = renderTemplate(input.subject ?? tpl?.subject ?? 'A message from Future Solar', vars);
        const full = text + (purpose === 'promotional' ? `

—
To stop receiving promotional e-mails: ${vars.unsubscribe_url}` : '');
        return deliver(tpl?.category ?? freeCategory, full, () => ctx.providers.email.send({ to: lead.email!, subject, text: full, attachments: input.attachments }));
      }

      // WhatsApp: free-form only inside the 24-hour window, otherwise an approved template
      if (check.whatsapp_window_open && text.trim()) {
        return deliver(tpl?.category ?? freeCategory, text, () => ctx.providers.whatsapp.sendSession({ to: lead.mobile, body: text }));
      }
      if (!tpl) return block('WHATSAPP_WINDOW_CLOSED', 'The 24-hour customer-service window is closed — only an approved WhatsApp template can be sent', base);
      const t = tpl;
      if (!t.whatsapp_template_name) return block('NO_TEMPLATE', 'This template has no approved WhatsApp template name', base);
      return deliver(t.category, text, () => ctx.providers.whatsapp.sendTemplate({ to: lead.mobile, template_name: t.whatsapp_template_name!, category: t.category, language: t.language, vars }));
    },
  };
}

/* ───────────── inbound ───────────── */
export interface InboundRecord { lead_id: string | null; from_masked: string; body: string; provider_ref: string | null; optout: boolean }

/**
 * Logs a customer's WhatsApp message (direction inbound). A genuine message opens the 24-hour service window; an opt-out
 * keyword is logged but never opens it. Time is the receipt time of the webhook (the test clock in tests).
 */
export async function recordInboundWhatsApp(ctx: AppContext, rec: InboundRecord): Promise<MessageLog> {
  return ctx.db.table('message_log').insert({
    lead_id: rec.lead_id, channel: 'whatsapp', purpose: 'service', category: 'service', template_key: rec.optout ? OPTOUT_TEMPLATE_KEY : null, direction: 'inbound',
    to_masked: rec.from_masked, body_preview: preview(rec.body), status: 'sent', block_reason: null, consent_id: null, provider: ctx.providers.whatsapp.name,
    provider_ref: rec.provider_ref, created_by: null, created_at: ctx.now().toISOString(),
  });
}
