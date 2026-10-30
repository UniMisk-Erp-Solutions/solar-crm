import { daysBetween, isExternalRole, istDateString, type DashboardFilterInput, type DashboardFilters, type Lead, type Profile, type Segment, type TableName, type TableRow } from '@solar/shared';
import type { AppContext } from '../../auth/context';
import { scopedWhere } from '../../auth/access';
import type { Where } from '../../db/types';
import { istEndOfDay, istMidnight } from '../../lib/time';
import { DAY, chunk, ms } from './stats';

/** Dashboard filters after defaults are applied. All dates are inclusive IST calendar dates. */
export interface ResolvedFilters extends DashboardFilters {
  from: string; to: string; days: number;
  fromMs: number; toMs: number; fromIso: string; toIso: string;
  /** "now" for this request (ctx.now()) and today's IST date */
  nowMs: number; now: Date; today: string;
}

export async function resolveFilters(ctx: AppContext, input: DashboardFilterInput): Promise<ResolvedFilters> {
  const now = ctx.now();
  const today = istDateString(now);
  const to = input.to ?? today;
  const defaultDays = (await ctx.svc.rules.value<number>('reporting.default_period_days', undefined, 90)) ?? 90;
  const from = input.from ?? istDateString(new Date(istMidnight(to).getTime() - (Math.max(1, defaultDays) - 1) * DAY));
  const fromD = istMidnight(from);
  const toD = istEndOfDay(to);
  return {
    from, to, days: daysBetween(from, to) + 1,
    segment: input.segment ?? null, distributor_id: input.distributor_id ?? null, dealer_id: input.dealer_id ?? null,
    fromMs: fromD.getTime(), toMs: toD.getTime(), fromIso: fromD.toISOString(), toIso: toD.toISOString(), nowMs: now.getTime(), now, today,
  };
}

export const inPeriod = (iso: string | null | undefined, f: ResolvedFilters): boolean => {
  const t = ms(iso);
  return t !== null && t >= f.fromMs && t <= f.toMs;
};
/** YYYY-MM-DD date column within the period. */
export const dateInPeriod = (d: string | null | undefined, f: ResolvedFilters): boolean => !!d && d >= f.from && d <= f.to;

interface FilterCols { dist?: string; dealer?: string; segment?: string; segmentVia?: 'sales_order' | 'quote' | 'opportunity'; segmentViaCol?: string }
/** Which columns the dashboard filters map onto, per table. Segment on tables without their own segment goes through the parent record. */
const FILTER_COLS: Partial<Record<TableName, FilterCols>> = {
  leads: { dist: 'distributor_id', dealer: 'dealer_id', segment: 'segment' },
  opportunities: { dist: 'distributor_id', dealer: 'dealer_id', segment: 'segment' },
  quotations: { dist: 'distributor_id', dealer: 'dealer_id', segment: 'segment' },
  sales_orders: { dist: 'distributor_id', dealer: 'dealer_id', segment: 'segment' },
  proforma_invoices: { dist: 'distributor_id', dealer: 'dealer_id', segmentVia: 'quote', segmentViaCol: 'quote_id' },
  credit_checks: { dist: 'distributor_id', dealer: 'dealer_id', segmentVia: 'sales_order', segmentViaCol: 'sales_order_id' },
  loans: { dist: 'distributor_id', dealer: 'dealer_id', segmentVia: 'opportunity', segmentViaCol: 'opportunity_id' },
  discom_applications: { dist: 'distributor_id', dealer: 'dealer_id', segmentVia: 'sales_order', segmentViaCol: 'sales_order_id' },
  subsidy_claims: { dist: 'distributor_id', dealer: 'dealer_id', segmentVia: 'sales_order', segmentViaCol: 'sales_order_id' },
  installations: { dist: 'distributor_id', dealer: 'dealer_id', segmentVia: 'sales_order', segmentViaCol: 'sales_order_id' },
  dealer_receivables: { dist: 'distributor_id', dealer: 'dealer_id' },
  warranty_tickets: { dealer: 'dealer_id', segmentVia: 'sales_order', segmentViaCol: 'sales_order_id' },
  dealers: { dist: 'distributor_id', dealer: 'id' },
  distributors: { dist: 'id' },
};

/** Tables a clock's `entity_type` points at (used to scope clocks to what the user may see). */
const CLOCK_TABLE: Record<string, TableName | undefined> = {
  lead: 'leads', opportunity: 'opportunities', quotation: 'quotations', quote: 'quotations', sales_order: 'sales_orders', proforma_invoice: 'proforma_invoices', pi: 'proforma_invoices',
  discom_application: 'discom_applications', subsidy_claim: 'subsidy_claims', loan: 'loans', installation: 'installations', warranty_ticket: 'warranty_tickets', dealer: 'dealers',
};

/**
 * Request-scoped data access for the KPI families. Every read goes through `scopedWhere` (external users only ever see their own party,
 * territory-restricted users only their territories) and the dashboard filters, and is memoised so the home queue — which touches many
 * families — fetches each table once.
 */
export class KpiScope {
  private memo = new Map<string, Promise<unknown>>();

  constructor(readonly ctx: AppContext, readonly filters: ResolvedFilters) {}

  get user(): Profile { return this.ctx.user; }
  get external(): boolean { return isExternalRole(this.ctx.user.role); }
  /** true when some rows may be hidden from this user or by the dashboard filters */
  get restricted(): boolean {
    const f = this.filters;
    return this.external || this.ctx.user.territory_ids.length > 0 || !!f.segment || !!f.distributor_id || !!f.dealer_id;
  }

  private remember<T>(key: string, make: () => Promise<T>): Promise<T> {
    let p = this.memo.get(key) as Promise<T> | undefined;
    if (!p) { p = make(); this.memo.set(key, p); }
    return p;
  }

  /**
   * Rows of a party-scoped table, restricted by the signed-in user's scope and the dashboard filters.
   * `raw: true` skips the dashboard filters (still applies the user's scope) — used to join downstream records of an already-filtered cohort.
   */
  rows<K extends TableName>(table: K, where: Where = {}, opts: { raw?: boolean } = {}): Promise<TableRow<K>[]> {
    return this.remember(`${table}|${opts.raw ? 'raw' : 'f'}|${JSON.stringify(where)}`, async () => {
      const spec = FILTER_COLS[table];
      const f = this.filters;
      const w: Where = { ...where };
      if (!opts.raw && spec) {
        if (f.distributor_id && spec.dist) w[spec.dist] = f.distributor_id;
        if (f.dealer_id && spec.dealer) w[spec.dealer] = f.dealer_id;
        if (f.segment && spec.segment) w[spec.segment] = f.segment;
      }
      const scoped = await scopedWhere(this.ctx, table, w);
      let rows = await this.ctx.db.table(table).all(scoped);
      if (!opts.raw && f.segment && spec?.segmentVia && spec.segmentViaCol) {
        const seg = await this.segmentMap(spec.segmentVia);
        const col = spec.segmentViaCol;
        rows = rows.filter((r) => seg.get((r as unknown as Record<string, string | null>)[col] ?? '') === f.segment);
      }
      return rows;
    });
  }

  /** id → segment for parent records (unfiltered; only used to resolve a child row's segment). */
  private segmentMap(kind: 'sales_order' | 'quote' | 'opportunity'): Promise<Map<string, Segment>> {
    return this.remember(`segmap|${kind}`, async () => {
      const table = kind === 'sales_order' ? 'sales_orders' : kind === 'quote' ? 'quotations' : 'opportunities';
      const rows = (await this.ctx.db.table(table).all()) as { id: string; segment: Segment }[];
      return new Map(rows.map((r) => [r.id, r.segment]));
    });
  }

  /** Every (non-deleted) lead this user may see under the dashboard filters, by id — no period restriction. */
  leadMap(): Promise<Map<string, Lead>> {
    return this.remember('leadMap', async () => new Map((await this.rows('leads', { deleted_at: null })).map((l) => [l.id, l])));
  }

  /**
   * Ids of the entities of `entityType` visible to this user (for clocks and other id-linked tables).
   * Returns 'all' when nothing is hidden, null when users with a restricted scope cannot see this entity type at all.
   */
  entityIds(entityType: string): Promise<Set<string> | 'all' | null> {
    return this.remember(`entityIds|${entityType}`, async () => {
      if (!this.restricted) return 'all' as const;
      const table = CLOCK_TABLE[entityType];
      if (!table) return null;
      if (table === 'leads') return new Set((await this.leadMap()).keys());
      return new Set((await this.rows(table)).map((r) => r.id));
    });
  }

  /** Name lookups for hydration: reference data only (names), fetched for the ids actually shown. */
  async names<K extends 'profiles' | 'dealers' | 'distributors' | 'discoms'>(table: K, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
    const want = [...new Set([...ids].filter((x): x is string => !!x))];
    const out = new Map<string, string>();
    for (const part of chunk(want, 100)) {
      const rows = (await this.ctx.db.table(table).all({ id: part })) as unknown as { id: string; full_name?: string; legal_name?: string; name?: string }[];
      for (const r of rows) out.set(r.id, r.full_name ?? r.legal_name ?? r.name ?? r.id);
    }
    return out;
  }

  /** Cached whole-table read of org-wide reference data (discoms, skus …). Not party-scoped — never use for transactional tables. */
  reference<K extends TableName>(table: K, where: Where = {}): Promise<TableRow<K>[]> {
    return this.remember(`ref|${table}|${JSON.stringify(where)}`, () => this.ctx.db.table(table).all(where));
  }
}
