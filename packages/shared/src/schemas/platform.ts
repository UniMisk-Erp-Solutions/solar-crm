/**
 * Zod schemas + response view types for the platform area: rules, clocks, notifications, compliance calendar,
 * verify register, documents, privacy (DSAR export / erasure) and breach incidents.
 * Every export is prefixed `platform…` so it can never collide with another module's schema names.
 */
import { z } from 'zod';
import { CLOCK_STATUSES, CLOCK_TYPES, DOCUMENT_BUCKETS, NOTIFICATION_SEVERITIES, RULE_CONFIDENCES, RULE_STATUSES, SEVERITIES } from '../enums';
import type { Clock, ComplianceCalendarItem, Json, RuleConfig } from '../rows';
import { isoDateSchema, isoDateTimeSchema, uuidSchema } from '../validators';
import { detectAadhaar } from '../aadhaar';

/* ───────────── building blocks ───────────── */
/** Query-string boolean: "true"/"1" → true, "false"/"0" → false. */
export const platformQueryBool = z.preprocess(
  (v) => (v === 'true' || v === '1' || v === true ? true : v === 'false' || v === '0' || v === false ? false : v),
  z.boolean(),
);

/** Any JSON value (rule values, JSON settings). */
export const platformJsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(platformJsonSchema), z.record(platformJsonSchema)]),
);

/** Free text with the Aadhaar guard (gate G14). */
const text = (min: number, max: number) =>
  z.string().trim().min(min).max(max).refine((v) => detectAadhaar(v).length === 0, { message: 'Aadhaar numbers must not be entered here — use last four digits only.' });

const paging = (defaultLimit: number, maxLimit: number) => ({
  limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
  offset: z.coerce.number().int().min(0).default(0),
});

export const PLATFORM_RULE_PATH_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+$/;
export const platformRulePathSchema = z.string().trim().regex(PLATFORM_RULE_PATH_RE, 'Use <category>.<key>, e.g. pmsg.cfa.max_total');

/** Split "category.key.more" into its category (first segment) and key (the rest). */
export function splitRulePath(path: string): { category: string; key: string } {
  const i = path.indexOf('.');
  return { category: path.slice(0, i), key: path.slice(i + 1) };
}

/* ───────────── rules ───────────── */
export const platformRuleListQuerySchema = z.object({
  category: z.string().trim().min(1).max(60).optional(),
  status: z.enum(RULE_STATUSES).optional(),
  active: platformQueryBool.optional(),
  /** true → only the version in force on `date` (default today) for every category.key */
  current: platformQueryBool.optional(),
  date: isoDateSchema.optional(),
  q: z.string().trim().max(100).optional(),
  ...paging(500, 1000),
});

export const platformRuleResolveQuerySchema = z.object({ path: platformRulePathSchema, date: isoDateSchema.optional() });

export const platformRuleHistoryQuerySchema = z
  .object({ path: platformRulePathSchema.optional(), category: z.string().trim().min(1).max(60).optional(), key: z.string().trim().min(1).max(120).optional() })
  .refine((v) => !!v.path || (!!v.category && !!v.key), { message: 'Give either path or category + key' });

export const platformRuleDiffQuerySchema = z.object({ a: uuidSchema, b: uuidSchema });

const ruleBase = {
  value: platformJsonSchema,
  effective_from: isoDateSchema,
  effective_to: isoDateSchema.nullable().optional(),
  source_name: z.string().trim().min(1, 'Source name is mandatory').max(300),
  source_ref: z.string().trim().min(1, 'A source reference is mandatory').max(1000),
  confidence: z.enum(RULE_CONFIDENCES),
  status: z.enum(RULE_STATUSES),
  is_active: z.boolean().optional(),
  max_severity: z.enum(SEVERITIES).optional(),
  enforce_hard_stop: z.boolean().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
};

/** A new effective-dated version of a rule. `source_name` and `source_ref` are mandatory. */
export const platformRuleCreateSchema = z
  .object({
    path: platformRulePathSchema.optional(),
    category: z.string().trim().min(1).max(60).optional(),
    key: z.string().trim().min(1).max(120).optional(),
    ...ruleBase,
  })
  .refine((v) => !!v.path || (!!v.category && !!v.key), { message: 'Give either path or category + key', path: ['path'] })
  .refine((v) => !v.effective_to || v.effective_to >= v.effective_from, { message: 'effective_to must not be before effective_from', path: ['effective_to'] });

export const platformRulePatchSchema = z
  .object({
    value: platformJsonSchema.optional(),
    effective_from: isoDateSchema.optional(),
    effective_to: isoDateSchema.nullable().optional(),
    source_name: ruleBase.source_name.optional(),
    source_ref: ruleBase.source_ref.optional(),
    confidence: ruleBase.confidence.optional(),
    status: ruleBase.status.optional(),
    max_severity: ruleBase.max_severity,
    enforce_hard_stop: ruleBase.enforce_hard_stop,
    notes: ruleBase.notes,
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

export const platformRuleActivateSchema = z.object({
  /** Required (true) to activate an unverified/conflicting rule as a hard stop. */
  enforce_hard_stop: z.boolean().optional(),
  max_severity: z.enum(SEVERITIES).optional(),
  reason: z.string().trim().max(500).optional(),
});

export type PlatformRuleEffect = 'none' | 'inactive' | 'advisory' | 'active';
export interface PlatformRuleRow extends RuleConfig { path: string; in_force: boolean; advisory: boolean }
export interface PlatformRuleResolution {
  path: string; date: string; found: boolean;
  rule: { id: string; category: string; key: string; value: Json; status: RuleConfig['status']; confidence: RuleConfig['confidence']; isActive: boolean; maxSeverity: RuleConfig['max_severity']; enforceHardStop: boolean; source: { name: string; ref: string }; effective_from: string; effective_to: string | null; notes: string | null } | null;
  /** none = no version covers the date · inactive = reference only · advisory = may warn, never blocks · active = verified & active */
  effect: PlatformRuleEffect;
  /** the highest severity a hard-stop gate governed by this rule could produce */
  max_effective_severity: RuleConfig['max_severity'] | null;
  message: string;
}
export interface PlatformRuleDiff {
  a: RuleConfig; b: RuleConfig; identical: boolean;
  changes: { field: string; a: Json | undefined; b: Json | undefined }[];
  value_changes: { path: string; a: Json | undefined; b: Json | undefined }[];
}

/* ───────────── clocks ───────────── */
export const platformClockListQuerySchema = z.object({
  /** entity_type, e.g. lead, quotation */
  entity: z.string().trim().min(1).max(60).optional(),
  entity_id: uuidSchema.optional(),
  type: z.enum(CLOCK_TYPES).optional(),
  status: z.enum(CLOCK_STATUSES).optional(),
  /** a profile id or "me" */
  owner: z.union([z.literal('me'), uuidSchema]).optional(),
  /** true → status breached · false → not breached */
  breached: platformQueryBool.optional(),
  /** true → unresolved clocks only */
  open: platformQueryBool.optional(),
});
export interface PlatformClockView extends Clock {
  label: string; entity_link: string; owner_name: string | null;
  /** minutes until due (negative once overdue) */
  remaining_minutes: number; percent_used: number; breached: boolean;
}

/* ───────────── notifications ───────────── */
export const platformNotificationListQuerySchema = z.object({
  unread: platformQueryBool.optional(),
  severity: z.enum(NOTIFICATION_SEVERITIES).optional(),
  kind: z.string().trim().max(120).optional(),
  ...paging(25, 100),
});

/* ───────────── compliance calendar ───────────── */
export const platformCalendarListQuerySchema = z.object({
  /** persistent strip: the next N upcoming items */
  next: z.coerce.number().int().min(1).max(20).optional(),
  upcoming: platformQueryBool.optional(),
  category: z.string().trim().max(60).optional(),
  include_inactive: platformQueryBool.optional(),
});
const escalateDays = z.array(z.number().int().min(0).max(365)).max(10);
export const platformCalendarCreateSchema = z.object({
  due_date: isoDateSchema,
  title: text(3, 200),
  description: text(1, 1000).nullable().optional(),
  category: z.string().trim().min(2).max(60),
  confidence: z.enum(RULE_CONFIDENCES),
  source_ref: z.string().trim().max(1000).nullable().optional(),
  /** days-before-due points that fire a notification; omitted → the rule calendar.default_escalate_days ([14, 7, 3]) */
  escalate_days: escalateDays.optional(),
  rule_key: z.string().trim().max(160).nullable().optional(),
  active: z.boolean().default(true),
});
export const platformCalendarPatchSchema = platformCalendarCreateSchema.partial().refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

export type PlatformUrgency = 'overdue' | 'critical' | 'warning' | 'info';
export interface PlatformCalendarItem extends ComplianceCalendarItem {
  days_left: number; countdown_label: string; countdown_short: string; urgency: PlatformUrgency; confidence_label: string; is_past: boolean;
}

/* ───────────── verify register ───────────── */
export const platformVerifyQuerySchema = z.object({
  status: z.enum(['open', 'closed']).optional(),
  confidence: z.enum(RULE_CONFIDENCES).optional(),
  owner: z.string().trim().max(120).optional(),
  q: z.string().trim().max(100).optional(),
  ...paging(100, 200),
});
export const platformVerifyPatchSchema = z
  .object({
    owner: z.string().trim().max(120).nullable().optional(),
    status: z.enum(['open', 'closed']).optional(),
    closing_source_url: z.string().trim().url('Enter the full URL of the primary source').max(1000).nullable().optional(),
    closed_at: isoDateSchema.nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

/* ───────────── documents ───────────── */
export const PLATFORM_DOCUMENT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
const entityType = z.string().trim().regex(/^[a-z][a-z_]{1,39}$/, 'Use a lower-case entity type such as lead or quotation');
const docType = z.string().trim().regex(/^[a-z0-9][a-z0-9_]{1,39}$/, 'Use a short lower-case document type such as electricity_bill').default('other');
export const platformDocumentUploadFieldsSchema = z.object({ entity_type: entityType, entity_id: uuidSchema, doc_type: docType, bucket: z.enum(DOCUMENT_BUCKETS).optional() });
export const platformDocumentListQuerySchema = z.object({ entity_type: entityType, entity_id: uuidSchema, doc_type: z.string().trim().max(40).optional(), ...paging(100, 200) });
export const platformDocumentUploadUrlSchema = z.object({
  bucket: z.enum(DOCUMENT_BUCKETS).optional(),
  entity_type: entityType,
  entity_id: uuidSchema,
  file_name: z.string().trim().min(1).max(200),
  content_type: z.enum(PLATFORM_DOCUMENT_MIME_TYPES),
  doc_type: docType,
  size_bytes: z.number().int().min(1).max(50 * 1024 * 1024).optional(),
});

/* ───────────── privacy & breach ───────────── */
export const platformPrivacyExportSchema = z
  .object({ lead_id: uuidSchema.optional(), customer_id: uuidSchema.optional(), note: z.string().trim().max(500).optional() })
  .refine((v) => !!v.lead_id !== !!v.customer_id, { message: 'Give exactly one of lead_id or customer_id', path: ['lead_id'] });
export const platformPrivacyEraseSchema = z.object({ lead_id: uuidSchema, reason: text(5, 500) });
export const platformDataRequestQuerySchema = z.object({ kind: z.enum(['export', 'erasure']).optional(), status: z.enum(['requested', 'completed', 'rejected']).optional(), ...paging(50, 200) });
export const platformUnmaskAuditQuerySchema = z.object({
  actor: uuidSchema.optional(), record: z.string().trim().max(80).optional(), from: z.string().trim().max(40).optional(), to: z.string().trim().max(40).optional(), ...paging(50, 200),
});

export const platformBreachCreateSchema = z.object({
  title: text(3, 200),
  description: text(1, 4000).optional(),
  /** defaults to now; the 72-hour (rule dpdp.breach_report_hours) countdown runs from this moment */
  detected_at: isoDateTimeSchema.optional(),
  evidence_note: text(1, 2000).optional(),
});
export const platformBreachPatchSchema = z
  .object({ title: text(3, 200).optional(), description: text(1, 4000).nullable().optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });
export const platformBreachEvidenceSchema = z.object({ note: text(1, 2000) });
export const platformBreachReportSchema = z.object({ reported_at: isoDateTimeSchema.optional(), reference: z.string().trim().max(200).optional(), note: text(1, 2000).optional() });
export const platformBreachCloseSchema = z.object({ reason: text(5, 1000).optional() });
export const platformBreachListQuerySchema = z.object({ status: z.enum(['open', 'reported', 'closed']).optional(), overdue: platformQueryBool.optional(), ...paging(50, 200) });
