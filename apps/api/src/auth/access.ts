import { INTERNAL_ROLES, MOBILE_VISIBLE_ROLES, maskEmail, maskMobile, type AppRole, type TableName } from '@solar/shared';
import { matchesWhere } from '../db/memory';
import type { Where } from '../db/types';
import { forbidden } from '../http/errors';
import type { AppContext } from './context';

interface PartyCols { dist?: string; dealer?: string; terr?: string; self?: 'dealer' | 'distributor' }
const FULL: PartyCols = { dist: 'distributor_id', dealer: 'dealer_id', terr: 'territory_id' };
const PARTY: Partial<Record<TableName, PartyCols>> = {
  leads: FULL, opportunities: FULL, quotations: FULL, sales_orders: FULL,
  proforma_invoices: { dist: 'distributor_id', dealer: 'dealer_id' }, credit_checks: { dist: 'distributor_id', dealer: 'dealer_id' },
  loans: { dist: 'distributor_id', dealer: 'dealer_id' }, discom_applications: { dist: 'distributor_id', dealer: 'dealer_id' },
  subsidy_claims: { dist: 'distributor_id', dealer: 'dealer_id' }, installations: { dist: 'distributor_id', dealer: 'dealer_id' },
  dealer_receivables: { dist: 'distributor_id', dealer: 'dealer_id' }, warranty_tickets: { dealer: 'dealer_id' },
  dealers: { dist: 'distributor_id', self: 'dealer' }, distributors: { self: 'distributor' },
};
/** Tables whose rows an INTERNAL user restricted by profile.territory_ids may only see within those territories. */
const TERRITORY_SCOPED = new Set<TableName>(['leads', 'opportunities', 'quotations', 'sales_orders']);

export const isInternal = (role: AppRole): boolean => INTERNAL_ROLES.includes(role);

/**
 * Row-level visibility for the current user as a `Where` (merge into any list query).
 *  - `{}`  → no restriction
 *  - `null` → this user may not read this table at all
 * External users (distributor_user / dealer_user) only ever see their own party's rows.
 */
export async function scopeWhere(ctx: AppContext, table: TableName): Promise<Where | null> {
  const u = ctx.user;
  if (isInternal(u.role)) {
    if (TERRITORY_SCOPED.has(table) && u.territory_ids.length) return { territory_id: u.territory_ids };
    return {};
  }
  const spec = PARTY[table];
  if (!spec) return null;
  if (u.role === 'distributor_user') {
    if (!u.distributor_id) return null;
    if (spec.self === 'distributor') return { id: u.distributor_id };
    if (spec.dist) return { [spec.dist]: u.distributor_id };
    if (spec.dealer) {
      const dealers = await ctx.db.table('dealers').all({ distributor_id: u.distributor_id });
      return { [spec.dealer]: dealers.map((d) => d.id) };
    }
    return null;
  }
  // dealer_user
  if (!u.dealer_id) return null;
  if (spec.self === 'dealer') return { id: u.dealer_id };
  if (spec.self === 'distributor') return u.distributor_id ? { id: u.distributor_id } : null;
  if (spec.dealer) return { [spec.dealer]: u.dealer_id };
  return null;
}

/** Combine a caller's filters with the mandatory scope. The scope always wins; overlapping columns are intersected. */
export function mergeWhere(userWhere: Where | undefined, scope: Where): Where {
  const out: Where = { ...(userWhere ?? {}) };
  for (const [col, sv] of Object.entries(scope)) {
    const uv = out[col];
    if (uv === undefined) { out[col] = sv; continue; }
    const sArr = Array.isArray(sv) ? sv : [sv as string];
    const uArr = Array.isArray(uv) ? uv : [uv as string];
    out[col] = (sArr as unknown[]).filter((x) => (uArr as unknown[]).includes(x)) as string[];
  }
  return out;
}

export async function scopedWhere(ctx: AppContext, table: TableName, userWhere?: Where): Promise<Where> {
  const scope = await scopeWhere(ctx, table);
  if (scope === null) throw forbidden();
  return mergeWhere(userWhere, scope);
}

/** Throws 403 unless the current user may see this specific row. */
export async function assertCanRead(ctx: AppContext, table: TableName, row: object): Promise<void> {
  const scope = await scopeWhere(ctx, table);
  if (scope === null || !matchesWhere(row as Record<string, unknown>, scope)) throw forbidden();
}
export async function canRead(ctx: AppContext, table: TableName, row: object): Promise<boolean> {
  const scope = await scopeWhere(ctx, table);
  return scope !== null && matchesWhere(row as Record<string, unknown>, scope);
}

/* ───────────── privacy by default ───────────── */
export const canSeeMobile = (role: AppRole): boolean => MOBILE_VISIBLE_ROLES.includes(role);

/** Masks mobile/e-mail in list payloads for roles without a need to see them. Use `unmask` endpoints (audited) to reveal. */
export function maskPii<T extends { mobile?: string | null; email?: string | null }>(ctx: AppContext, row: T): T {
  if (canSeeMobile(ctx.user.role)) return row;
  return { ...row, mobile: row.mobile ? maskMobile(row.mobile) : row.mobile, email: row.email ? maskEmail(row.email) : row.email };
}
