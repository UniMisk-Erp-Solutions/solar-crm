/* eslint-disable @typescript-eslint/no-explicit-any -- thin adapter over the untyped supabase-js query builder */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { TableName, TableRow } from '@solar/shared';
import { AppError } from '../http/errors';
import type { Db, ListOpts, ListResult, OpObject, OrderBy, Repo, Where } from './types';

export function mapPgError(table: string, err: { code?: string; message: string; details?: string | null }): AppError {
  switch (err.code) {
    case '23505': return new AppError(409, 'CONFLICT', 'That record already exists', { table, detail: err.details });
    case '23503': return new AppError(409, 'CONFLICT', 'This record is linked to other data and cannot be changed that way', { table });
    case '23502': case '23514': case '22P02': return new AppError(422, 'VALIDATION_ERROR', err.message, { table });
    case 'P0001': return new AppError(422, 'GUARD_BLOCKED', err.message, { table });
    case '42501': return new AppError(403, 'FORBIDDEN', 'You do not have access to this', { table });
    default: return new AppError(500, 'INTERNAL', 'Something went wrong while saving. Please try again.', { table, pg: err.code });
  }
}

function applyWhere(q: any, where?: Where): any {
  if (!where) return q;
  for (const [col, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (cond === null) q = q.is(col, null);
    else if (Array.isArray(cond)) q = q.in(col, cond);
    else if (typeof cond === 'object') {
      const o = cond as OpObject;
      if (o.eq !== undefined) q = o.eq === null ? q.is(col, null) : q.eq(col, o.eq);
      if (o.neq !== undefined) q = o.neq === null ? q.not(col, 'is', null) : q.neq(col, o.neq);
      if (o.gt !== undefined) q = q.gt(col, o.gt);
      if (o.gte !== undefined) q = q.gte(col, o.gte);
      if (o.lt !== undefined) q = q.lt(col, o.lt);
      if (o.lte !== undefined) q = q.lte(col, o.lte);
      if (o.in !== undefined) q = q.in(col, o.in);
      if (o.nin !== undefined) q = q.not(col, 'in', `(${o.nin.map((x) => JSON.stringify(x)).join(',')})`);
      if (o.like !== undefined) q = q.like(col, o.like);
      if (o.ilike !== undefined) q = q.ilike(col, o.ilike);
      if (o.contains !== undefined) q = q.contains(col, o.contains);
      if (o.overlaps !== undefined) q = q.overlaps(col, o.overlaps);
      if (o.is_null !== undefined) q = o.is_null ? q.is(col, null) : q.not(col, 'is', null);
    } else q = q.eq(col, cond);
  }
  return q;
}

function applySearch(q: any, search?: ListOpts['search']): any {
  if (!search || !search.text.trim()) return q;
  const t = search.text.trim().replace(/[,()%*\\]/g, ' ');
  return q.or(search.cols.map((c) => `${c}.ilike.%${t}%`).join(','));
}

function applyOrder(q: any, orderBy?: OrderBy | OrderBy[]): any {
  const specs = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
  for (const s of specs) q = q.order(s.col, { ascending: (s.dir ?? 'asc') === 'asc' });
  return q;
}

const clean = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

class SupabaseRepo implements Repo<any> {
  constructor(private c: SupabaseClient, private name: string) {}
  private from(): any { return this.c.from(this.name) as any; }

  async list(opts: ListOpts = {}): Promise<ListResult<any>> {
    let q = this.from().select('*', { count: 'exact' });
    q = applyOrder(applySearch(applyWhere(q, opts.where), opts.search), opts.orderBy);
    if (opts.limit !== undefined) { const off = opts.offset ?? 0; q = q.range(off, off + opts.limit - 1); }
    const { data, error, count } = await q;
    if (error) throw mapPgError(this.name, error);
    return { rows: data ?? [], total: count ?? (data?.length ?? 0) };
  }
  async all(where?: Where, opts: Omit<ListOpts, 'where' | 'limit' | 'offset'> = {}): Promise<any[]> {
    const out: any[] = [];
    // page through PostgREST's default 1000-row cap
    for (let off = 0; ; off += 1000) {
      let q = this.from().select('*');
      q = applyOrder(applySearch(applyWhere(q, where), opts.search), opts.orderBy ?? { col: 'id' }).range(off, off + 999);
      const { data, error } = await q;
      if (error) throw mapPgError(this.name, error);
      out.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    return out;
  }
  async get(id: string): Promise<any | null> {
    const { data, error } = await this.from().select('*').eq('id', id).maybeSingle();
    if (error) throw mapPgError(this.name, error);
    return data ?? null;
  }
  async getOrThrow(id: string): Promise<any> {
    const r = await this.get(id);
    if (!r) throw new AppError(404, 'NOT_FOUND', `${this.name} not found`);
    return r;
  }
  async one(where: Where): Promise<any | null> {
    const { data, error } = await applyWhere(this.from().select('*'), where).limit(1).maybeSingle();
    if (error) throw mapPgError(this.name, error);
    return data ?? null;
  }
  async count(where?: Where): Promise<number> {
    const { count, error } = await applyWhere(this.from().select('id', { count: 'exact', head: true }), where);
    if (error) throw mapPgError(this.name, error);
    return count ?? 0;
  }
  async insert(row: Record<string, unknown>): Promise<any> {
    const { data, error } = await this.from().insert(clean(row)).select().single();
    if (error) throw mapPgError(this.name, error);
    return data;
  }
  async insertMany(rows: Record<string, unknown>[]): Promise<any[]> {
    if (!rows.length) return [];
    const { data, error } = await this.from().insert(rows.map(clean)).select();
    if (error) throw mapPgError(this.name, error);
    return data ?? [];
  }
  async update(id: string, patch: Record<string, unknown>): Promise<any> {
    const { data, error } = await this.from().update(clean(patch)).eq('id', id).select().maybeSingle();
    if (error) throw mapPgError(this.name, error);
    if (!data) throw new AppError(404, 'NOT_FOUND', `${this.name} not found`);
    return data;
  }
  async updateWhere(where: Where, patch: Record<string, unknown>): Promise<any[]> {
    const { data, error } = await applyWhere(this.from().update(clean(patch)), where).select();
    if (error) throw mapPgError(this.name, error);
    return data ?? [];
  }
  async delete(id: string): Promise<void> {
    const { error } = await this.from().delete().eq('id', id);
    if (error) throw mapPgError(this.name, error);
  }
}

/** {@link Db} backed by Supabase Postgres via the SERVICE-ROLE key. Server-side only. */
export class SupabaseDb implements Db {
  readonly client: SupabaseClient;
  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  table<K extends TableName>(name: K): Repo<TableRow<K>> {
    return new SupabaseRepo(this.client, name) as unknown as Repo<TableRow<K>>;
  }
}
