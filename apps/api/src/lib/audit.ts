import type { Json, TableName } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { SYSTEM_USER_ID } from '../auth/context';

const PII_KEYS = /^(mobile|phone|email|password|token|billing_address|shipping_address|aadhaar.*)$/i;

/** Mask personal data before it lands in audit detail. Old/new snapshots from DB triggers keep full rows (restricted to admin/compliance). */
export function redactPii(value: Json | undefined): Json | undefined {
  if (value === undefined || value === null) return value;
  if (Array.isArray(value)) return value.map((v) => redactPii(v) as Json);
  if (typeof value === 'object') {
    const out: { [k: string]: Json } = {};
    for (const [k, v] of Object.entries(value)) out[k] = PII_KEYS.test(k) ? '[masked]' : (redactPii(v) as Json);
    return out;
  }
  return value;
}

export interface AuditEntry {
  /** e.g. "lead.accept", "rule.activate", "mobile.unmask" */
  action: string;
  table?: TableName;
  record_id?: string;
  old?: Json | null;
  new?: Json | null;
  detail?: Json;
}

/** Append a business-action row to the immutable audit_log (source = 'api'). Every mutation endpoint calls this. */
export async function audit(ctx: AppContext, e: AuditEntry): Promise<void> {
  await ctx.db.table('audit_log').insert({
    actor_id: ctx.user.id === SYSTEM_USER_ID ? null : ctx.user.id,
    action: e.action,
    table_name: e.table ?? null,
    record_id: e.record_id ?? null,
    old_data: (redactPii(e.old ?? null) ?? null) as Json | null,
    new_data: (redactPii(e.new ?? null) ?? null) as Json | null,
    detail: (redactPii(e.detail) ?? null) as Json | null,
    source: 'api',
    request_id: ctx.requestId,
    ip: ctx.ip,
  });
}
