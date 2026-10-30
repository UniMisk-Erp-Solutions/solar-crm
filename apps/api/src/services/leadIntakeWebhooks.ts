/**
 * Webhook adapters for lead capture: Meta Lead Ads / Google Ads lead-form payload normalisation, and the WhatsApp inbound handler
 * (logs the message, opens the 24-hour window, attaches it to the lead, honours STOP / UNSUBSCRIBE as a full opt-out).
 */
import { detectAadhaar, maskMobile, toE164, type CustomerType, type Json, type Lead, type LeadSource } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { withdrawConsents } from './consentServiceLedger';
import { captureLead, type CaptureResult } from './leadIntake';
import { getLead, logLeadEvent, notifyStaff } from './leadServiceStore';
import { recordInboundWhatsApp } from './messagingService';

/* ───────────── campaign payload normalisation ───────────── */
export interface CampaignLead {
  platform: 'meta' | 'google'; source_ref: string | null; test: boolean;
  name: string | null; mobile: string | null; email: string | null; pincode: string | null; city: string | null; state: string | null;
  capacity_kw: number | null; customer_type: CustomerType | null; requirement_text: string | null; consent: boolean; provenance: Record<string, Json>;
}

const key = (k: string): string => k.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const TRUTHY = /^(yes|y|true|1|on|agree|agreed|i agree|accepted)$/i;

function customerTypeOf(text: string): CustomerType | null {
  const t = text.toLowerCase();
  if (/(society|apartment|housing|rwa|flat)/.test(t)) return 'housing_society';
  if (/(industr|factory|plant|manufactur)/.test(t)) return 'industrial';
  if (/(commercial|business|shop|office|hotel|school|hospital)/.test(t)) return 'commercial';
  if (/(farm|agri|kisan|pump)/.test(t)) return 'farmer';
  if (/(govern|public sector|municipal)/.test(t)) return 'government';
  if (/(home|house|residen|villa|bungalow|individual)/.test(t)) return 'residential';
  return null;
}

/** Flat `{ normalisedKey: value }` from Meta `field_data` ([{ name, values }]) or Google `user_column_data` ([{ column_id, string_value }]). */
function fieldsOf(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const meta = raw['field_data'];
  if (Array.isArray(meta)) {
    for (const f of meta) {
      if (!isRecord(f)) continue;
      const name = str(f['name']);
      const values = Array.isArray(f['values']) ? f['values'] : [f['value']];
      const v = str(values[0]);
      if (name && v) out[key(name)] = v;
    }
  }
  const google = raw['user_column_data'];
  if (Array.isArray(google)) {
    for (const f of google) {
      if (!isRecord(f)) continue;
      const name = str(f['column_id']) ?? str(f['column_name']);
      const v = str(f['string_value']) ?? str(f['value']);
      if (name && v) out[key(name)] = v;
    }
  }
  return out;
}

const pick = (f: Record<string, string>, names: string[]): string | null => {
  for (const n of names) if (f[n]) return f[n]!;
  return null;
};

function normaliseOne(raw: Record<string, unknown>, platform: 'meta' | 'google'): CampaignLead {
  const f = fieldsOf(raw);
  const first = pick(f, ['first_name']), last = pick(f, ['last_name']);
  const name = pick(f, ['full_name', 'name', 'your_name', 'customer_name']) ?? ([first, last].filter(Boolean).join(' ') || null);
  const kwKey = Object.keys(f).find((k) => /(^|_)(kw|capacity|system_size|load)(_|$)/.test(k));
  const kw = kwKey ? Number(/(\d+(?:\.\d+)?)/.exec(f[kwKey]!)?.[1]) : NaN;
  const typeText = pick(f, ['customer_type', 'property_type', 'installation_type', 'install_type', 'building_type', 'segment']);
  const consentKey = Object.keys(f).find((k) => /(consent|agree|terms|privacy)/.test(k));
  const id = platform === 'meta' ? str(raw['leadgen_id']) ?? str(raw['id']) : str(raw['lead_id']);
  const provenance: Record<string, Json> = { platform };
  for (const k of ['form_id', 'ad_id', 'adgroup_id', 'adset_id', 'campaign_id', 'campaign_name', 'creative_id', 'gcl_id', 'created_time', 'page_id', 'api_version']) {
    const v = str(raw[k]);
    if (v) provenance[k === 'gcl_id' ? 'gclid' : k] = v;
  }
  return {
    platform, source_ref: id ? `${platform}:${id}` : null, test: raw['is_test'] === true, name,
    mobile: pick(f, ['phone_number', 'phone', 'mobile', 'mobile_number', 'contact_number', 'whatsapp_number']), email: pick(f, ['email', 'email_address', 'work_email']),
    pincode: pick(f, ['zip_code', 'zip', 'postal_code', 'post_code', 'pincode', 'pin_code']), city: pick(f, ['city', 'town']), state: pick(f, ['state', 'province']),
    capacity_kw: Number.isFinite(kw) && kw > 0 ? kw : null, customer_type: typeText ? customerTypeOf(typeText) : null,
    requirement_text: pick(f, ['message', 'comments', 'requirement', 'notes', 'how_can_we_help', 'tell_us_more']),
    consent: !!consentKey && TRUTHY.test(f[consentKey]!), provenance,
  };
}

/** Accepts the shapes Meta and Google actually deliver (single lead, `entry[].changes[].value`, or arrays under `leads` / `data`). */
export function normaliseCampaignPayload(payload: unknown): CampaignLead[] {
  const out: CampaignLead[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!isRecord(node)) return;
    if (Array.isArray(node['user_column_data'])) { out.push(normaliseOne(node, 'google')); return; }
    if (Array.isArray(node['field_data'])) { out.push(normaliseOne(node, 'meta')); return; }
    for (const k of ['entry', 'changes', 'value', 'leads', 'data']) if (node[k] !== undefined) visit(node[k]);
  };
  visit(payload);
  return out;
}

export interface CampaignOutcome { index: number; status: 'created' | 'duplicate' | 'existing' | 'ignored_test' | 'rejected'; lead_id: string | null; reason?: string }

/** Creates a lead per normalised campaign entry (idempotent on the platform’s lead id). Consent is recorded only when the form carried an explicit consent answer. */
export async function captureCampaignLeads(ctx: AppContext, leads: CampaignLead[]): Promise<CampaignOutcome[]> {
  const outcomes: CampaignOutcome[] = [];
  for (const [index, l] of leads.entries()) {
    if (l.test) { outcomes.push({ index, status: 'ignored_test', lead_id: null }); continue; }
    const mobile = l.mobile ? toE164(l.mobile) : null;
    if (!mobile) { outcomes.push({ index, status: 'rejected', lead_id: null, reason: 'A valid 10-digit Indian mobile number is required' }); continue; }
    if (l.requirement_text && detectAadhaar(l.requirement_text).length) { outcomes.push({ index, status: 'rejected', lead_id: null, reason: 'Aadhaar numbers are not accepted' }); continue; }
    const pincode = l.pincode && /^[1-9]\d{5}$/.test(l.pincode.replace(/\s/g, '')) ? l.pincode.replace(/\s/g, '') : undefined;
    const email = l.email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(l.email) ? l.email : null;
    const r: CaptureResult = await captureLead(ctx, {
      source: 'campaign' as LeadSource, origin: 'webhook', name: l.name ?? 'Campaign enquiry', mobile, email, pincode, city: l.city ?? undefined, state: l.state ?? undefined,
      capacity_kw: l.capacity_kw ?? undefined, customer_type: l.customer_type, requirement_text: l.requirement_text ?? undefined, source_ref: l.source_ref ?? undefined, provenance: l.provenance,
      consent: l.consent ? { notice_version: str(l.provenance['form_id']) ? `${l.platform}-form-${String(l.provenance['form_id'])}` : `${l.platform}-lead-form`, purposes: ['service'], channels: ['call', 'sms', 'whatsapp'], proof_ref: l.source_ref ?? undefined, capture_source: `campaign:${l.platform}` } : undefined,
    });
    outcomes.push({ index, status: !r.created ? 'existing' : r.duplicate_of ? 'duplicate' : 'created', lead_id: r.lead.id });
  }
  return outcomes;
}

/* ───────────── WhatsApp inbound ───────────── */
const OPTOUT = /^\s*(stop|stop all|unsubscribe|opt[\s-]?out|cancel)\s*[.!]?\s*$/i;
export interface InboundSummary { received: number; attached: number; leads_created: number; optouts: number; ignored: number }

export async function processWhatsAppInbound(ctx: AppContext, payload: unknown): Promise<InboundSummary> {
  const sum: InboundSummary = { received: 0, attached: 0, leads_created: 0, optouts: 0, ignored: 0 };
  for (const m of ctx.providers.whatsapp.parseInbound(payload)) {
    sum.received++;
    const mobile = toE164(m.from.replace(/^\+/, ''));
    if (!mobile) { sum.ignored++; continue; }
    const body = detectAadhaar(m.body).length ? '[withheld — contains an Aadhaar number]' : m.body;
    const optout = m.kind === 'optout' || OPTOUT.test(m.body);
    const matches = (await ctx.db.table('leads').all({ mobile }, { orderBy: { col: 'created_at', dir: 'desc' } })).filter((l) => !l.deleted_at && l.status !== 'merged' && !l.anonymised_at);

    if (optout) {
      sum.optouts++;
      if (!matches.length) { await recordInboundWhatsApp(ctx, { lead_id: null, from_masked: maskMobile(mobile), body, provider_ref: m.provider_ref, optout: true }); sum.ignored++; continue; }
      for (const l of matches) await recordInboundWhatsApp(ctx, { lead_id: l.id, from_masked: maskMobile(mobile), body, provider_ref: m.provider_ref, optout: true });
      await withdrawConsents(ctx, matches[0]!.id, { channel: 'whatsapp', reason: `Customer replied "${body.trim().slice(0, 30)}" on WhatsApp` });
      continue;
    }

    let lead: Lead | undefined = matches.find((l) => !['lost', 'duplicate'].includes(l.status)) ?? matches[0];
    if (!lead) {
      const r = await captureLead(ctx, {
        source: 'whatsapp', origin: 'webhook', name: `WhatsApp enquiry ${maskMobile(mobile).slice(-6)}`, mobile, requirement_text: body.slice(0, 500),
        source_ref: m.provider_ref ? `wa:${m.provider_ref}` : undefined, provenance: { channel: 'whatsapp_inbound' },
      });
      lead = r.lead;
      sum.leads_created++;
    }
    await recordInboundWhatsApp(ctx, { lead_id: lead.id, from_masked: maskMobile(mobile), body, provider_ref: m.provider_ref, optout: false });
    sum.attached++;
    const fresh = await getLead(ctx, lead.id);
    await logLeadEvent(ctx, fresh.id, m.kind === 'optin' ? 'whatsapp_optin_keyword' : 'whatsapp_inbound', m.kind === 'optin' ? 'Customer sent a subscribe keyword on WhatsApp — capture consent with proof to enable promotional messages' : 'Customer message received on WhatsApp — the 24-hour reply window is open', { kind: m.kind, provider_ref: m.provider_ref });
    if (fresh.owner_id) await notifyStaff(ctx, { user_ids: [fresh.owner_id], kind: 'lead.whatsapp_inbound', severity: 'info', lead_id: fresh.id, title: `WhatsApp message from ${fresh.name}`, body: body.slice(0, 140) });
  }
  return sum;
}
