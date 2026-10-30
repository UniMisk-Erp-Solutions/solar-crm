/**
 * Stage 1, steps 3–6 — pincode → territory → eligible distributors → ranked choice, with an explanation of the decision.
 * Pure planning only (reads, no writes): `leadServiceAcceptance` applies the outcome (assignment row, clock, notifications).
 */
import type { Distributor, Json, Pincode, Territory, VendorRegistration } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { dsmIds } from './leadServiceStore';
import { ruleOr } from './leadServiceSettings';

/* ───────────── geography ───────────── */
export interface RoutingGeo {
  pincode: string | null; city: string | null; district: string | null; state: string | null; discom_id: string | null;
  territory_id: string | null; territory_name: string | null; source: 'pincode_table' | 'provider' | 'none';
}
const EMPTY_GEO: RoutingGeo = { pincode: null, city: null, district: null, state: null, discom_id: null, territory_id: null, territory_name: null, source: 'none' };

const inRange = (pin: string, from: string, to: string): boolean => {
  const n = Number(pin);
  return Number.isFinite(n) && n >= Number(from) && n <= Number(to);
};

/** Territory covering a pincode: an explicit pincodes.territory_id, else the narrowest pincode range, else same district + state. */
export async function findTerritory(ctx: AppContext, pin: string, row: Pincode | null, district: string | null, state: string | null): Promise<Territory | null> {
  if (row?.territory_id) {
    const t = await ctx.db.table('territories').get(row.territory_id);
    if (t?.active) return t;
  }
  const territories = await ctx.db.table('territories').all({ active: true });
  const byRange = territories
    .map((t) => ({ t, width: Math.min(...t.pincode_ranges.filter((r) => inRange(pin, r.from, r.to)).map((r) => Number(r.to) - Number(r.from)), Infinity) }))
    .filter((x) => x.width !== Infinity)
    .sort((a, b) => a.width - b.width);
  if (byRange[0]) return byRange[0].t;
  const norm = (s: string | null) => (s ?? '').trim().toLowerCase();
  return territories.find((t) => t.district && norm(t.district) === norm(district) && norm(t.state) === norm(state)) ?? null;
}

/** City / district / state / DISCOM / territory for a pincode. The local pincode table wins; the provider is the fallback. */
export async function resolveGeo(ctx: AppContext, pincode: string | null | undefined): Promise<RoutingGeo> {
  if (!pincode) return EMPTY_GEO;
  const row = await ctx.db.table('pincodes').one({ pincode });
  let city = row?.city ?? null, district = row?.district ?? null, state = row?.state ?? null;
  let source: RoutingGeo['source'] = row ? 'pincode_table' : 'none';
  if (!row) {
    try {
      const hit = await ctx.providers.pincode.lookup(pincode);
      if (hit) { city = hit.city; district = hit.district; state = hit.state; source = 'provider'; }
    } catch (e) { ctx.log.warn({ err: e }, 'pincode provider failed'); }
  }
  if (source === 'none') {
    // a pincode we have no row for, but that falls inside a territory's pincode range, is still routable by range
    const byRange = await findTerritory(ctx, pincode, null, null, null);
    if (!byRange) return { ...EMPTY_GEO, pincode };
    return { pincode, city: null, district: byRange.district, state: byRange.state, discom_id: byRange.discom_id ?? null, territory_id: byRange.id, territory_name: byRange.name, source: 'pincode_table' };
  }
  const territory = await findTerritory(ctx, pincode, row, district, state);
  return { pincode, city, district, state, discom_id: row?.discom_id ?? territory?.discom_id ?? null, territory_id: territory?.id ?? null, territory_name: territory?.name ?? null, source };
}

/* ───────────── eligibility and ranking ───────────── */
export interface RoutingWeights { score: number; load: number; band_fit: number; proximity: number }
export const DEFAULT_ROUTING_WEIGHTS: RoutingWeights = { score: 0.4, load: 0.15, band_fit: 0.15, proximity: 0.3 };

export interface RoutingCandidate {
  distributor_id: string; name: string; eligible: boolean; reasons: string[];
  score: number; open_leads: number; load: number; band_fit: number; proximity?: number; distance_hint?: string | null; total: number;
}
export interface RoutingInput {
  geo: RoutingGeo; capacity_kw: number | null; product_interest: string[]; dealer_id?: string | null;
  /** distributors that already had this lead and lost it (rejected / did not accept / were replaced) */
  exclude?: string[];
  /** the caller already knows the distributor (a distributor entering its own lead, a manager choosing one): skip eligibility, keep the explanation */
  force_distributor_id?: string | null;
}
export interface RoutingDecision {
  mode: 'auto' | 'dealer_upload' | 'manual'; geo: RoutingGeo; weights: RoutingWeights;
  candidates: RoutingCandidate[]; chosen: RoutingCandidate | null; dealer_id: string | null; snapshot: Json;
}

const OPEN_STATUSES = ['assigned', 'accepted', 'contacted', 'qualified', 'site_visit'];

export function normaliseWeights(raw: Partial<RoutingWeights> | null | undefined): RoutingWeights {
  const w = { ...DEFAULT_ROUTING_WEIGHTS };
  for (const k of ['score', 'load', 'band_fit', 'proximity'] as const) {
    const v = raw?.[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) w[k] = v;
  }
  const sum = w.score + w.load + w.band_fit + w.proximity;
  return sum > 0 ? { score: w.score / sum, load: w.load / sum, band_fit: w.band_fit / sum, proximity: w.proximity / sum } : { ...DEFAULT_ROUTING_WEIGHTS };
}

/** 1 when the lead size sits in the middle of the band (log scale), 0 at the edges, 0.5 when the size is unknown. */
export function bandFit(capacityKw: number | null, min: number, max: number): number {
  if (capacityKw === null) return 0.5;
  if (max <= min || min <= 0) return capacityKw >= min && capacityKw <= max ? 1 : 0;
  const pos = (Math.log(Math.max(capacityKw, min)) - Math.log(min)) / (Math.log(max) - Math.log(min));
  return Math.max(0, Math.min(1, 1 - Math.abs(pos - 0.5) * 2));
}

/**
 * How close a distributor's home pincode is to the lead's pincode, 0..1. Indian pincodes are numbered by postal region, so the numeric gap
 * tracks the real distance well: the same three-digit prefix (the same sorting district) scores above 0.5, a neighbouring region about 0.2.
 */
export function pincodeProximity(leadPin: string | null, homePin: string | null): { value: number; hint: string | null } {
  if (!leadPin || !homePin || !/^[0-9]{6}$/.test(leadPin) || !/^[0-9]{6}$/.test(homePin)) return { value: 0.5, hint: null };
  const gap = Math.abs(Number(leadPin) - Number(homePin));
  const hint = leadPin.slice(0, 3) === homePin.slice(0, 3) ? 'same postal region' : leadPin.slice(0, 2) === homePin.slice(0, 2) ? 'nearby region' : 'far region';
  return { value: 1 / (1 + gap / 600), hint };
}

const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

/** Vendor registrations of a distributor: none → no constraint; otherwise one active registration must cover the lead's state and district. */
export function registrationCovers(regs: VendorRegistration[], geo: Pick<RoutingGeo, 'state' | 'district'>): { ok: boolean; reason?: string } {
  if (!regs.length) return { ok: true };
  const usable = regs.filter((r) => r.portal_status !== 'deactivated');
  if (!usable.length) return { ok: false, reason: 'Vendor registration is deactivated' };
  const covers = usable.some((r) => {
    if (r.level === 'national') return true;
    const stateOk = !r.states.length || r.states.some((s) => norm(s) === norm(geo.state));
    const districtOk = !r.districts.length || r.districts.some((d) => norm(d) === norm(geo.district));
    return stateOk && districtOk;
  });
  return covers ? { ok: true } : { ok: false, reason: `Vendor registration does not cover ${geo.district ?? 'this district'}, ${geo.state ?? 'this state'}` };
}

export function evaluateDistributor(d: Distributor, regs: VendorRegistration[], input: Pick<RoutingInput, 'geo' | 'capacity_kw' | 'product_interest'>): string[] {
  const reasons: string[] = [];
  if (d.status !== 'active') reasons.push(`Distributor is ${d.status.replace('_', ' ')}`);
  if (!input.geo.territory_id) reasons.push('Pincode does not fall in any territory');
  else if (!d.territory_ids.includes(input.geo.territory_id)) reasons.push(`Does not serve ${input.geo.territory_name ?? 'this territory'}`);
  if (input.capacity_kw !== null && (input.capacity_kw < d.capacity_band_min_kw || input.capacity_kw > d.capacity_band_max_kw)) {
    reasons.push(`${input.capacity_kw} kW is outside the ${d.capacity_band_min_kw}–${d.capacity_band_max_kw} kW band`);
  }
  const missing = input.product_interest.filter((p) => !d.capability_tags.map(norm).includes(norm(p)));
  if (missing.length) reasons.push(`Lacks capability: ${missing.join(', ')}`);
  const reg = registrationCovers(regs, input.geo);
  if (!reg.ok && reg.reason) reasons.push(reg.reason);
  return reasons;
}

export async function loadRoutingWeights(ctx: AppContext): Promise<RoutingWeights> {
  return normaliseWeights(await ruleOr<Partial<RoutingWeights> | null>(ctx, 'routing.score_weights', null));
}

async function openLeadCount(ctx: AppContext, distributorId: string): Promise<number> {
  return ctx.db.table('leads').count({ distributor_id: distributorId, status: OPEN_STATUSES, deleted_at: null });
}

/** Eligible distributors for a lead, ranked by `routing.score_weights` (score, spare capacity, band fit) — with the reasoning kept as a snapshot. */
export async function planRouting(ctx: AppContext, input: RoutingInput): Promise<RoutingDecision> {
  const weights = await loadRoutingWeights(ctx);
  const loadRef = Math.max(1, await ruleOr<number>(ctx, 'routing.load_reference_leads', 20));
  const exclude = new Set(input.exclude ?? []);

  if (input.force_distributor_id) {
    const dist = await ctx.db.table('distributors').get(input.force_distributor_id);
    if (dist) {
      const reasons = evaluateDistributor(dist, (await ctx.db.table('vendor_registrations').all({ party_type: 'distributor', party_id: dist.id })), input);
      const open = await openLeadCount(ctx, dist.id);
      const cand: RoutingCandidate = { distributor_id: dist.id, name: dist.legal_name, eligible: reasons.length === 0, reasons: reasons.length ? ['Chosen by a person; ' + reasons.join('; ')] : ['Chosen by a person'], score: dist.score, open_leads: open, load: round(Math.max(0, 1 - open / loadRef)), band_fit: round(bandFit(input.capacity_kw, dist.capacity_band_min_kw, dist.capacity_band_max_kw)), total: 1 };
      return finish('manual', [cand], cand, input.dealer_id ?? null);
    }
  }
  // dealer-uploaded leads stay with the uploading dealer's distributor
  if (input.dealer_id) {
    const dealer = await ctx.db.table('dealers').get(input.dealer_id);
    const dist = dealer ? await ctx.db.table('distributors').get(dealer.distributor_id) : null;
    if (dealer && dist && !exclude.has(dist.id)) {
      const open = await openLeadCount(ctx, dist.id);
      const cand: RoutingCandidate = { distributor_id: dist.id, name: dist.legal_name, eligible: true, reasons: ['Uploaded by this distributor’s dealer'], score: dist.score, open_leads: open, load: Math.max(0, 1 - open / loadRef), band_fit: bandFit(input.capacity_kw, dist.capacity_band_min_kw, dist.capacity_band_max_kw), total: 1 };
      return finish('dealer_upload', [cand], cand, dealer.id);
    }
  }

  const distributors = await ctx.db.table('distributors').all();
  const regs = await ctx.db.table('vendor_registrations').all({ party_type: 'distributor' });
  const candidates: RoutingCandidate[] = [];
  // open leads per distributor in ONE query (not one count per distributor)
  const openBy = new Map<string, number>();
  if (distributors.length) {
    for (const l of await ctx.db.table('leads').all({ distributor_id: distributors.map((x) => x.id), status: OPEN_STATUSES, deleted_at: null })) openBy.set(l.distributor_id!, (openBy.get(l.distributor_id!) ?? 0) + 1);
  }
  for (const d of distributors) {
    const reasons = evaluateDistributor(d, regs.filter((r) => r.party_id === d.id), input);
    if (exclude.has(d.id)) reasons.push('Already had this lead and did not take it');
    const open = openBy.get(d.id) ?? 0;
    const load = Math.max(0, 1 - open / loadRef);
    const fit = bandFit(input.capacity_kw, d.capacity_band_min_kw, d.capacity_band_max_kw);
    const scoreFactor = Math.max(0, Math.min(1, d.score / 100));
    const near = pincodeProximity(input.geo.pincode, (d.address as { pincode?: string } | null)?.pincode ?? null);
    const total = weights.score * scoreFactor + weights.load * load + weights.band_fit * fit + weights.proximity * near.value;
    candidates.push({ distributor_id: d.id, name: d.legal_name, eligible: reasons.length === 0, reasons, score: d.score, open_leads: open, load: round(load), band_fit: round(fit), proximity: round(near.value), distance_hint: near.hint, total: round(total) });
  }
  // No eligible distributor means step 6 (the DSM assigns). The list stays ranked by the same score, which includes pincode closeness, so the nearest come first.
  const ranked = candidates.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.total - a.total || b.score - a.score || a.name.localeCompare(b.name));
  return finish('auto', ranked, ranked.find((c) => c.eligible) ?? null, input.dealer_id ?? null);

  function finish(mode: RoutingDecision['mode'], cands: RoutingCandidate[], chosen: RoutingCandidate | null, dealerId: string | null): RoutingDecision {
    const snapshot = {
      mode, rule: 'routing.score_weights', weights, geo: input.geo, capacity_kw: input.capacity_kw, product_interest: input.product_interest,
      chosen: chosen?.distributor_id ?? null, candidates: cands,
    } as unknown as Json;
    return { mode, geo: input.geo, weights, candidates: cands, chosen, dealer_id: dealerId, snapshot };
  }
}
const round = (n: number): number => Math.round(n * 1000) / 1000;

/* ───────────── owner selection ───────────── */
/** Least-loaded active user of the distributor (or, for dealer uploads, of the dealer first); the territory DSM when nobody qualifies. */
export async function pickOwner(ctx: AppContext, opts: { distributor_id: string | null; dealer_id?: string | null; territory_id: string | null }): Promise<string | null> {
  const profiles = ctx.db.table('profiles');
  const leastLoaded = async (ids: string[]): Promise<string | null> => {
    let best: { id: string; load: number } | null = null;
    for (const id of ids) {
      const load = await ctx.db.table('leads').count({ owner_id: id, status: OPEN_STATUSES, deleted_at: null });
      if (!best || load < best.load) best = { id, load };
    }
    return best?.id ?? null;
  };
  if (opts.dealer_id) {
    const u = await leastLoaded((await profiles.all({ dealer_id: opts.dealer_id, role: 'dealer_user', active: true })).map((p) => p.id));
    if (u) return u;
  }
  if (opts.distributor_id) {
    const u = await leastLoaded((await profiles.all({ distributor_id: opts.distributor_id, role: 'distributor_user', active: true })).map((p) => p.id));
    if (u) return u;
  }
  return (await dsmIds(ctx, opts.territory_id))[0] ?? null;
}

