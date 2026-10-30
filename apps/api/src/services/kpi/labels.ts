import type { TableName } from '@solar/shared';
import type { AppContext } from '../../auth/context';
import { chunk } from './stats';

interface LabelSpec { table: TableName; label: (row: Record<string, unknown>) => string }
const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v ? v : fallback);

const LABELS: Record<string, LabelSpec> = {
  lead: { table: 'leads', label: (r) => str(r['name'], 'Lead') },
  opportunity: { table: 'opportunities', label: (r) => str(r['name'], 'Opportunity') },
  quotation: { table: 'quotations', label: (r) => str(r['quote_no'], 'Quotation') },
  quote: { table: 'quotations', label: (r) => str(r['quote_no'], 'Quotation') },
  proforma_invoice: { table: 'proforma_invoices', label: (r) => str(r['pi_no'], 'Proforma invoice') },
  pi: { table: 'proforma_invoices', label: (r) => str(r['pi_no'], 'Proforma invoice') },
  sales_order: { table: 'sales_orders', label: (r) => str(r['so_no'], 'Sales order') },
  dispatch: { table: 'dispatches', label: (r) => str(r['dispatch_no'], 'Dispatch') },
  discom_application: { table: 'discom_applications', label: (r) => str(r['application_no'], 'DISCOM application') },
  warranty_ticket: { table: 'warranty_tickets', label: (r) => str(r['ticket_no'], 'Warranty ticket') },
  dealer: { table: 'dealers', label: (r) => str(r['legal_name'], 'Dealer') },
  loan: { table: 'loans', label: (r) => `${str(r['bank'], 'Bank')} loan` },
};

/**
 * Human labels ("QT-2026-0012", lead name …) for entities already known to be visible to the user.
 * Fetches each entity type once per call, in chunks, keyed `${entity_type}:${id}`.
 */
export async function entityLabels(ctx: AppContext, items: { type: string; id: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const byType = new Map<string, Set<string>>();
  for (const it of items) {
    if (!LABELS[it.type]) continue;
    const s = byType.get(it.type) ?? new Set<string>();
    s.add(it.id);
    byType.set(it.type, s);
  }
  for (const [type, ids] of byType) {
    const spec = LABELS[type]!;
    for (const part of chunk([...ids], 100)) {
      const rows = (await ctx.db.table(spec.table).all({ id: part })) as unknown as Record<string, unknown>[];
      for (const r of rows) out.set(`${type}:${String(r['id'])}`, spec.label(r));
    }
  }
  return out;
}
