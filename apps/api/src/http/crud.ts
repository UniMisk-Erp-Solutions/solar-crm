import { Router, type Request } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { listQuerySchema, type AppRole, type Json, type TableName, type TableRow } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { assertCanRead, scopedWhere } from '../auth/access';
import { allow } from '../auth/authorize';
import type { OrderBy, Primitive, Where } from '../db/types';
import { audit } from '../lib/audit';
import { AppError, notFound } from './errors';
import { body, handle, param, parse, respondPage, wrap } from './handler';

/* ───────────── list query parsing shared by every list endpoint ───────────── */

export interface ListSpec {
  table: TableName;
  /** columns searched by ?q= (case-insensitive substring) */
  searchCols?: string[];
  /** columns filterable via ?col=a,b (in), ?col__gte=, ?col__lte=, ?col__gt=, ?col__lt=, ?col__null=true|false */
  filterCols?: string[];
  /** columns allowed in ?sort= (defaults to filterCols + created_at) */
  sortCols?: string[];
  defaultSort?: OrderBy;
  /** always-applied filters (e.g. exclude soft-deleted) */
  baseWhere?: Where;
  /** skip row-level scoping (only for tables that are org-wide reference data) */
  unscoped?: boolean;
}

const coerce = (v: string): Primitive => (v === 'true' ? true : v === 'false' ? false : v);

export function whereFromQuery(query: Request['query'], filterCols: string[]): Where {
  const where: Where = {};
  for (const col of filterCols) {
    const raw = query[col];
    if (typeof raw === 'string' && raw !== '') {
      const parts = raw.split(',').map((s) => s.trim()).filter(Boolean).map(coerce);
      where[col] = parts.length > 1 ? parts : parts[0] ?? undefined;
    }
    for (const [suffix, op] of [['gte', 'gte'], ['lte', 'lte'], ['gt', 'gt'], ['lt', 'lt']] as const) {
      const v = query[`${col}__${suffix}`];
      if (typeof v === 'string' && v !== '') {
        const cur = where[col];
        where[col] = { ...(cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}), [op]: /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v };
      }
    }
    const isNull = query[`${col}__null`];
    if (isNull === 'true') where[col] = null;
    if (isNull === 'false') where[col] = { is_null: false };
  }
  return where;
}

export async function runList<T = never>(ctx: AppContext, req: Request, spec: ListSpec): Promise<{ rows: T[]; total: number; limit: number; offset: number }> {
  const q = parse(listQuerySchema, req.query);
  const filters = whereFromQuery(req.query, spec.filterCols ?? []);
  let where: Where = { ...(spec.baseWhere ?? {}), ...filters };
  if (!spec.unscoped) where = await scopedWhere(ctx, spec.table, where);
  const allowedSort = new Set([...(spec.sortCols ?? spec.filterCols ?? []), 'created_at', 'updated_at', spec.defaultSort?.col ?? 'created_at']);
  const orderBy: OrderBy = q.sort && allowedSort.has(q.sort) ? { col: q.sort, dir: q.order } : spec.defaultSort ?? { col: 'created_at', dir: 'desc' };
  const { rows, total } = await (ctx.db.table(spec.table) as unknown as { list(o: unknown): Promise<{ rows: T[]; total: number }> }).list({
    where, orderBy, limit: q.limit, offset: q.offset, search: q.q && spec.searchCols?.length ? { cols: spec.searchCols, text: q.q } : undefined,
  });
  return { rows, total, limit: q.limit, offset: q.offset };
}

/* ───────────── generic CRUD router for simple resources ───────────── */

export interface CrudOptions<K extends TableName> {
  table: K;
  /** e.g. '/customers' — mounted on the API root */
  path: string;
  readRoles?: AppRole[];
  writeRoles: AppRole[];
  list: Omit<ListSpec, 'table'>;
  createSchema: ZodTypeAny;
  updateSchema?: ZodTypeAny;
  /** derive/default fields before insert */
  prepareCreate?: (ctx: AppContext, input: z.output<ZodTypeAny>) => Promise<Partial<TableRow<K>>> | Partial<TableRow<K>>;
  prepareUpdate?: (ctx: AppContext, input: z.output<ZodTypeAny>, current: TableRow<K>) => Promise<Partial<TableRow<K>>> | Partial<TableRow<K>>;
  afterCreate?: (ctx: AppContext, row: TableRow<K>) => Promise<void>;
  afterUpdate?: (ctx: AppContext, row: TableRow<K>, before: TableRow<K>) => Promise<void>;
  /** add computed/joined fields to rows returned by list and get */
  hydrate?: (ctx: AppContext, rows: TableRow<K>[]) => Promise<TableRow<K>[]>;
  /** entity name used in audit action names, e.g. 'customer' → customer.create */
  entity: string;
  allowDelete?: boolean;
  /** whether rows are org-wide reference data (no party scoping) */
  unscoped?: boolean;
}

export function crudRouter<K extends TableName>(opts: CrudOptions<K>): Router {
  const r = Router();
  const read = opts.readRoles ? [allow(...opts.readRoles)] : [];
  const write = [allow(...opts.writeRoles)];
  const repo = (ctx: AppContext) => ctx.db.table(opts.table);
  const spec: ListSpec = { ...opts.list, table: opts.table, unscoped: opts.unscoped };

  r.get(opts.path, ...read, wrap(async (req, res) => {
    const ctx = req.ctx!;
    const page = await runList<TableRow<K>>(ctx, req, spec);
    const rows = opts.hydrate ? await opts.hydrate(ctx, page.rows) : page.rows;
    respondPage(res, rows, page.total, page.limit, page.offset);
  }));

  r.get(`${opts.path}/:id`, ...read, handle(async (ctx, req) => {
    const row = await repo(ctx).get(param(req, 'id'));
    if (!row) throw notFound(opts.entity);
    if (!opts.unscoped) await assertCanRead(ctx, opts.table, row);
    return opts.hydrate ? (await opts.hydrate(ctx, [row]))[0] : row;
  }));

  r.post(opts.path, ...write, handle(async (ctx, req, res) => {
    const input = body(opts.createSchema, req);
    const extra = opts.prepareCreate ? await opts.prepareCreate(ctx, input) : {};
    const row = await repo(ctx).insert({ ...input, ...extra, created_by: ctx.user.id } as Partial<TableRow<K>>);
    await audit(ctx, { action: `${opts.entity}.create`, table: opts.table, record_id: row.id, new: row as unknown as Json });
    if (opts.afterCreate) await opts.afterCreate(ctx, row);
    res.status(201).json({ data: opts.hydrate ? (await opts.hydrate(ctx, [row]))[0] : row });
  }));

  r.patch(`${opts.path}/:id`, ...write, handle(async (ctx, req) => {
    const id = param(req, 'id');
    const before = await repo(ctx).get(id);
    if (!before) throw notFound(opts.entity);
    if (!opts.unscoped) await assertCanRead(ctx, opts.table, before);
    const input = body(opts.updateSchema ?? (opts.createSchema as unknown as { partial(): ZodTypeAny }).partial?.() ?? opts.createSchema, req);
    const extra = opts.prepareUpdate ? await opts.prepareUpdate(ctx, input, before) : {};
    const row = await repo(ctx).update(id, { ...input, ...extra } as Partial<TableRow<K>>);
    await audit(ctx, { action: `${opts.entity}.update`, table: opts.table, record_id: id, old: before as unknown as Json, new: row as unknown as Json });
    if (opts.afterUpdate) await opts.afterUpdate(ctx, row, before);
    return opts.hydrate ? (await opts.hydrate(ctx, [row]))[0] : row;
  }));

  if (opts.allowDelete) {
    r.delete(`${opts.path}/:id`, ...write, handle(async (ctx, req) => {
      const id = param(req, 'id');
      const before = await repo(ctx).get(id);
      if (!before) throw notFound(opts.entity);
      if (!opts.unscoped) await assertCanRead(ctx, opts.table, before);
      await repo(ctx).delete(id);
      await audit(ctx, { action: `${opts.entity}.delete`, table: opts.table, record_id: id, old: before as unknown as Json });
      return { id };
    }));
  }
  return r;
}

export { AppError };
