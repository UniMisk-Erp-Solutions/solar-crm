/**
 * Zod schemas + response view types for the leads area (Stages 0–2: capture, allocation, follow-up, classification).
 * Every export is prefixed `lead…` / `Lead…` / `followup…` so it can never collide with another module's names.
 */
import { z } from 'zod';
import {
  CONSENT_CHANNELS, CONSENT_PURPOSES, CONTACT_CHANNELS, CONTACT_OUTCOMES, CUSTOMER_TYPES, FOLLOWUP_KINDS, LEAD_SOURCES, LEAD_STATUSES,
  SEGMENTS, TEMPERATURES, TIMELINE_BUCKETS,
  type ContactOutcome, type DndStatus, type LeadStatus,
} from '../enums';
import type {
  Clock, ContactLog, Followup, Json, Lead, LeadAssignment, LeadConsent, LeadEvent, LeadScore, MessageLog,
} from '../rows';
import { isoDateSchema, isoDateTimeSchema, mobileSchema, optionalEmailSchema, pincodeSchema, safeText, uuidSchema } from '../validators';

/* ───────────── constants shared by API and web ───────────── */
export const LEAD_LANGUAGES = ['en', 'hi', 'gu'] as const;
export const DECISION_MAKERS = ['self', 'family', 'committee', 'unknown'] as const;
/** Statuses in which a lead is still being worked (drives overdue filters, load counts and the follow-up engine). */
export const LEAD_ACTIVE_STATUSES: readonly LeadStatus[] = ['new', 'validated', 'unassigned', 'assigned', 'accepted', 'contacted', 'qualified', 'site_visit', 'nurture'];
/** Statuses after which no further follow-up is expected. */
export const LEAD_CLOSED_STATUSES: readonly LeadStatus[] = ['duplicate', 'merged', 'opportunity', 'lost', 'won'];
/** Outcomes that mean the customer was actually reached (status moves to `contacted`). */
export const CONTACT_CONNECTED_OUTCOMES: readonly ContactOutcome[] = ['connected_interested', 'connected_not_now', 'connected_not_interested', 'message_delivered', 'message_replied', 'visit_done'];
export const CONTACT_OUTCOME_LABEL: Record<ContactOutcome, string> = {
  connected_interested: 'Connected — interested', connected_not_now: 'Connected — not now', connected_not_interested: 'Connected — not interested',
  no_answer: 'No answer', busy_call_back: 'Busy — call back later', wrong_number: 'Wrong number', message_delivered: 'Message delivered',
  message_replied: 'Customer replied', visit_done: 'Visit done', visit_rescheduled: 'Visit rescheduled',
};
export const LEAD_SOURCE_LABEL: Record<(typeof LEAD_SOURCES)[number], string> = {
  website: 'Website form', call_centre: 'Call centre', whatsapp: 'WhatsApp', campaign: 'Campaign (Meta / Google)', referral: 'Referral', dealer_upload: 'Dealer upload', manual: 'Manual entry',
};
export const LEAD_FORM_LABEL = {
  last_action: 'Last action', next_action: 'Next action', next_followup_at: 'Next follow-up date', owner_id: 'Owner',
} as const;

/* ───────────── building blocks ───────────── */
/** Treat "" / null from HTML forms as "not provided". */
const blankToUndefined = (v: unknown): unknown => (v === '' || v === null ? undefined : v);
const opt = <T extends z.ZodTypeAny>(s: T) => z.preprocess(blankToUndefined, s.optional());
const text = (max: number) => safeText(max);
const reasonSchema = z.string().trim().min(3, 'Please give a short reason').max(500);

export const leadLanguageSchema = z.enum(LEAD_LANGUAGES);
export const leadSourceInputSchema = z.enum(LEAD_SOURCES);
export const leadStatusInputSchema = z.enum(LEAD_STATUSES);
export const leadTemperatureInputSchema = z.enum(TEMPERATURES);
export const leadSegmentInputSchema = z.enum(SEGMENTS);
export const leadTimelineInputSchema = z.enum(TIMELINE_BUCKETS);
export const leadDecisionMakerSchema = z.enum(DECISION_MAKERS);
export const leadContactChannelSchema = z.enum(CONTACT_CHANNELS);
export const leadContactOutcomeSchema = z.enum(CONTACT_OUTCOMES);
export const followupKindInputSchema = z.enum(FOLLOWUP_KINDS);

const consentChannelListSchema = z.array(z.enum(CONSENT_CHANNELS)).min(1, 'Select at least one channel').max(4);
const consentPurposeListSchema = z.array(z.enum(CONSENT_PURPOSES)).min(1, 'Select at least one purpose').max(5);

/** The consent the customer gave on the notice they were shown (written once to the immutable ledger). */
export const leadConsentCaptureSchema = z.object({
  notice_version: z.string().trim().min(1).max(60),
  purposes: consentPurposeListSchema,
  channels: consentChannelListSchema,
  proof_ref: opt(z.string().trim().max(200)),
  capture_source: opt(z.string().trim().max(60)),
});
export type LeadConsentCapture = z.infer<typeof leadConsentCaptureSchema>;

/** Where the inquiry came from (utm, campaign, referrer, landing page…). IP and user agent are added by the server. */
export const leadProvenanceSchema = z.object({
  utm_source: opt(z.string().trim().max(120)), utm_medium: opt(z.string().trim().max(120)), utm_campaign: opt(z.string().trim().max(160)),
  utm_term: opt(z.string().trim().max(160)), utm_content: opt(z.string().trim().max(160)),
  campaign: opt(z.string().trim().max(160)), referrer: opt(z.string().trim().max(500)), landing_url: opt(z.string().trim().max(500)),
  referrer_name: opt(z.string().trim().max(120)), device: opt(z.string().trim().max(120)),
});

const leadDetailFields = {
  pincode: opt(pincodeSchema),
  city: opt(z.string().trim().max(100)), district: opt(z.string().trim().max(100)), state: opt(z.string().trim().max(100)),
  segment: opt(leadSegmentInputSchema),
  customer_type: opt(z.enum(CUSTOMER_TYPES)),
  capacity_kw: opt(z.coerce.number().positive('Capacity must be more than 0').max(100000)),
  product_interest: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  consumer_no: opt(z.string().trim().regex(/^[A-Za-z0-9\-/]{4,24}$/, 'Enter the consumer number as printed on the electricity bill')),
  language: opt(leadLanguageSchema),
  requirement_text: opt(text(2000)),
  notes: opt(text(2000)),
  /** how soon the customer wants to install — sets HOT / WARM / COLD from the first minute, so the acceptance SLA is right */
  timeline_bucket: opt(leadTimelineInputSchema),
  bill_captured: z.boolean().optional(),
};

/** Public intake payload: website form, call-centre entry, referral entry and dealer-uploaded lead (the API key fixes `source`). */
export const publicLeadInputSchema = z.object({
  name: z.string().trim().min(2, 'Please enter your name').max(120),
  mobile: mobileSchema,
  email: optionalEmailSchema,
  ...leadDetailFields,
  dealer_id: opt(uuidSchema),
  source_ref: opt(z.string().trim().max(120)),
  consent: leadConsentCaptureSchema.optional(),
  provenance: leadProvenanceSchema.optional(),
});
export type PublicLeadInput = z.infer<typeof publicLeadInputSchema>;

/** Internal manual lead form. Staff-entered consent must carry a proof reference (recording id, signed form, …). */
export const leadCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  mobile: mobileSchema,
  email: optionalEmailSchema,
  ...leadDetailFields,
  source: leadSourceInputSchema.default('manual'),
  source_ref: opt(z.string().trim().max(120)),
  distributor_id: opt(uuidSchema), dealer_id: opt(uuidSchema), owner_id: opt(uuidSchema),
  consent: leadConsentCaptureSchema.extend({ proof_ref: z.string().trim().min(3, 'A proof reference is required for staff-entered consent').max(200) }).optional(),
  provenance: leadProvenanceSchema.optional(),
});
export type LeadCreateInput = z.infer<typeof leadCreateSchema>;

/** PATCH /leads/:id — the four mandatory fields may be edited but never blanked. */
export const leadPatchSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  email: optionalEmailSchema,
  pincode: opt(pincodeSchema), city: opt(z.string().trim().max(100)), district: opt(z.string().trim().max(100)), state: opt(z.string().trim().max(100)),
  segment: leadSegmentInputSchema.nullable().optional(),
  customer_type: z.enum(CUSTOMER_TYPES).nullable().optional(),
  capacity_kw: z.coerce.number().positive().max(100000).nullable().optional(),
  product_interest: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  consumer_no: z.string().trim().max(24).nullable().optional(),
  language: leadLanguageSchema.optional(),
  requirement_text: text(2000).nullable().optional(),
  notes: text(2000).nullable().optional(),
  timeline_bucket: leadTimelineInputSchema.nullable().optional(),
  budget_inr: z.coerce.number().min(0).max(1e10).nullable().optional(),
  decision_maker: leadDecisionMakerSchema.nullable().optional(),
  decision_maker_access: z.boolean().nullable().optional(),
  bill_captured: z.boolean().optional(),
  last_action: z.string().max(300).nullable().optional(),
  next_action: z.string().max(300).nullable().optional(),
  next_followup_at: isoDateTimeSchema.nullable().optional(),
  owner_id: uuidSchema.nullable().optional(),
}).refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });
export type LeadPatchInput = z.infer<typeof leadPatchSchema>;

export const leadAcceptSchema = z.object({ note: opt(z.string().trim().max(300)) });
export const leadRejectSchema = z.object({ reason: reasonSchema });
export const leadReassignSchema = z.object({
  distributor_id: opt(uuidSchema), dealer_id: opt(uuidSchema), owner_id: opt(uuidSchema),
  /** run the routing engine again (excluding distributors that already rejected / expired) instead of naming one */
  auto: z.boolean().optional(),
  reason: reasonSchema,
}).refine((v) => v.auto === true || !!v.distributor_id, { message: 'Choose a distributor or ask the system to pick the next best one', path: ['distributor_id'] });

export const leadContactInputSchema = z.object({
  channel: leadContactChannelSchema,
  direction: z.enum(['outbound', 'inbound']).default('outbound'),
  outcome: leadContactOutcomeSchema,
  notes: opt(text(2000)),
  duration_min: opt(z.coerce.number().int().min(0).max(600)),
  occurred_at: opt(isoDateTimeSchema),
  next_action: opt(z.string().trim().min(2).max(300)),
  next_followup_at: opt(isoDateTimeSchema),
});
export type LeadContactInput = z.infer<typeof leadContactInputSchema>;

export const leadQualificationSchema = z.object({
  requirement_text: text(2000).refine((v) => v.length > 0, { message: 'Describe the requirement' }),
  timeline_bucket: leadTimelineInputSchema,
  budget_inr: opt(z.coerce.number().min(0).max(1e10)),
  decision_maker: leadDecisionMakerSchema,
  decision_maker_access: z.boolean().optional(),
  capacity_kw: opt(z.coerce.number().positive().max(100000)),
  segment: opt(leadSegmentInputSchema),
  customer_type: opt(z.enum(CUSTOMER_TYPES)),
  product_interest: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  bill_captured: z.boolean().optional(),
  notes: opt(text(2000)),
  next_action: opt(z.string().trim().min(2).max(300)),
  next_followup_at: opt(isoDateTimeSchema),
});
export type LeadQualificationInput = z.infer<typeof leadQualificationSchema>;

export const leadFollowupCreateSchema = z.object({
  kind: followupKindInputSchema.default('call'),
  due_at: isoDateTimeSchema,
  /** the next action — becomes the lead's “Next action” when this is the earliest open follow-up */
  note: z.string().trim().min(2, 'Say what has to be done').max(300),
});
export const leadFollowupCompleteSchema = z.object({
  outcome: z.string().trim().min(2, 'Record the outcome').max(500),
  next_action: z.string().trim().min(2, 'Next action is required').max(300),
  next_followup_at: isoDateTimeSchema,
  next_kind: followupKindInputSchema.default('call'),
  last_action: opt(z.string().trim().min(2).max(300)),
});
export const followupListQuerySchema = z.object({
  bucket: z.enum(['due_today', 'overdue', 'upcoming', 'all']).default('all'),
  scope: z.enum(['mine', 'team']).default('mine'),
  status: z.enum(['open', 'done', 'missed', 'cancelled', 'pending']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Add a consent to the ledger by hand (phone call, signed form, WhatsApp opt-in screenshot…). */
export const leadConsentAddSchema = z.object({
  notice_version: z.string().trim().min(1).max(60),
  purposes: consentPurposeListSchema,
  channels: consentChannelListSchema,
  proof_ref: z.string().trim().min(3, 'A proof reference is required').max(200),
  capture_source: z.string().trim().min(2).max(60).default('staff_entry'),
  recipients_named: z.array(z.string().trim().min(2).max(160)).max(10).optional(),
  granted_at: isoDateTimeSchema.optional(),
});
export const leadConsentWithdrawSchema = z.object({
  reason: opt(z.string().trim().max(300)),
  channel: z.enum(['ui', 'call', 'whatsapp', 'sms', 'email', 'unsubscribe_link', 'in_person']).default('ui'),
});

export const leadMessageSendSchema = z.object({
  channel: z.enum(['whatsapp', 'sms', 'email', 'call']),
  purpose: z.enum(['promotional', 'service', 'transactional']),
  template_key: opt(z.string().trim().max(80)),
  body: opt(text(1600)),
  subject: opt(z.string().trim().max(200)),
  vars: z.record(z.string().max(300)).optional(),
  /** re-run the DND scrub first when the last one is older than the allowed age */
  refresh_dnd: z.boolean().optional(),
}).refine((v) => v.channel === 'call' || !!v.template_key || !!v.body, { message: 'Choose a template or type a message', path: ['body'] });

export const leadNurtureSchema = z.object({ reason: reasonSchema, nurture_until: isoDateSchema });
export const leadLostSchema = z.object({ reason: reasonSchema });
export const leadUnmaskSchema = z.object({ reason: z.string().trim().min(5, 'Say why you need the full number').max(300) });
export const leadMergeSchema = z.object({ into_lead_id: uuidSchema, note: opt(z.string().trim().max(300)) });
export const leadLockOverrideRequestSchema = z.object({ reason: reasonSchema });
export const leadLockOverrideDecisionSchema = z.object({ decision: z.enum(['approve', 'reject']), note: opt(z.string().trim().max(300)) });

export const leadListQuerySchema = z.object({
  view: z.enum(['table', 'kanban']).default('table'),
  sla_state: z.enum(['breached', 'due_soon', 'ok']).optional(),
  followup_overdue: z.preprocess((v) => (v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : v), z.boolean().optional()),
  per_column: z.coerce.number().int().min(1).max(100).default(25),
});

export const leadSourceKeyCreateSchema = z.object({ source: leadSourceInputSchema, label: z.string().trim().min(2).max(120) });
export const leadSourceKeyPatchSchema = z.object({ active: z.boolean().optional(), label: z.string().trim().min(2).max(120).optional() }).refine((v) => v.active !== undefined || v.label !== undefined, { message: 'Nothing to update' });
export const leadUnsubscribeSchema = z.object({ token: z.string().trim().min(10).max(500) });
export const leadConsentNoticeQuerySchema = z.object({ lang: z.enum(LEAD_LANGUAGES).default('en') });

/* ───────────── response view types (for the web app) ───────────── */
export type LeadSlaState = 'breached' | 'due_soon' | 'ok';

export interface LeadListItem extends Lead {
  owner_name: string | null; distributor_name: string | null; dealer_name: string | null;
  sla_state: LeadSlaState; followup_overdue: boolean;
}

export interface LeadKanbanColumn { status: LeadStatus; label: string; count: number; items: LeadListItem[] }
export interface LeadKanbanView { columns: LeadKanbanColumn[]; total: number }

export interface LeadDuplicateMatch {
  kind: 'mobile' | 'email' | 'consumer_no' | 'name_pincode';
  /** 1 for an exact match, otherwise the bigram-Jaccard similarity */
  similarity: number;
  lead_id: string; name: string; status: LeadStatus; mobile_masked: string; dealer_id: string | null; distributor_id: string | null;
  lock_status: Lead['lock_status']; locked_by_dealer_id: string | null; created_at: string;
}
export interface LeadCustomerMatch {
  kind: 'mobile' | 'email' | 'consumer_no' | 'name_pincode'; similarity: number; customer_id: string; name: string; phone_masked: string | null;
}
export interface LeadDuplicateReport {
  leads: LeadDuplicateMatch[]; customers: LeadCustomerMatch[]; checked_at: string;
  /** matches the current user may not see (another party’s leads) — only counted for external users */
  hidden?: number;
}

export interface LeadNextBestAction { code: string; label: string; due_at: string | null; urgent: boolean }
export interface LeadConvertBlocker { code: string; message: string }
export interface LeadValidationHint { field: string; message: string }

export interface LeadConsentSummary {
  has_active: boolean; withdrawn: boolean; purposes: string[]; channels: string[]; suppress_until: string | null; suppressed: boolean;
  dnd_status: DndStatus; dnd_checked_at: string | null; dnd_fresh: boolean; whatsapp_window_open: boolean; whatsapp_window_closes_at: string | null;
  /** can we send X on Y right now? */
  outbound: Record<'whatsapp' | 'sms' | 'email' | 'call', { promotional: boolean; service: boolean }>;
}

export interface LeadDetail {
  lead: Lead & { owner_name: string | null; distributor_name: string | null; dealer_name: string | null; territory_name: string | null };
  events: LeadEvent[]; consents: LeadConsent[]; consent_summary: LeadConsentSummary; assignments: LeadAssignment[]; followups: Followup[]; contact_logs: ContactLog[];
  score: LeadScore | null; clocks: Clock[]; duplicates: LeadDuplicateReport;
  customer_id: string | null; site_id: string | null; opportunity_ids: string[];
  next_best_action: LeadNextBestAction; convert_blockers: LeadConvertBlocker[]; can_convert: boolean; validation_hints: LeadValidationHint[];
  first_response_minutes: number | null; qualification_gaps: string[];
}

export interface LeadTimelineItem { at: string; kind: 'event' | 'contact' | 'message' | 'followup'; type: string; summary: string; actor_id: string | null; detail: Json }
export interface LeadScoreView { score: number; components: LeadScore['components']; computed_at: string; temperature: Lead['temperature']; deadline_uplift: boolean; history: Pick<LeadScore, 'score' | 'computed_at'>[] }
export interface FollowupListItem extends Followup { lead_name: string; lead_status: LeadStatus; lead_temperature: Lead['temperature']; lead_mobile: string; overdue: boolean }
export type LeadMessageLogItem = MessageLog;
export type LeadContactLogItem = ContactLog;
