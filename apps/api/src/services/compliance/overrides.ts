/**
 * Compliance overrides.
 *
 * An override is a compliance-lane approval on the entity `compliance_override`:
 *   approvals.entity_type = 'compliance_override', entity_id = the quote / dispatch / sales-order id, lane = 'compliance',
 *   required_role = 'compliance_officer', meta = { kind: 'override', target: 'quotation'|'dispatch'|'sales_order', gates: Gate[], reason, line_signature? }
 * When the decision is `approved` the engine marks findings of those gates `overridden: true`; overridden hard stops stop blocking.
 *
 * Dispatch overrides opened by the dispatch module (meta without `kind` / `gates`, stamped with `round`) are blanket overrides: the latest
 * round, when fully approved, covers every gate on that dispatch / sales order.
 */
import { GATES, type Approval, type Gate, type Json } from '@solar/shared';
import type { AppContext } from '../../auth/context';
import type { OverrideGrant } from './types';

/** Stable fingerprint of the SKU set on a quote — an approved override stops applying when the SKUs change. */
export const lineSignature = (skuIds: (string | null)[]): string => [...new Set(skuIds.filter((s): s is string => !!s))].sort().join(',');

export interface OverrideMeta { kind: 'override'; target: 'quotation' | 'dispatch' | 'sales_order'; gates: Gate[]; reason: string; line_signature?: string | null }

export function readOverrideMeta(meta: Json): OverrideMeta | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const m = meta as { [k: string]: Json };
  if (m['kind'] !== 'override') return null;
  const gates = Array.isArray(m['gates']) ? m['gates'].filter((g): g is Gate => typeof g === 'string' && (GATES as readonly string[]).includes(g)) : [];
  const target = m['target'];
  if (!gates.length || (target !== 'quotation' && target !== 'dispatch' && target !== 'sales_order')) return null;
  return { kind: 'override', target, gates, reason: typeof m['reason'] === 'string' ? m['reason'] : '', line_signature: typeof m['line_signature'] === 'string' ? m['line_signature'] : null };
}

export const isOverrideApproval = (a: Approval): boolean => a.entity_type === 'compliance_override';
const roundOf = (a: Approval): number => Number((a.meta as { round?: number } | null)?.round ?? 1);

/** Approved overrides for any of the given entity ids (quote id, or dispatch + sales-order ids). */
export async function loadGrants(ctx: AppContext, entityIds: string[]): Promise<OverrideGrant[]> {
  if (!entityIds.length) return [];
  const rows = await ctx.db.table('approvals').all({ entity_type: 'compliance_override', entity_id: entityIds }, { orderBy: { col: 'decided_at', dir: 'asc' } });
  const out: OverrideGrant[] = [];
  const legacy: Approval[] = [];
  for (const a of rows) {
    const m = readOverrideMeta(a.meta);
    if (!m) { legacy.push(a); continue; }
    if (a.decision === 'approved') out.push({ approvalId: a.id, gates: m.gates, reason: m.reason, decidedBy: a.approver_id, decidedAt: a.decided_at, lineSignature: m.line_signature ?? null });
  }
  // blanket dispatch overrides: the latest round counts and must be fully approved
  if (legacy.length) {
    const max = legacy.reduce((mx, a) => Math.max(mx, roundOf(a)), 0);
    const live = legacy.filter((a) => roundOf(a) === max && a.decision !== 'skipped');
    if (live.length && live.every((a) => a.decision === 'approved')) {
      const last = live[live.length - 1]!;
      const reason = typeof (last.meta as { reason?: unknown } | null)?.reason === 'string' ? ((last.meta as { reason: string }).reason) : last.comment ?? '';
      out.push({ approvalId: last.id, gates: [...GATES], reason, decidedBy: last.approver_id, decidedAt: last.decided_at, lineSignature: null });
    }
  }
  return out;
}
