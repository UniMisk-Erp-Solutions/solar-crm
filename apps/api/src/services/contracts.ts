/**
 * Service contracts shared across modules. Services are created per request and bound to the request's
 * AppContext (`ctx.svc.x`), so they can call each other without import cycles and tests can swap any of them.
 */
import type {
  AppRole, Clock, ClockType, ComplianceStatus, ConsentChannel, Finding, Json, MessageChannel, MessagePurpose, MessageStatus,
  NotificationSeverity, RuleConfig, RuleConfidence, RuleStatus, Severity, TemplateCategory,
} from '@solar/shared';

/* ───────────── Rules ───────────── */
export interface ResolvedRule {
  id: string; category: string; key: string; value: Json;
  status: RuleStatus; confidence: RuleConfidence; isActive: boolean; maxSeverity: Severity; enforceHardStop: boolean;
  source: { name: string; ref: string }; effective_from: string; effective_to: string | null; notes: string | null;
}
export interface RuleVersionInput {
  category: string; key: string; value: Json; effective_from: string; effective_to?: string | null; source_name: string; source_ref: string;
  confidence: RuleConfidence; status: RuleStatus; is_active?: boolean; max_severity?: Severity; enforce_hard_stop?: boolean; notes?: string | null;
}
export interface RuleService {
  /** Rule version in force on `ref` (default: today). Returns null if no version covers that date. */
  get(category: string, key: string, ref?: Date | string): Promise<ResolvedRule | null>;
  /** Same as get() but takes a dotted path like "pmsg.cfa.max_total" (category = first segment). */
  path(path: string, ref?: Date | string): Promise<ResolvedRule | null>;
  /** The rule's value only when it is ACTIVE; otherwise `fallback` (null by default). Never use inactive rules to change behaviour. */
  value<T = Json>(path: string, ref?: Date | string, fallback?: T | null): Promise<T | null>;
  list(filter?: { category?: string; status?: RuleStatus; active?: boolean; q?: string }): Promise<RuleConfig[]>;
  history(category: string, key: string): Promise<RuleConfig[]>;
  createVersion(input: RuleVersionInput): Promise<RuleConfig>;
  update(id: string, patch: Partial<Pick<RuleConfig, 'value' | 'effective_from' | 'effective_to' | 'source_name' | 'source_ref' | 'confidence' | 'status' | 'notes' | 'max_severity' | 'enforce_hard_stop'>>): Promise<RuleConfig>;
  setActive(id: string, active: boolean, opts?: { enforceHardStop?: boolean; maxSeverity?: Severity }): Promise<RuleConfig>;
}

/** Severity a gate may produce given its governing rule: verified+active → full; unverified/conflicting/inactive → advisory (warning). */
export type SeverityDecision = { severity: Severity; advisory: boolean };

/* ───────────── Clocks ───────────── */
export interface StartClockInput {
  entity_type: string; entity_id: string; clock_type: ClockType; due_at: Date | string; started_at?: Date | string; warn_at?: Date | string | null;
  owner_id?: string | null; meta?: Json;
}
export interface ClockService {
  /** Starts a clock; any running clock for the same entity+type is cancelled first (restart semantics). warn_at defaults to 70% of the duration. */
  start(input: StartClockInput): Promise<Clock>;
  /** Marks the running clock for the entity+type as met (or resolved if it had already breached). */
  complete(entity_type: string, entity_id: string, clock_type: ClockType, meta?: Json): Promise<Clock | null>;
  cancel(entity_type: string, entity_id: string, clock_type?: ClockType): Promise<number>;
  forEntity(entity_type: string, entity_id: string): Promise<Clock[]>;
}
export interface ClockHandlers {
  onWarn?(ctx: import('../auth/context').AppContext, clock: Clock): Promise<void>;
  /** Called once when the clock passes due_at (status becomes 'breached', escalated_level 1). */
  onBreach?(ctx: import('../auth/context').AppContext, clock: Clock): Promise<void>;
  /** Called when a still-unresolved breached clock escalates to level 2 (Sales Manager) or 3 (Management). */
  onEscalate?(ctx: import('../auth/context').AppContext, clock: Clock, level: number): Promise<void>;
}

/* ───────────── Notifications ───────────── */
export interface NotifyInput {
  user_ids?: string[]; roles?: AppRole[]; /** limit role recipients to this distributor's users + internal users */ distributor_id?: string | null;
  kind: string; title: string; body?: string | null; severity?: NotificationSeverity; link?: string | null; entity_type?: string | null; entity_id?: string | null;
}
export interface NotifyService {
  /** Creates one in-app notification per resolved recipient; returns the number created. */
  notify(input: NotifyInput): Promise<number>;
}

/* ───────────── Consent & messaging (implemented by the lead module) ───────────── */
export type OutboundBlockCode = 'NO_CONSENT' | 'PURPOSE_NOT_CONSENTED' | 'CHANNEL_NOT_CONSENTED' | 'WITHDRAWN' | 'SUPPRESSED_90_DAY' | 'DND_REGISTERED' | 'DND_UNCHECKED' | 'DND_STALE' | 'WHATSAPP_WINDOW_CLOSED' | 'NO_TEMPLATE' | 'NO_CONTACT';
export interface OutboundCheck {
  allowed: boolean; consent_id: string | null;
  reasons: { code: OutboundBlockCode; message: string }[];
  /** WhatsApp only: is the 24-hour customer-service window currently open? */
  whatsapp_window_open?: boolean;
}
export interface ConsentService {
  /** Gate G1: may we send this purpose on this channel to this lead right now? Promotional needs consent + DND clear + no suppression; service/transactional needs a consent record or an open window. */
  checkOutbound(leadId: string, input: { channel: ConsentChannel; purpose: MessagePurpose }): Promise<OutboundCheck>;
}
export interface SendInput {
  lead_id: string; channel: MessageChannel; purpose: MessagePurpose; template_key?: string; body?: string; subject?: string; vars?: Record<string, string>;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}
export interface SendResult { status: MessageStatus; blocked: boolean; reasons: OutboundCheck['reasons']; message_log_id: string; template_category: TemplateCategory | null }
export interface MessagingService {
  /** The only way application code sends a customer message. Checks consent/DND/suppression/window, picks provider, writes message_log. */
  send(input: SendInput): Promise<SendResult>;
}

/* ───────────── Compliance (implemented by the quote module) ───────────── */
export interface EvaluationResult { findings: Finding[]; hasHardStop: boolean; status: ComplianceStatus; ruleIdsUsed: string[]; evaluated_at: string }
export interface ComplianceService {
  /** Evaluate gates G1–G14 for a quote against the rules in force on its expected commissioning date. Persists findings on the quote unless persist=false. */
  evaluateQuote(quoteId: string, opts?: { persist?: boolean }): Promise<EvaluationResult>;
  evaluateDispatch(soId: string, opts?: { persist?: boolean; dispatchId?: string; serialIds?: string[] }): Promise<EvaluationResult>;
}

export interface Services {
  rules: RuleService;
  clocks: ClockService;
  notify: NotifyService;
  consent: ConsentService;
  messaging: MessagingService;
  compliance: ComplianceService;
}
