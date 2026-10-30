import { randomUUID } from 'node:crypto';
import { AUDITED_TABLES, IMMUTABLE_TABLES, TABLE_NAMES, type TableName, type TableRow } from '@solar/shared';
import type { SeedData } from '@solar/shared/seed';
import { AppError } from '../http/errors';
import type { Db, ListOpts, ListResult, OpObject, OrderBy, Primitive, Repo, Where } from './types';

type AnyRow = Record<string, unknown> & { id: string };

const WITHDRAWAL_FIELDS = new Set(['withdrawn_at', 'withdrawn_by', 'withdrawal_channel', 'optout_suppress_until', 'updated_at']);
const REDACTABLE_MESSAGE_FIELDS = new Set(['body_preview', 'to_masked']);
const NO_UPDATED_AT = new Set<string>(IMMUTABLE_TABLES);
const clone = <T>(v: T): T => structuredClone(v);
const isNil = (v: unknown): boolean => v === null || v === undefined;

function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (isNil(a)) return 1; // nulls last (Postgres ASC default)
  if (isNil(b)) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a) < String(b) ? -1 : 1;
}

function like(value: unknown, pattern: string, ci: boolean): boolean {
  if (isNil(value)) return false;
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${esc}$`, ci ? 'is' : 's').test(String(value));
}

function matchOp(v: unknown, op: OpObject): boolean {
  if (op.eq !== undefined && !(op.eq === null ? isNil(v) : v === op.eq)) return false;
  if (op.neq !== undefined && (op.neq === null ? isNil(v) : v === op.neq)) return false;
  if (op.gt !== undefined && !(!isNil(v) && cmp(v, op.gt) > 0)) return false;
  if (op.gte !== undefined && !(!isNil(v) && cmp(v, op.gte) >= 0)) return false;
  if (op.lt !== undefined && !(!isNil(v) && cmp(v, op.lt) < 0)) return false;
  if (op.lte !== undefined && !(!isNil(v) && cmp(v, op.lte) <= 0)) return false;
  if (op.in !== undefined && !op.in.includes(v as Primitive)) return false;
  if (op.nin !== undefined && op.nin.includes(v as Primitive)) return false;
  if (op.like !== undefined && !like(v, op.like, false)) return false;
  if (op.ilike !== undefined && !like(v, op.ilike, true)) return false;
  if (op.contains !== undefined && !(Array.isArray(v) && op.contains.every((x) => v.includes(x)))) return false;
  if (op.overlaps !== undefined && !(Array.isArray(v) && op.overlaps.some((x) => v.includes(x)))) return false;
  if (op.is_null !== undefined && op.is_null !== isNil(v)) return false;
  return true;
}

export function matchesWhere(row: Record<string, unknown>, where?: Where): boolean {
  if (!where) return true;
  for (const [col, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    const v = row[col];
    if (cond === null) { if (!isNil(v)) return false; continue; }
    if (Array.isArray(cond)) { if (!cond.includes(v as Primitive)) return false; continue; }
    if (typeof cond === 'object') { if (!matchOp(v, cond)) return false; continue; }
    if (v !== cond) return false;
  }
  return true;
}

function searchMatch(row: AnyRow, search?: ListOpts['search']): boolean {
  if (!search || !search.text.trim()) return true;
  const needle = search.text.trim().toLowerCase();
  return search.cols.some((c) => {
    const v = row[c];
    if (isNil(v)) return false;
    return (typeof v === 'object' ? JSON.stringify(v) : String(v)).toLowerCase().includes(needle);
  });
}

export interface MemoryDbOptions { now?: () => Date; audit?: boolean }

/**
 * In-memory implementation of {@link Db}. Used for demo mode (no Supabase yet) and every automated test.
 * It also emulates the SQL triggers that matter to the application: updated_at, audit_log (source 'trigger'),
 * lead_events on lead status change, and immutability of ledger tables.
 */
export class MemoryDb implements Db {
  private tables = new Map<TableName, Map<string, AnyRow>>();
  private readonly now: () => Date;
  private readonly auditOn: boolean;

  constructor(seed?: SeedData, opts: MemoryDbOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.auditOn = opts.audit ?? true;
    for (const t of TABLE_NAMES) this.tables.set(t, new Map());
    if (seed) this.load(seed);
  }

  load(seed: SeedData): void {
    for (const t of TABLE_NAMES) {
      const rows = (seed as Record<string, AnyRow[] | undefined>)[t];
      if (!rows) continue;
      const m = this.tables.get(t)!;
      for (const r of rows) m.set(r.id, clone(r));
    }
  }

  reset(seed: SeedData): void {
    for (const m of this.tables.values()) m.clear();
    this.load(seed);
  }

  table<K extends TableName>(name: K): Repo<TableRow<K>> {
    return new MemoryRepo(this, name) as unknown as Repo<TableRow<K>>;
  }

  /** @internal */ store(name: TableName): Map<string, AnyRow> { return this.tables.get(name)!; }
  /** @internal */ clock(): string { return this.now().toISOString(); }

  /** @internal trigger emulation: audit rows */
  writeAudit(table: TableName, action: 'INSERT' | 'UPDATE' | 'DELETE', before: AnyRow | null, after: AnyRow | null): void {
    if (!this.auditOn || !AUDITED_TABLES.includes(table)) return;
    const row = (after ?? before)!;
    const id = randomUUID();
    this.store('audit_log').set(id, {
      id, org_id: (row['org_id'] as string) ?? '', created_at: this.clock(), actor_id: null, action: `${table}.${action.toLowerCase()}`,
      table_name: table, record_id: row.id, old_data: before ? clone(before) : null, new_data: after ? clone(after) : null, detail: null, source: 'trigger', request_id: null, ip: null,
    });
  }

  /** @internal trigger emulation: lead_events on lead status change */
  writeLeadStatusEvent(before: AnyRow, after: AnyRow): void {
    if (before['status'] === after['status']) return;
    const id = randomUUID();
    this.store('lead_events').set(id, {
      id, org_id: after['org_id'], created_at: this.clock(), lead_id: after.id, event_type: 'status_changed',
      summary: `Status changed from ${String(before['status'])} to ${String(after['status'])}`, actor_id: null, detail: { from: before['status'], to: after['status'] },
    });
  }
}

class MemoryRepo implements Repo<AnyRow> {
  constructor(private db: MemoryDb, private name: TableName) {}
  private get rows(): Map<string, AnyRow> { return this.db.store(this.name); }

  private filtered(where?: Where, search?: ListOpts['search']): AnyRow[] {
    const out: AnyRow[] = [];
    for (const r of this.rows.values()) if (matchesWhere(r, where) && searchMatch(r, search)) out.push(r);
    return out;
  }
  private sorted(rows: AnyRow[], orderBy?: OrderBy | OrderBy[]): AnyRow[] {
    const specs = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
    if (!specs.length) return rows;
    return [...rows].sort((a, b) => {
      for (const s of specs) {
        const c = s.dir === 'desc' ? -cmp(a[s.col], b[s.col]) : cmp(a[s.col], b[s.col]); // DESC puts NULLs first, like Postgres
        if (c !== 0) return c;
      }
      return 0;
    });
  }

  async list(opts: ListOpts = {}): Promise<ListResult<AnyRow>> {
    const all = this.sorted(this.filtered(opts.where, opts.search), opts.orderBy);
    const off = opts.offset ?? 0;
    const slice = opts.limit === undefined ? all.slice(off) : all.slice(off, off + opts.limit);
    return { rows: clone(slice), total: all.length };
  }
  async all(where?: Where, opts: Omit<ListOpts, 'where' | 'limit' | 'offset'> = {}): Promise<AnyRow[]> {
    return clone(this.sorted(this.filtered(where, opts.search), opts.orderBy));
  }
  async get(id: string): Promise<AnyRow | null> { const r = this.rows.get(id); return r ? clone(r) : null; }
  async getOrThrow(id: string): Promise<AnyRow> {
    const r = await this.get(id);
    if (!r) throw new AppError(404, 'NOT_FOUND', `${this.name} not found`);
    return r;
  }
  async one(where: Where): Promise<AnyRow | null> { const r = this.filtered(where)[0]; return r ? clone(r) : null; }
  async count(where?: Where): Promise<number> { return this.filtered(where).length; }

  async insert(row: Partial<AnyRow>): Promise<AnyRow> {
    const now = this.db.clock();
    const full = { ...clone(row), id: (row.id as string) ?? randomUUID() } as AnyRow;
    if (full['created_at'] === undefined) full['created_at'] = now;
    if (!NO_UPDATED_AT.has(this.name) && full['updated_at'] === undefined) full['updated_at'] = now;
    if (this.rows.has(full.id)) throw new AppError(409, 'CONFLICT', `${this.name}: duplicate id`);
    this.rows.set(full.id, full);
    this.db.writeAudit(this.name, 'INSERT', null, full);
    return clone(full);
  }
  async insertMany(rows: Partial<AnyRow>[]): Promise<AnyRow[]> {
    const out: AnyRow[] = [];
    for (const r of rows) out.push(await this.insert(r));
    return out;
  }

  async update(id: string, patch: Partial<AnyRow>): Promise<AnyRow> {
    const cur = this.rows.get(id);
    if (!cur) throw new AppError(404, 'NOT_FOUND', `${this.name} not found`);
    this.guardUpdate(patch);
    const before = clone(cur);
    const next: AnyRow = { ...cur };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined && k !== 'id') next[k] = clone(v);
    if (!NO_UPDATED_AT.has(this.name)) next['updated_at'] = this.db.clock();
    this.rows.set(id, next);
    this.db.writeAudit(this.name, 'UPDATE', before, next);
    if (this.name === 'leads') this.db.writeLeadStatusEvent(before, next);
    return clone(next);
  }
  async updateWhere(where: Where, patch: Partial<AnyRow>): Promise<AnyRow[]> {
    const out: AnyRow[] = [];
    for (const r of this.filtered(where)) out.push(await this.update(r.id, patch));
    return out;
  }
  async delete(id: string): Promise<void> {
    if (IMMUTABLE_TABLES.includes(this.name)) throw new AppError(403, 'FORBIDDEN', `${this.name} is append-only`);
    const cur = this.rows.get(id);
    if (!cur) return;
    this.rows.delete(id);
    this.db.writeAudit(this.name, 'DELETE', cur, null);
  }

  private guardUpdate(patch: Partial<AnyRow>): void {
    if (this.name === 'message_log') {
      // append-only, except personal text may be CLEARED (erasure / retention) — mirrors app.message_log_redaction_only() in SQL
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (!REDACTABLE_MESSAGE_FIELDS.has(k) || v !== null) throw new AppError(403, 'FORBIDDEN', 'message_log is append-only — only body_preview and to_masked may be cleared');
      }
      return;
    }
    if (IMMUTABLE_TABLES.includes(this.name)) throw new AppError(403, 'FORBIDDEN', `${this.name} is append-only`);
    if (this.name === 'lead_consents') {
      for (const k of Object.keys(patch)) {
        if (patch[k] !== undefined && !WITHDRAWAL_FIELDS.has(k)) throw new AppError(403, 'FORBIDDEN', 'Consent ledger rows are immutable — only withdrawal fields may be set');
      }
    }
  }
}
