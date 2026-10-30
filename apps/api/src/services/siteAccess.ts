/**
 * Shared helpers for the sites / surveys / requirement / negotiation / opportunity modules:
 * lead lookup with row-level visibility, lead timeline events, and lists scoped through the linked lead
 * (customers, sites, surveys have no distributor/dealer columns of their own — visibility follows the lead).
 */
import type { Request } from 'express';
import { listQuerySchema, type Json, type Lead, type TableName, type TableRow } from '@solar/shared';
import { assertCanRead, mergeWhere, scopeWhere } from '../auth/access';
import type { AppContext } from '../auth/context';
import type { OrderBy, Where } from '../db/types';
import { whereFromQuery } from '../http/crud';
import { AppError, forbidden, invalidState, notFound } from '../http/errors';
import { parse } from '../http/handler';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Non-blocking form hints. They never stop a save; the authoritative gate findings come from the compliance engine. */
export interface Hint { code: string; gate?: string; severity: 'info' | 'warning'; advisory: true; message: string }

export const actorId = (ctx: AppContext): string | null => (ctx.system ? null : ctx.user.id);

/** 422 with a field path, in the same shape as Zod validation errors. */
export const invalidField = (path: string, message: string): AppError => new AppError(422, 'VALIDATION_ERROR', message, [{ path, message }]);

/** A path parameter that must be a UUID; anything else is simply "not found". */
export function idParam(req: Request, name = 'id'): string {
  const v = req.params[name];
  if (!v || !UUID_RE.test(v)) throw notFound();
  return v;
}

/** Lead the current user may see (404 for deleted, 403 for another party's lead). */
export async function getVisibleLead(ctx: AppContext, id: string): Promise<Lead> {
  const lead = await ctx.db.table('leads').get(id);
  if (!lead || lead.deleted_at) throw notFound('Lead');
  await assertCanRead(ctx, 'leads', lead);
  return lead;
}

/** Writes are refused on merged/duplicate/anonymised leads. */
export function assertLeadEditable(lead: Lead): void {
  if (lead.status === 'merged' || lead.status === 'duplicate') throw invalidState(`This lead is marked ${lead.status} — continue on the primary lead`, { status: lead.status });
  if (lead.anonymised_at) throw invalidState('This lead has been anonymised and can no longer be edited');
}

export async function logLeadEvent(ctx: AppContext, leadId: string, eventType: string, summary: string, detail: Json = {}): Promise<void> {
  await ctx.db.table('lead_events').insert({ lead_id: leadId, event_type: eventType, summary, actor_id: actorId(ctx), detail });
}

/** id → full_name for a set of profiles (display only). */
export async function profileNames(ctx: AppContext, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  const out = new Map<string, string>();
  if (!unique.length) return out;
  for (const p of await ctx.db.table('profiles').all({ id: unique })) out.set(p.id, p.full_name);
  return out;
}

/* ───────────── visibility through the linked lead ───────────── */

/** null = no restriction (internal user without territory limits); otherwise the ids of the leads this user may see. */
export async function visibleLeadIds(ctx: AppContext): Promise<string[] | null> {
  const scope = await scopeWhere(ctx, 'leads');
  if (scope === null) throw forbidden();
  if (!Object.keys(scope).length) return null;
  return (await ctx.db.table('leads').all(scope)).map((l) => l.id);
}

/** May the user read a record that belongs to a lead (directly via `leadId`, or through leads whose `linkCol` points at it)? */
export async function canReadViaLead(ctx: AppContext, opts: { leadId?: string | null; linkCol?: 'customer_id' | 'site_id'; linkId?: string }): Promise<boolean> {
  const scope = await scopeWhere(ctx, 'leads');
  if (scope === null) return false;
  if (!Object.keys(scope).length) return true;
  const leads = ctx.db.table('leads');
  if (opts.leadId && (await leads.count(mergeWhere({ id: opts.leadId }, scope))) > 0) return true;
  if (opts.linkCol && opts.linkId && (await leads.count(mergeWhere({ [opts.linkCol]: opts.linkId }, scope))) > 0) return true;
  return false;
}

export async function assertCanReadViaLead(ctx: AppContext, opts: Parameters<typeof canReadViaLead>[1]): Promise<void> {
  if (!(await canReadViaLead(ctx, opts))) throw forbidden();
}

const cmpVal = (a: unknown, b: unknown): number => {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : 1;
};

export interface ViaLeadListSpec<K extends TableName> {
  table: K;
  filterCols?: string[];
  searchCols?: string[];
  sortCols?: string[];
  defaultSort?: OrderBy;
  baseWhere?: Where;
  /** extra filters computed by the caller (e.g. date ranges) */
  extraWhere?: Where;
  /** column holding the lead id (default lead_id) */
  leadCol?: string;
}

const CHUNK = 150;

/**
 * Paginated list whose row-level visibility follows the lead: unrestricted users hit the database page directly;
 * restricted users (distributor/dealer, territory-limited staff) get the union over their visible lead ids, sorted and paged here.
 */
export async function listViaLead<K extends TableName>(ctx: AppContext, req: Request, spec: ViaLeadListSpec<K>): Promise<{ rows: TableRow<K>[]; total: number; limit: number; offset: number }> {
  const q = parse(listQuerySchema, req.query);
  const leadCol = spec.leadCol ?? 'lead_id';
  const where: Where = { ...(spec.baseWhere ?? {}), ...whereFromQuery(req.query, spec.filterCols ?? []), ...(spec.extraWhere ?? {}) };
  const allowedSort = new Set([...(spec.sortCols ?? spec.filterCols ?? []), 'created_at', 'updated_at', spec.defaultSort?.col ?? 'created_at']);
  const orderBy: OrderBy = q.sort && allowedSort.has(q.sort) ? { col: q.sort, dir: q.order } : spec.defaultSort ?? { col: 'created_at', dir: 'desc' };
  const search = q.q && spec.searchCols?.length ? { cols: spec.searchCols, text: q.q } : undefined;
  const repo = ctx.db.table(spec.table) as unknown as {
    list(o: unknown): Promise<{ rows: TableRow<K>[]; total: number }>;
    all(w: Where, o: unknown): Promise<TableRow<K>[]>;
  };

  const ids = await visibleLeadIds(ctx);
  if (ids === null) {
    const { rows, total } = await repo.list({ where, orderBy, limit: q.limit, offset: q.offset, search });
    return { rows, total, limit: q.limit, offset: q.offset };
  }

  const asked = where[leadCol];
  delete where[leadCol];
  let allowed = ids;
  if (typeof asked === 'string') allowed = ids.filter((i) => i === asked);
  else if (Array.isArray(asked)) allowed = ids.filter((i) => asked.includes(i));
  const merged: TableRow<K>[] = [];
  for (let i = 0; i < allowed.length; i += CHUNK) merged.push(...(await repo.all({ ...where, [leadCol]: allowed.slice(i, i + CHUNK) }, { search })));
  const dir = orderBy.dir === 'asc' ? 1 : -1;
  merged.sort((a, b) => dir * cmpVal((a as unknown as Record<string, unknown>)[orderBy.col], (b as unknown as Record<string, unknown>)[orderBy.col]));
  return { rows: merged.slice(q.offset, q.offset + q.limit), total: merged.length, limit: q.limit, offset: q.offset };
}
