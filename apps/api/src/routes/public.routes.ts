import { Router, type RequestHandler } from 'express';
import {
  PINCODE_RE, leadConsentNoticeQuerySchema, leadUnsubscribeSchema, maskMobile, publicLeadInputSchema, scanForAadhaar, sha256Hex,
  type Json, type LeadSource, type SourceApiKey,
} from '@solar/shared';
import type { AppDeps } from '../deps';
import { buildContext, systemUser } from '../deps';
import { AppError } from '../http/errors';
import { publicLimiter } from '../http/guards';
import { body, parse, wrap } from '../http/handler';
import { verifyUnsubscribeToken, withdrawConsents } from '../services/consentServiceLedger';
import { captureLead } from '../services/leadIntake';
import { captureCampaignLeads, normaliseCampaignPayload, processWhatsAppInbound } from '../services/leadIntakeWebhooks';
import { resolveGeo } from '../services/routing';

export const isPublicRouter = true;

const TOUCH_AFTER_MS = 5 * 60_000;

export const DEFAULT_CONSENT_NOTICE: Record<'en' | 'hi' | 'gu', string> = {
  en: 'I agree that Future Solar and its authorised distributor and dealer named to me may contact me by call, SMS, WhatsApp and e-mail about my solar enquiry and related services. I understand I can withdraw this consent at any time, and that I can reply STOP to any message.',
  hi: 'मैं सहमत हूँ कि Future Solar तथा मुझे बताए गए अधिकृत वितरक और डीलर मेरी सोलर पूछताछ और संबंधित सेवाओं के बारे में मुझसे कॉल, SMS, WhatsApp और ई-मेल से संपर्क कर सकते हैं। मैं जानता/जानती हूँ कि मैं यह सहमति कभी भी वापस ले सकता/सकती हूँ, और किसी भी संदेश के जवाब में STOP भेज सकता/सकती हूँ।',
  gu: 'હું સંમત છું કે Future Solar અને મને જણાવેલા અધિકૃત વિતરક અને ડીલર મારી સોલાર પૂછપરછ અને સંબંધિત સેવાઓ વિશે મને કૉલ, SMS, WhatsApp અને ઈ-મેલથી સંપર્ક કરી શકે છે. હું સમજું છું કે હું આ સંમતિ ગમે ત્યારે પાછી ખેંચી શકું છું અને કોઈ પણ સંદેશના જવાબમાં STOP મોકલી શકું છું.',
};

const PURPOSES = [
  { value: 'service', label: 'Updates and service messages about my enquiry' },
  { value: 'promotional', label: 'Offers and promotional messages' },
  { value: 'quotation', label: 'Quotations and proposals' },
  { value: 'subsidy_processing', label: 'Subsidy application processing' },
  { value: 'financing', label: 'Loan and financing assistance' },
];
const CHANNELS = [{ value: 'call', label: 'Phone call' }, { value: 'sms', label: 'SMS' }, { value: 'whatsapp', label: 'WhatsApp' }, { value: 'email', label: 'E-mail' }];

/**
 * Public, key-signed, rate-limited endpoints (no user session). The organisation is the one that owns the API key:
 *   POST /public/leads · POST /webhooks/campaign · GET|POST /webhooks/whatsapp · GET /public/consent-notice ·
 *   GET /public/pincode/:pin · GET|POST /public/unsubscribe
 * The key travels in the `X-Api-Key` header (webhook providers that cannot set headers may use `?key=`, Google lead forms their `google_key` field).
 */
export function createPublicRouter(deps: AppDeps): Router {
  const r = Router();
  const limiter = publicLimiter(deps.config);

  const lookupKey = async (raw: string | undefined | null): Promise<SourceApiKey | null> => {
    if (!raw || typeof raw !== 'string' || raw.length < 8 || raw.length > 200) return null;
    return deps.db.table('source_api_keys').one({ key_hash: sha256Hex(raw.trim()), active: true });
  };

  /** Authenticates the API key and attaches a system context for the key's organisation. */
  const keyed = (opts: { sources?: LeadSource[]; fromQuery?: boolean; fromBody?: boolean } = {}): RequestHandler => wrap(async (req, res, next) => {
    const bodyKey = opts.fromBody && req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>)['google_key'] : undefined;
    const raw = req.get('x-api-key') ?? (opts.fromQuery && typeof req.query['key'] === 'string' ? req.query['key'] : undefined) ?? (typeof bodyKey === 'string' ? bodyKey : undefined);
    if (!raw) throw new AppError(401, 'UNAUTHENTICATED', 'An API key is required (X-Api-Key header)');
    const key = await lookupKey(raw);
    if (!key) throw new AppError(401, 'UNAUTHENTICATED', 'The API key is not valid');
    if (opts.sources && !opts.sources.includes(key.source)) throw new AppError(403, 'FORBIDDEN', `This API key is for ${key.source} intake and cannot be used here`);
    const ctx = buildContext(deps, key.org_id, systemUser(key.org_id), { system: true, ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null, requestId: req.requestId });
    if (!key.last_used_at || ctx.now().getTime() - new Date(key.last_used_at).getTime() > TOUCH_AFTER_MS) await ctx.db.table('source_api_keys').update(key.id, { last_used_at: ctx.now().toISOString() });
    req.ctx = ctx;
    res.locals['apiKey'] = key;
    next();
  });
  const keyOf = (res: { locals: Record<string, unknown> }): SourceApiKey => res.locals['apiKey'] as SourceApiKey;
  const noAadhaar = (payload: unknown): void => {
    const hits = scanForAadhaar(payload);
    if (hits.length) throw new AppError(422, 'AADHAAR_BLOCKED', 'An Aadhaar number was detected. We do not store Aadhaar numbers — please remove it.', { fields: hits });
  };

  /* ── website form, call-centre entry, referral entry, dealer-uploaded lead: same payload, the key fixes the source ── */
  r.post('/public/leads', limiter, keyed(), wrap(async (req, res) => {
    const ctx = req.ctx!;
    const key = keyOf(res);
    noAadhaar(req.body);
    const input = body(publicLeadInputSchema, req);
    if (key.source === 'dealer_upload' && !input.dealer_id) throw new AppError(422, 'VALIDATION_ERROR', 'A dealer-uploaded lead must name the dealer', [{ path: 'dealer_id', message: 'dealer_id is required for dealer uploads' }]);
    const provenance = Object.fromEntries(Object.entries(input.provenance ?? {}).filter(([, v]) => v !== undefined)) as Record<string, Json>;
    const result = await captureLead(ctx, {
      source: key.source, origin: 'public', name: input.name, mobile: input.mobile, email: input.email ?? null, pincode: input.pincode, city: input.city, district: input.district, state: input.state,
      segment: input.segment, customer_type: input.customer_type, capacity_kw: input.capacity_kw, product_interest: input.product_interest, consumer_no: input.consumer_no,
      language: input.language, requirement_text: input.requirement_text, notes: input.notes, bill_captured: input.bill_captured, timeline_bucket: input.timeline_bucket ?? undefined, source_ref: input.source_ref,
      dealer_id: key.source === 'dealer_upload' ? input.dealer_id : undefined, provenance: { ...provenance, key_label: key.label },
      consent: input.consent ? { ...input.consent, proof_ref: input.consent.proof_ref ?? `${key.source}:${ctx.requestId}`, capture_source: input.consent.capture_source ?? key.source } : undefined,
    });
    // an anonymous caller learns nothing about duplicates or routing
    res.status(result.created ? 201 : 200).json({ data: { lead_id: result.lead.id, reference: `FS-${result.lead.id.slice(0, 8).toUpperCase()}`, received: true, consent_recorded: !!result.consent_id } });
  }));

  /* ── Meta Lead Ads / Google Ads lead-form webhook ── */
  r.post('/webhooks/campaign', limiter, keyed({ sources: ['campaign'], fromQuery: true, fromBody: true }), wrap(async (req, res) => {
    const ctx = req.ctx!;
    noAadhaar(req.body);
    const leads = normaliseCampaignPayload(req.body);
    if (!leads.length) throw new AppError(422, 'VALIDATION_ERROR', 'No lead found in the payload (expected Meta field_data or Google user_column_data)', [{ path: 'field_data', message: 'Missing lead fields' }]);
    const outcomes = await captureCampaignLeads(ctx, leads);
    res.json({ data: { received: leads.length, results: outcomes } });
  }));

  /* ── WhatsApp: Meta verification challenge (the verify token is the API key) and inbound messages ── */
  r.get('/webhooks/whatsapp', limiter, wrap(async (req, res) => {
    const token = typeof req.query['hub.verify_token'] === 'string' ? req.query['hub.verify_token'] : null;
    const challenge = typeof req.query['hub.challenge'] === 'string' ? req.query['hub.challenge'] : '';
    const key = req.query['hub.mode'] === 'subscribe' ? await lookupKey(token) : null;
    if (!key || key.source !== 'whatsapp') throw new AppError(403, 'FORBIDDEN', 'Webhook verification failed');
    res.status(200).type('text/plain').send(challenge);
  }));

  r.post('/webhooks/whatsapp', limiter, keyed({ sources: ['whatsapp'], fromQuery: true }), wrap(async (req, res) => {
    const summary = await processWhatsAppInbound(req.ctx!, req.body);
    res.json({ data: summary });
  }));

  /* ── lookups for the public form ── */
  r.get('/public/consent-notice', limiter, keyed(), wrap(async (req, res) => {
    const ctx = req.ctx!;
    const { lang } = parse(leadConsentNoticeQuerySchema, req.query);
    const all = await ctx.db.table('message_templates').all({ key: 'consent_notice', active: true });
    const pool = all.filter((t) => t.language === lang).length ? all.filter((t) => t.language === lang) : all.filter((t) => t.language === 'en');
    const latest = [...pool].sort((a, b) => b.version - a.version)[0];
    const org = await ctx.db.table('organizations').get(ctx.org_id);
    const common = { purposes: PURPOSES, channels: CHANNELS, recipients: org ? [org.legal_name] : [], withdrawal: 'You can withdraw consent at any time from any message (reply STOP) or by contacting us.' };
    res.json({
      data: latest
        ? { ...common, notice_version: `v${latest.version}`, language: latest.language, body: latest.body, source: 'template' }
        : { ...common, notice_version: 'default-v1', language: lang, body: DEFAULT_CONSENT_NOTICE[lang], source: 'default' },
    });
  }));

  r.get('/public/pincode/:pin', limiter, keyed(), wrap(async (req, res) => {
    const pin = String(req.params['pin'] ?? '');
    if (!PINCODE_RE.test(pin)) throw new AppError(422, 'VALIDATION_ERROR', 'Enter a valid 6-digit pincode', [{ path: 'pin', message: 'Invalid pincode' }]);
    const geo = await resolveGeo(req.ctx!, pin);
    if (geo.source === 'none') throw new AppError(404, 'NOT_FOUND', 'We could not find that pincode');
    res.json({ data: { pincode: pin, city: geo.city, district: geo.district, state: geo.state, serviceable: !!geo.territory_id } });
  }));

  /* ── unsubscribe link (HMAC-signed token placed in outbound templates) ── */
  const resolveToken = async (token: string) => {
    const leadId = verifyUnsubscribeToken(token);
    if (!leadId) throw new AppError(400, 'BAD_REQUEST', 'This unsubscribe link is not valid');
    const lead = await deps.db.table('leads').get(leadId);
    if (!lead) throw new AppError(404, 'NOT_FOUND', 'This unsubscribe link is no longer valid');
    return { lead, ctx: buildContext(deps, lead.org_id, systemUser(lead.org_id), { system: true, ip: null, userAgent: null }) };
  };

  r.get('/public/unsubscribe', limiter, wrap(async (req, res) => {
    const { lead } = await resolveToken(String(req.query['token'] ?? ''));
    res.json({ data: { valid: true, mobile_masked: maskMobile(lead.mobile) } });
  }));

  r.post('/public/unsubscribe', limiter, wrap(async (req, res) => {
    const { token } = body(leadUnsubscribeSchema, req);
    const { lead, ctx } = await resolveToken(token);
    ctx.ip = req.ip ?? null;
    ctx.userAgent = req.get('user-agent') ?? null;
    const result = await withdrawConsents(ctx, lead.id, { channel: 'unsubscribe_link', reason: 'Unsubscribe link' });
    res.json({ data: { unsubscribed: true, suppress_until: result.suppress_until } });
  }));

  return r;
}

/* ── lazily-built plain Router for registries that only list Routers (routes/index.ts) ──
 * Call bindPublicDeps(deps) once at start-up; until then the router lets every request fall through. */
let bound: AppDeps | null = null;
let built: Router | null = null;
export function bindPublicDeps(deps: AppDeps): void { bound = deps; built = null; }

const lazy = Router();
lazy.use((req, res, next) => {
  if (!bound) { next(); return; }
  built ??= createPublicRouter(bound);
  built(req, res, next);
});
export default lazy;
