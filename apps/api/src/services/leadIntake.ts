/**
 * Stage 0/1 — one capture pipeline for every entry point (public form, call centre, referral, dealer upload, campaign webhook,
 * WhatsApp inbound, internal manual form):
 *   idempotency → parties → geography → duplicate check → DND scrub → lead row → validated | duplicate → routing (auto-assign | DSM)
 *   → consent ledger row (recipients named after routing) → inherited opt-out suppression → score.
 * Nothing here sends a customer message; the consent row is the precondition the send pipeline checks later.
 */
import {
  LEAD_SOURCE_LABEL, type Json, type Lead, type LeadConsentCapture, type LeadDuplicateReport, type LeadSource, type LeadValidationHint,
} from '@solar/shared';
import type { AppContext } from '../auth/context';
import { AppError } from '../http/errors';
import { audit } from '../lib/audit';
import { scrubDnd } from './consentService';
import { inheritSuppression, recordConsent } from './consentServiceLedger';
import { decideDuplicate, findDuplicates, normaliseConsumerNo } from './dedupe';
import { acceptLead, routeLead } from './leadServiceAcceptance';
import { acceptanceDueAt, workingMinutesFrom } from './leadServiceSettings';
import { dsmIds, fallbackOwnerId, inferSegment, logLeadEvent, notifyStaff, saveLead } from './leadServiceStore';
import { resolveGeo } from './routing';
import { deriveTemperature, recomputeLeadScore } from './scoring';

const iso = (d: Date): string => d.toISOString();

export interface CaptureInput {
  source: LeadSource; origin: 'public' | 'internal' | 'webhook';
  name: string; mobile: string; email?: string | null;
  pincode?: string; city?: string; district?: string; state?: string; segment?: Lead['segment']; customer_type?: Lead['customer_type']; capacity_kw?: number;
  product_interest?: string[]; consumer_no?: string; language?: Lead['language']; requirement_text?: string; notes?: string; bill_captured?: boolean; timeline_bucket?: Lead['timeline_bucket'];
  dealer_id?: string; distributor_id?: string; owner_id?: string; source_ref?: string;
  /** utm / campaign / referrer / platform ids — stored under leads.source_detail together with the request’s IP and user agent */
  provenance?: Record<string, Json>;
  consent?: LeadConsentCapture;
  /** a distributor or dealer user entering their own lead: assigned to them and accepted at once */
  selfAccept?: boolean;
}

export interface CaptureResult {
  lead: Lead; created: boolean; duplicate_of: string | null; lock_conflict: boolean; duplicates: LeadDuplicateReport;
  assigned: boolean; consent_id: string | null; hints: LeadValidationHint[];
}

export const emptyReport = (ctx: AppContext): LeadDuplicateReport => ({ leads: [], customers: [], checked_at: ctx.now().toISOString() });

export function validationHints(lead: Pick<Lead, 'segment' | 'pincode' | 'capacity_kw'>): LeadValidationHint[] {
  const hints: LeadValidationHint[] = [];
  if (!lead.segment) hints.push({ field: 'segment', message: 'Segment is required before a quote can be prepared' });
  if (!lead.pincode) hints.push({ field: 'pincode', message: 'Add the pincode so the lead can be matched to a territory' });
  if (lead.capacity_kw === null) hints.push({ field: 'capacity_kw', message: 'Add the approximate system size (kW) to match a distributor’s capacity band' });
  return hints;
}

export async function captureLead(ctx: AppContext, input: CaptureInput): Promise<CaptureResult> {
  const leads = ctx.db.table('leads');
  const now = ctx.now();

  // 0 — webhooks retry: the same external reference never creates a second lead
  if (input.source_ref) {
    const prior = await leads.one({ source: input.source, source_ref: input.source_ref });
    if (prior) return { lead: prior, created: false, duplicate_of: prior.duplicate_of, lock_conflict: prior.lock_status === 'override_pending', duplicates: emptyReport(ctx), assigned: !!prior.distributor_id, consent_id: null, hints: validationHints(prior) };
  }

  // 1 — parties named on the request
  const dealer = input.dealer_id ? await ctx.db.table('dealers').get(input.dealer_id) : null;
  if (input.dealer_id && !dealer) throw new AppError(422, 'VALIDATION_ERROR', 'That dealer does not exist', [{ path: 'dealer_id', message: 'Unknown dealer' }]);
  const distributorId = dealer?.distributor_id ?? input.distributor_id ?? null;
  if (input.distributor_id && !dealer && !(await ctx.db.table('distributors').get(input.distributor_id))) {
    throw new AppError(422, 'VALIDATION_ERROR', 'That distributor does not exist', [{ path: 'distributor_id', message: 'Unknown distributor' }]);
  }

  // 2/3 — geography, duplicates, DND
  const email = input.email ? input.email.toLowerCase() : null;
  const consumerNo = normaliseConsumerNo(input.consumer_no);
  // three independent look-ups at once (each is a database round trip)
  const [geo, duplicates, dnd] = await Promise.all([
    resolveGeo(ctx, input.pincode),
    findDuplicates(ctx, { mobile: input.mobile, email, consumer_no: consumerNo, name: input.name, pincode: input.pincode ?? null }),
    scrubDnd(ctx, input.mobile),
  ]);
  const dup = await decideDuplicate(ctx, duplicates, dealer?.id ?? null);

  // 4 — the lead row (status `new`; the DB trigger / MemoryDb writes status_changed events on later transitions)
  const explicitOwner = input.owner_id ?? (input.selfAccept ? ctx.user.id : null);
  const [fallbackOwner, temp] = await Promise.all([
    explicitOwner ? Promise.resolve(null) : fallbackOwnerId(ctx, geo.territory_id),
    deriveTemperature(ctx, { timeline_bucket: input.timeline_bucket ?? null, segment: input.segment ?? null }),
  ]);
  const owner = explicitOwner ?? fallbackOwner;
  if (!owner) throw new AppError(422, 'VALIDATION_ERROR', 'No user is available to own this lead — add a DSM or administrator first', [{ path: 'owner_id', message: 'Owner is required on every lead' }]);
  const firstCheck = await acceptanceDueAt(ctx, temp.temperature, now);
  const detail: Record<string, Json> = { ...(input.provenance ?? {}), origin: input.origin, captured_at: iso(now), ...(ctx.ip ? { ip: ctx.ip } : {}), ...(ctx.userAgent ? { user_agent: ctx.userAgent } : {}) };
  let lead = await leads.insert({
    source: input.source, source_ref: input.source_ref ?? null, source_detail: detail, notice_version: input.consent?.notice_version ?? null,
    name: input.name, mobile: input.mobile, email, pincode: input.pincode ?? null, city: input.city ?? geo.city, district: input.district ?? geo.district, state: input.state ?? geo.state,
    segment: input.segment ?? inferSegment({ segment: null, customer_type: input.customer_type ?? null, product_interest: input.product_interest ?? [] }), customer_type: input.customer_type ?? null, capacity_kw: input.capacity_kw ?? null, product_interest: input.product_interest ?? [],
    status: 'new', temperature: temp.temperature, quality_score: null, owner_id: owner, distributor_id: distributorId, dealer_id: dealer?.id ?? null, territory_id: geo.territory_id,
    customer_id: null, site_id: null, consumer_no: consumerNo, last_action: `Inquiry captured — ${LEAD_SOURCE_LABEL[input.source]}`, last_action_at: iso(now),
    next_action: 'Validate and route the lead', next_followup_at: iso(firstCheck), assigned_at: null, accepted_at: null, sla_due_at: null, first_contacted_at: null,
    language: input.language ?? 'en', lock_status: dealer ? 'locked' : 'open', locked_by_dealer_id: dealer?.id ?? null, duplicate_of: null,
    dnd_status: dnd.status, dnd_checked_at: dnd.checked_at, requirement_text: input.requirement_text ?? null, timeline_bucket: input.timeline_bucket ?? null, budget_inr: null, decision_maker: null,
    decision_maker_access: null, bill_captured: input.bill_captured ?? false, nurture_until: null, nurture_reason: null, lost_reason: null, notes: input.notes ?? null,
    deadline_uplift: temp.deadline_uplift, anonymised_at: null, deleted_at: null, created_by: ctx.system ? null : ctx.user.id,
  });
  // three ledger rows, written together (each is a database round trip)
  await Promise.all([
  logLeadEvent(ctx, lead.id, 'captured', `Inquiry captured — ${LEAD_SOURCE_LABEL[input.source]}`, { source: input.source, origin: input.origin, notice_version: input.consent?.notice_version ?? null, source_ref: input.source_ref ?? null }),
  logLeadEvent(ctx, lead.id, 'dnd_scrubbed', dnd.status === 'unchecked' ? 'DND scrub unavailable — number left unchecked' : `DND scrub: ${dnd.status}${dnd.cached ? ' (recent result reused)' : ''}`, { status: dnd.status, checked_at: dnd.checked_at, source: dnd.source }),
  audit(ctx, { action: 'lead.create', table: 'leads', record_id: lead.id, new: { id: lead.id, source: lead.source, status: lead.status, owner_id: owner, origin: input.origin } as Json }),
  ]);

  // 5 — duplicate? hold it for a manager. otherwise validated → routed
  let assigned = false;
  if (dup.duplicate_of) {
    const holders = [...new Set([...(await dsmIds(ctx, geo.territory_id))])];
    const manager = holders[0] ?? owner;
    lead = (await saveLead(ctx, lead.id, {
      status: 'duplicate', duplicate_of: dup.duplicate_of, lock_status: dup.lock_conflict ? 'override_pending' : lead.lock_status, owner_id: manager,
      last_action: 'Marked as a duplicate of an existing lead', last_action_at: iso(now), next_action: 'Manager review: merge, or approve as an independent lead',
      next_followup_at: iso(await workingMinutesFrom(ctx, 480, now)),
    })).after;
    await logLeadEvent(ctx, lead.id, 'duplicate_detected', dup.lock_conflict ? 'Duplicate of a lead locked by another dealer — waiting for a manager’s override decision' : 'Duplicate of an existing lead', {
      duplicate_of: dup.duplicate_of, lock_conflict: dup.lock_conflict, matches: dup.blocking.slice(0, 5) as unknown as Json, customers: duplicates.customers.slice(0, 3) as unknown as Json,
    });
    await notifyStaff(ctx, {
      user_ids: holders, kind: 'lead.duplicate', severity: dup.lock_conflict ? 'warning' : 'info', lead_id: lead.id, email: dup.lock_conflict,
      title: `Possible duplicate lead — ${lead.name}`, body: dup.lock_conflict ? 'It matches a lead locked by another dealer. Approve or reject the override.' : 'It matches an existing lead. Merge it or approve it as independent.',
    });
  } else {
    lead = (await saveLead(ctx, lead.id, { status: 'validated', last_action: 'Validated — no duplicate found', last_action_at: iso(now) })).after;
    if (duplicates.customers.length) {
      await logLeadEvent(ctx, lead.id, 'existing_customer_match', `Matches an existing customer (${duplicates.customers[0]!.kind.replace('_', ' ')})`, { customers: duplicates.customers.slice(0, 3) as unknown as Json });
    }
    // 6 — routing: a distributor/dealer entering their own lead keeps it; everyone else goes through the engine
    const own = (input.selfAccept || input.distributor_id) && !dealer && distributorId ? { forceDistributorId: distributorId } : {};
    const routed = await routeLead(ctx, lead, { step: 'auto', reason: input.selfAccept ? 'Entered by the distributor’s own user' : input.distributor_id ? `Entered for a named distributor (${LEAD_SOURCE_LABEL[input.source]})` : `Captured via ${LEAD_SOURCE_LABEL[input.source]}`, ownerId: input.selfAccept ? ctx.user.id : input.owner_id, ...own });
    lead = routed.lead;
    assigned = routed.assigned;
    if (assigned && input.selfAccept) lead = await acceptLead(ctx, lead.id, { implicit: true });
  }

  // 7 — consent ledger row (after routing, so the distributor and dealer legal names can be named)
  let consentId: string | null = null;
  if (input.consent) {
    const c = await recordConsent(ctx, {
      lead, notice_version: input.consent.notice_version, purposes: input.consent.purposes, channels: input.consent.channels, proof_ref: input.consent.proof_ref ?? null,
      capture_source: input.consent.capture_source ?? input.source, ip: input.origin === 'internal' ? null : ctx.ip, user_agent: input.origin === 'internal' ? null : ctx.userAgent,
    });
    consentId = c.id;
  }
  await inheritSuppression(ctx, lead);
  const scored = await recomputeLeadScore(ctx, lead.id);
  lead = scored.lead; // already the freshest row (the score step reads it and returns it updated)
  return { lead, created: true, duplicate_of: dup.duplicate_of, lock_conflict: dup.lock_conflict, duplicates, assigned, consent_id: consentId, hints: validationHints(lead) };
}
