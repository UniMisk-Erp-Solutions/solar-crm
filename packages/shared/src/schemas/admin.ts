/**
 * Zod schemas for the admin area: users, territories, message templates, approval rules, gate applicability,
 * work calendar, SLA settings, audit viewer and lead-source API keys.
 * Every export is prefixed `admin…` so it can never collide with another module's schema names.
 */
import { z } from 'zod';
import {
  APPLICABILITIES, APPROVAL_LANES, GATES, LEAD_SOURCES, MESSAGE_CHANNELS, MESSAGE_PURPOSES, SEGMENTS, TEMPLATE_CATEGORIES, appRoleSchema, type MessageChannel,
} from '../enums';
import { INTERNAL_ROLES } from '../flow';
import { detectAadhaar } from '../aadhaar';
import { emailSchema, isoDateSchema, uuidSchema } from '../validators';
import { platformJsonSchema } from './platform';

const text = (min: number, max: number) =>
  z.string().trim().min(min).max(max).refine((v) => detectAadhaar(v).length === 0, { message: 'Aadhaar numbers must not be entered here — use last four digits only.' });
const paging = (defaultLimit: number, maxLimit: number) => ({
  limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
  offset: z.coerce.number().int().min(0).default(0),
});
const language = z.enum(['en', 'hi', 'gu']);

/* ───────────── users ───────────── */
export const adminUserCreateSchema = z.object({
  email: emailSchema,
  full_name: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(20).nullable().optional(),
  role: appRoleSchema,
  designation: z.string().trim().max(120).nullable().optional(),
  distributor_id: uuidSchema.nullable().optional(),
  dealer_id: uuidSchema.nullable().optional(),
  territory_ids: z.array(uuidSchema).max(200).default([]),
  reports_to: uuidSchema.nullable().optional(),
  language: language.default('en'),
  /** live mode: true → Supabase sends an invitation e-mail; false → the account is created confirmed (optionally with `password`) */
  send_invite: z.boolean().default(true),
  /** only used when send_invite is false; never stored by the CRM */
  password: z.string().min(10).max(72).optional(),
});
export const adminUserUpdateSchema = z
  .object({
    full_name: z.string().trim().min(2).max(120).optional(),
    phone: z.string().trim().max(20).nullable().optional(),
    role: appRoleSchema.optional(),
    designation: z.string().trim().max(120).nullable().optional(),
    distributor_id: uuidSchema.nullable().optional(),
    dealer_id: uuidSchema.nullable().optional(),
    territory_ids: z.array(uuidSchema).max(200).optional(),
    reports_to: uuidSchema.nullable().optional(),
    language: language.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });
export const adminUserDeactivateSchema = z.object({ reason: z.string().trim().max(300).optional() });

/* ───────────── territories ───────────── */
const pincodeRange = z
  .object({ from: z.string().regex(/^[1-9]\d{5}$/, 'Enter a 6-digit pincode'), to: z.string().regex(/^[1-9]\d{5}$/, 'Enter a 6-digit pincode') })
  .refine((r) => r.from <= r.to, { message: 'The range start must not be after its end' });
export const adminTerritoryCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  state: z.string().trim().min(2).max(100),
  district: z.string().trim().max(100).nullable().optional(),
  pincode_ranges: z.array(pincodeRange).max(200).default([]),
  discom_id: uuidSchema.nullable().optional(),
  dsm_id: uuidSchema.nullable().optional(),
  active: z.boolean().default(true),
  /** set true to accept a pincode range that overlaps another active territory */
  allow_overlap: z.boolean().default(false),
});
export const adminTerritoryUpdateSchema = adminTerritoryCreateSchema.partial().refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });
export const adminTerritoryUsersSchema = z.object({ user_ids: z.array(uuidSchema).max(500) });

/* ───────────── message templates ───────────── */
export interface AdminTemplateFields {
  channel: MessageChannel; category: string; purpose: string; subject?: string | null; body: string;
  dlt_template_id?: string | null; dlt_header?: string | null; whatsapp_template_name?: string | null;
}
/** Channel-specific validation shared by the API and the admin form. Returns field-level issues. */
export function adminTemplateIssues(t: AdminTemplateFields): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  const add = (path: string, message: string) => out.push({ path, message });
  if (t.channel === 'sms') {
    if (!t.dlt_template_id) add('dlt_template_id', 'An SMS template needs its DLT template ID');
    else if (!/^\d{10,20}$/.test(t.dlt_template_id)) add('dlt_template_id', 'DLT template IDs are 10–20 digits');
    if (!t.dlt_header) add('dlt_header', 'An SMS template needs its DLT sender header');
    else if (!/^[A-Za-z0-9-]{3,11}$/.test(t.dlt_header)) add('dlt_header', 'The DLT header must be 3–11 letters or digits');
    if (t.body.length > 1000) add('body', 'SMS text is limited to 1,000 characters');
  } else {
    if (t.dlt_template_id) add('dlt_template_id', 'DLT fields apply to SMS templates only');
    if (t.dlt_header) add('dlt_header', 'DLT fields apply to SMS templates only');
  }
  if (t.channel === 'whatsapp') {
    if (!t.whatsapp_template_name) add('whatsapp_template_name', 'A WhatsApp template needs its approved template name');
    else if (!/^[a-z0-9_]{1,512}$/.test(t.whatsapp_template_name)) add('whatsapp_template_name', 'Template names use lower-case letters, digits and underscores only');
    if (t.purpose === 'promotional' && t.category !== 'marketing') add('category', 'Promotional WhatsApp templates must be in the marketing category');
  } else if (t.whatsapp_template_name) add('whatsapp_template_name', 'Template names apply to WhatsApp templates only');
  if (t.channel === 'email' && !t.subject?.trim()) add('subject', 'An e-mail template needs a subject');
  if (t.channel !== 'sms') {
    const open = (t.body.match(/\{\{/g) ?? []).length;
    const close = (t.body.match(/\}\}/g) ?? []).length;
    if (open !== close) add('body', 'Placeholders must be closed — every {{ needs a matching }}');
  }
  return out;
}
const templateIdentity = {
  key: z.string().trim().regex(/^[a-z0-9][a-z0-9_.-]{1,79}$/, 'Use lower-case letters, digits, dots, dashes or underscores'),
  channel: z.enum(MESSAGE_CHANNELS),
  language: language.default('en'),
};
const templateContent = {
  category: z.enum(TEMPLATE_CATEGORIES),
  purpose: z.enum(MESSAGE_PURPOSES),
  subject: text(1, 200).nullable().optional(),
  body: text(1, 4000),
  dlt_template_id: z.string().trim().max(40).nullable().optional(),
  dlt_header: z.string().trim().max(20).nullable().optional(),
  whatsapp_template_name: z.string().trim().max(512).nullable().optional(),
};
export const adminTemplateCreateSchema = z.object({ ...templateIdentity, ...templateContent, active: z.boolean().default(true) });
/** Editing creates version + 1; key, channel and language identify the template family and cannot change. */
export const adminTemplateUpdateSchema = z
  .object({
    category: templateContent.category.optional(), purpose: templateContent.purpose.optional(), subject: templateContent.subject, body: templateContent.body.optional(),
    dlt_template_id: templateContent.dlt_template_id, dlt_header: templateContent.dlt_header, whatsapp_template_name: templateContent.whatsapp_template_name,
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

/* ───────────── approval rules ───────────── */
const roleChain = z.array(appRoleSchema).min(1).max(6).refine((c) => c.every((r) => INTERNAL_ROLES.includes(r)), { message: 'Approvers must be internal roles' });
export const adminApprovalRuleCreateSchema = z.object({
  lane: z.enum(APPROVAL_LANES),
  name: z.string().trim().min(2).max(120),
  min_value: z.number().min(0),
  max_value: z.number().min(0).nullable().optional(),
  role_chain: roleChain,
  sla_hours: z.number().int().min(1).max(720).default(24),
  active: z.boolean().default(true),
  conditions: platformJsonSchema.default({}),
});
export const adminApprovalRuleUpdateSchema = z
  .object({
    lane: z.enum(APPROVAL_LANES).optional(), name: z.string().trim().min(2).max(120).optional(), min_value: z.number().min(0).optional(), max_value: z.number().min(0).nullable().optional(),
    role_chain: roleChain.optional(), sla_hours: z.number().int().min(1).max(720).optional(), active: z.boolean().optional(), conditions: platformJsonSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

/* ───────────── gate applicability ───────────── */
export const adminGateCellSchema = z.object({
  gate: z.enum(GATES), segment: z.enum(SEGMENTS), applicability: z.enum(APPLICABILITIES), note: z.string().trim().max(500).nullable().optional(),
});

/* ───────────── work calendar and SLA ───────────── */
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour, IST)');
export const adminWorkHoursSchema = z
  .object({ days: z.array(z.number().int().min(0).max(6)).min(1).max(7), start: hhmm, end: hhmm })
  .refine((h) => h.start < h.end, { message: 'Closing time must be after opening time', path: ['end'] });
export const adminWorkCalendarUpdateSchema = z
  .object({
    hours: adminWorkHoursSchema.optional(),
    /** plain dates or { date, name } */
    holidays: z.array(z.union([isoDateSchema, z.object({ date: isoDateSchema, name: z.string().trim().max(120).optional() })])).max(400).optional(),
    effective_from: isoDateSchema.optional(),
    source_name: z.string().trim().max(300).optional(),
    source_ref: z.string().trim().min(1, 'A source reference is mandatory').max(1000),
  })
  .refine((v) => v.hours !== undefined || v.holidays !== undefined, { message: 'Give hours and/or holidays' });
export const adminSlaUpdateSchema = z.object({
  /** key within the sla category, e.g. lead_acceptance_minutes.hot */
  key: z.string().trim().regex(/^[A-Za-z0-9_.-]{2,120}$/),
  value: platformJsonSchema,
  effective_from: isoDateSchema.optional(),
  source_name: z.string().trim().max(300).optional(),
  source_ref: z.string().trim().min(1, 'A source reference is mandatory').max(1000),
});

/* ───────────── audit viewer ───────────── */
export const adminAuditQuerySchema = z.object({
  actor: uuidSchema.optional(),
  action: z.string().trim().max(80).optional(),
  table: z.string().trim().max(80).optional(),
  record: z.string().trim().max(80).optional(),
  source: z.enum(['trigger', 'api']).optional(),
  /** YYYY-MM-DD (IST day start) or an ISO date-time */
  from: z.string().trim().max(40).optional(),
  to: z.string().trim().max(40).optional(),
  q: z.string().trim().max(100).optional(),
  ...paging(50, 200),
});

/* ───────────── lead-source API keys ───────────── */
export const adminApiKeyCreateSchema = z.object({ source: z.enum(LEAD_SOURCES), label: z.string().trim().min(2).max(80) });
