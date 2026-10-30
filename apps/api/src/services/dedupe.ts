/**
 * Stage 1, step 2 — duplicate and existing-customer detection.
 * Exact matches: mobile, e-mail, consumer number. Fuzzy: name + same pincode by bigram-Jaccard similarity
 * (the TypeScript twin of the pg_trgm similarity used in the SQL duplicate function; threshold default 0.6, rule `lead.dedupe_similarity_threshold`).
 */
import { maskMobile, normalizeMobile, type Customer, type Lead, type LeadCustomerMatch, type LeadDuplicateMatch, type LeadDuplicateReport } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { ruleOr } from './leadServiceSettings';

/** Lower-case, letters/digits only, tokens sorted so “Patel Jayesh” equals “Jayesh Patel”. */
export function normaliseName(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
}

/** Set of 2-character shingles of the normalised string (space-padded at both ends, like trigram padding). */
export function bigrams(normalised: string): Set<string> {
  const s = ` ${normalised} `;
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** Jaccard similarity of the two names’ bigram sets, 0–1. */
export function nameSimilarity(a: string, b: string): number {
  const na = normaliseName(a), nb = normaliseName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const A = bigrams(na), B = bigrams(nb);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface DedupeCandidate { mobile: string; email: string | null; consumer_no: string | null; name: string; pincode: string | null }
export const normaliseConsumerNo = (v: string | null | undefined): string | null => (v ? v.replace(/\s+/g, '').toUpperCase() || null : null);

const KIND_RANK: Record<LeadDuplicateMatch['kind'], number> = { mobile: 0, email: 1, consumer_no: 2, name_pincode: 3 };

/** Leads in these statuses are not the “canonical” record of anything, so they never count as an existing owner. */
const NON_CANONICAL: readonly Lead['status'][] = ['merged'];

export async function findDuplicates(ctx: AppContext, c: DedupeCandidate, opts: { excludeLeadId?: string } = {}): Promise<LeadDuplicateReport> {
  const threshold = await ruleOr<number>(ctx, 'lead.dedupe_similarity_threshold', 0.6);
  const leads = ctx.db.table('leads');
  const found = new Map<string, { lead: Lead; kind: LeadDuplicateMatch['kind']; similarity: number }>();
  const note = (l: Lead, kind: LeadDuplicateMatch['kind'], similarity: number) => {
    if (l.id === opts.excludeLeadId || l.deleted_at || l.anonymised_at || NON_CANONICAL.includes(l.status)) return;
    const cur = found.get(l.id);
    if (!cur || KIND_RANK[kind] < KIND_RANK[cur.kind]) found.set(l.id, { lead: l, kind, similarity });
  };

  // every lookup is independent: ask for them all at once (one round trip of waiting instead of six)
  const consumer = normaliseConsumerNo(c.consumer_no);
  const [byMobile, byEmail, byConsumer, byPincode, customers] = await Promise.all([
    leads.all({ mobile: c.mobile }),
    c.email ? leads.all({ email: c.email.toLowerCase() }) : Promise.resolve([] as Lead[]),
    consumer ? leads.all({ consumer_no: consumer }) : Promise.resolve([] as Lead[]),
    c.pincode ? leads.all({ pincode: c.pincode }) : Promise.resolve([] as Lead[]),
    findCustomerMatches(ctx, c, threshold),
  ]);
  for (const l of byMobile) note(l, 'mobile', 1);
  for (const l of byEmail) note(l, 'email', 1);
  for (const l of byConsumer) note(l, 'consumer_no', 1);
  for (const l of byPincode) {
    if (found.has(l.id)) continue;
    const sim = nameSimilarity(c.name, l.name);
    if (sim >= threshold) note(l, 'name_pincode', Math.round(sim * 100) / 100);
  }

  const leadMatches: LeadDuplicateMatch[] = [...found.values()]
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.lead.created_at.localeCompare(b.lead.created_at))
    .map(({ lead, kind, similarity }) => ({
      kind, similarity, lead_id: lead.id, name: lead.name, status: lead.status, mobile_masked: maskMobile(lead.mobile), dealer_id: lead.dealer_id, distributor_id: lead.distributor_id,
      lock_status: lead.lock_status, locked_by_dealer_id: lead.locked_by_dealer_id, created_at: lead.created_at,
    }));

  return { leads: leadMatches, customers, checked_at: ctx.now().toISOString() };
}

async function findCustomerMatches(ctx: AppContext, c: DedupeCandidate, threshold: number): Promise<LeadCustomerMatch[]> {
  const customers = ctx.db.table('customers');
  const out = new Map<string, LeadCustomerMatch>();
  const add = (cu: Customer, kind: LeadCustomerMatch['kind'], similarity: number) => {
    if (cu.anonymised_at) return;
    const cur = out.get(cu.id);
    if (cur && KIND_RANK[cur.kind] <= KIND_RANK[kind]) return;
    out.set(cu.id, { kind, similarity, customer_id: cu.id, name: cu.display_name ?? cu.legal_name, phone_masked: cu.phone ? maskMobile(cu.phone) : null });
  };

  const national = normalizeMobile(c.mobile);
  const phones = national ? [c.mobile, national, `91${national}`, `0${national}`, `+91 ${national}`] : [c.mobile];
  const consumer = normaliseConsumerNo(c.consumer_no);
  const firstToken = normaliseName(c.name).split(' ').find((t) => t.length >= 3);
  const [byPhone, byEmail, byConsumer, byName] = await Promise.all([
    customers.all({ phone: phones }),
    c.email ? customers.all({ email: c.email.toLowerCase() }) : Promise.resolve([] as Customer[]),
    consumer ? ctx.db.table('sites').all({ consumer_no: consumer }).then(async (sites) => {
      const ids = [...new Set(sites.map((s) => s.customer_id).filter((x): x is string => !!x))];
      return ids.length ? customers.all({ id: ids }) : ([] as Customer[]);
    }) : Promise.resolve([] as Customer[]),
    c.pincode && firstToken ? customers.all(undefined, { search: { cols: ['legal_name', 'display_name'], text: firstToken } }) : Promise.resolve([] as Customer[]),
  ]);
  for (const cu of byPhone) add(cu, 'mobile', 1);
  for (const cu of byEmail) add(cu, 'email', 1);
  for (const cu of byConsumer) add(cu, 'consumer_no', 1);
  if (c.pincode && firstToken) {
    for (const cu of byName) {
      if (out.has(cu.id)) continue;
      const samePin = cu.billing_address?.pincode === c.pincode || cu.shipping_address?.pincode === c.pincode;
      if (!samePin) continue;
      const sim = Math.max(nameSimilarity(c.name, cu.legal_name), cu.display_name ? nameSimilarity(c.name, cu.display_name) : 0);
      if (sim >= threshold) add(cu, 'name_pincode', Math.round(sim * 100) / 100);
    }
  }
  return [...out.values()].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
}

/**
 * Turns the match report into the intake decision. A lead is a duplicate when it matches an existing lead that is still a
 * live record (a lost lead re-enquiring is a fresh opportunity). The canonical target is the match's own `duplicate_of`
 * when it is itself a duplicate. Ownership lock: if that record is locked by a different dealer, the new lead waits for a manager.
 */
export interface DuplicateDecision { duplicate_of: string | null; lock_conflict: boolean; blocking: LeadDuplicateMatch[] }

export async function decideDuplicate(ctx: AppContext, report: LeadDuplicateReport, inputDealerId: string | null): Promise<DuplicateDecision> {
  const blocking = report.leads.filter((m) => m.status !== 'lost');
  if (!blocking.length) return { duplicate_of: null, lock_conflict: false, blocking: [] };
  const lockedByOther = blocking.find((m) => m.lock_status !== 'open' && m.locked_by_dealer_id && m.locked_by_dealer_id !== inputDealerId);
  const target = lockedByOther ?? blocking[0]!;
  let canonical = target.lead_id;
  if (target.status === 'duplicate') {
    const row = await ctx.db.table('leads').get(target.lead_id);
    if (row?.duplicate_of) canonical = row.duplicate_of;
  }
  return { duplicate_of: canonical, lock_conflict: !!lockedByOther, blocking };
}
