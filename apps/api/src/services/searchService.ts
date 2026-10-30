import { canSeeMobile, scopeWhere } from '../auth/access';
import {
  entityPath, formatINR, maskEmail, maskMobile, normalizeMobile, titleCase, type SearchGroup, type SearchGroupKey, type SearchHit, type SearchResponse, type TableName,
} from '@solar/shared';
import type { AppContext } from '../auth/context';
import type { ListOpts, Where } from '../db/types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface GroupSpec {
  key: SearchGroupKey; label: string; table: TableName; cols: string[];
  /** reference data that is not party-scoped but safe for every signed-in user (names only) */
  open?: boolean;
  where?: Where;
  hit(row: Record<string, unknown>): SearchHit;
}
const s = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);

const GROUPS: GroupSpec[] = [
  { key: 'opportunities', label: 'Opportunities', table: 'opportunities', cols: ['name'], hit: (r) => ({ type: 'opportunity', id: s(r['id']), title: s(r['name']), subtitle: `${titleCase(s(r['segment']))} · ${n(r['kw'])} kW`, path: entityPath('opportunity', s(r['id'])), badge: titleCase(s(r['stage'])), masked: false }) },
  { key: 'quotes', label: 'Quotations', table: 'quotations', cols: ['quote_no'], hit: (r) => ({ type: 'quotation', id: s(r['id']), title: `${s(r['quote_no'])} (v${n(r['version'])})`, subtitle: `${formatINR(n(r['total']))} · ${n(r['kw'])} kW`, path: entityPath('quotation', s(r['id'])), badge: titleCase(s(r['status'])), masked: false }) },
  { key: 'customers', label: 'Customers', table: 'customers', cols: ['legal_name', 'display_name', 'gstin'], hit: (r) => ({ type: 'customer', id: s(r['id']), title: s(r['display_name']) || s(r['legal_name']), subtitle: [s(r['legal_name']) !== s(r['display_name']) ? s(r['legal_name']) : '', s(r['gstin'])].filter(Boolean).join(' · ') || null, path: `/customers/${s(r['id'])}`, badge: r['customer_type'] ? titleCase(s(r['customer_type'])) : null, masked: false }) },
  { key: 'dealers', label: 'Dealers', table: 'dealers', cols: ['legal_name', 'trade_name', 'gstin'], hit: (r) => ({ type: 'dealer', id: s(r['id']), title: s(r['legal_name']), subtitle: [s(r['city']), s(r['district'])].filter(Boolean).join(', ') || null, path: entityPath('dealer', s(r['id'])), badge: s(r['portal_status']) === 'active' ? null : titleCase(s(r['portal_status'])), masked: false }) },
  { key: 'distributors', label: 'Distributors', table: 'distributors', cols: ['legal_name', 'trade_name', 'gstin'], hit: (r) => ({ type: 'distributor', id: s(r['id']), title: s(r['legal_name']), subtitle: s(r['city']) || null, path: entityPath('distributor', s(r['id'])), badge: titleCase(s(r['status'])), masked: false }) },
  { key: 'skus', label: 'SKUs', table: 'skus', cols: ['make', 'model', 'variant', 'description'], open: true, where: { active: true }, hit: (r) => ({ type: 'sku', id: s(r['id']), title: [s(r['make']), s(r['model']), s(r['variant'])].filter(Boolean).join(' '), subtitle: `${titleCase(s(r['category']))}${r['wattage'] ? ` · ${n(r['wattage'])} Wp` : ''}`, path: entityPath('sku', s(r['id'])), badge: null, masked: false }) },
  { key: 'sales_orders', label: 'Sales orders', table: 'sales_orders', cols: ['so_no', 'customer_po_no'], hit: (r) => ({ type: 'sales_order', id: s(r['id']), title: s(r['so_no']), subtitle: `${formatINR(n(r['total']))}${r['customer_po_no'] ? ` · PO ${s(r['customer_po_no'])}` : ''}`, path: entityPath('sales_order', s(r['id'])), badge: titleCase(s(r['status'])), masked: false }) },
  { key: 'invoices', label: 'Proforma invoices', table: 'proforma_invoices', cols: ['pi_no', 'legal_name'], hit: (r) => ({ type: 'proforma_invoice', id: s(r['id']), title: s(r['pi_no']), subtitle: `${formatINR(n(r['total']))}${r['legal_name'] ? ` · ${s(r['legal_name'])}` : ''}`, path: entityPath('proforma_invoice', s(r['id'])), badge: titleCase(s(r['status'])), masked: false }) },
];

/** Escape-free text for the case-insensitive substring search used by the data layer. */
const normaliseText = (q: string): string => q.replace(/\s+/g, ' ').trim();

/**
 * Global search. Every group is scoped through `scopeWhere` (external users see only their own party), at most `limit` (≤ 5) hits per group.
 * Lead personal data is masked for roles without a need to see it, and those roles can only find a lead by mobile / e-mail with the COMPLETE number / address
 * (so partial-digit probing can't be used to reconstruct a masked number).
 */
export async function globalSearch(ctx: AppContext, rawQuery: string, limit = 5): Promise<SearchResponse> {
  const q = normaliseText(rawQuery);
  const cap = Math.min(5, Math.max(1, limit));
  const groups: SearchGroup[] = [];

  /* ── leads ── */
  const leadScope = await scopeWhere(ctx, 'leads');
  if (leadScope !== null) {
    const privileged = canSeeMobile(ctx.user.role);
    const digits = q.replace(/[\s\-+()]/g, '');
    const asMobile = /^\d{4,}$/.test(digits) ? digits : null;
    const full = normalizeMobile(q);
    const search: NonNullable<ListOpts['search']> = privileged
      ? { cols: ['name', 'mobile', 'email'], text: asMobile ?? q }
      : { cols: ['name'], text: q };
    const where: Where = { ...leadScope, deleted_at: null };
    let { rows, total } = await ctx.db.table('leads').list({ where, search, limit: cap, orderBy: { col: 'created_at', dir: 'desc' } });
    if (!privileged) {
      // exact mobile / e-mail only
      const exact: Where | null = full ? { mobile: [full, `+91${full}`] } : EMAIL_RE.test(q) ? { email: q.toLowerCase() } : null;
      if (exact) {
        const byExact = await ctx.db.table('leads').list({ where: { ...where, ...exact }, limit: cap });
        const seen = new Set(rows.map((r) => r.id));
        for (const r of byExact.rows) if (!seen.has(r.id)) { rows = [...rows, r]; total++; }
        rows = rows.slice(0, cap);
      }
    }
    if (rows.length) {
      groups.push({
        key: 'leads', label: 'Leads', total,
        hits: rows.map((l) => {
          const masked = !privileged;
          const mobile = masked ? maskMobile(l.mobile) : l.mobile;
          const email = l.email ? (masked ? maskEmail(l.email) : l.email) : null;
          return { type: 'lead', id: l.id, title: l.name, subtitle: [mobile, email, l.city].filter(Boolean).join(' · '), path: entityPath('lead', l.id), badge: titleCase(l.status), masked };
        }),
      });
    }
  }

  /* ── the other groups ── */
  const order: SearchGroupKey[] = ['opportunities', 'quotes', 'customers', 'dealers', 'distributors', 'skus', 'sales_orders', 'invoices'];
  for (const key of order) {
    const g = GROUPS.find((x) => x.key === key)!;
    let scope: Where | null;
    if (g.open) scope = {};
    else scope = await scopeWhere(ctx, g.table);
    if (scope === null) continue; // table not reachable for this role (e.g. customers for external users)
    const { rows, total } = await ctx.db.table(g.table).list({ where: { ...(g.where ?? {}), ...scope }, search: { cols: g.cols, text: q }, limit: cap, orderBy: { col: 'created_at', dir: 'desc' } });
    if (rows.length) groups.push({ key: g.key, label: g.label, total, hits: rows.map((r) => g.hit(r as unknown as Record<string, unknown>)) });
  }

  // keep the leads group first, then the declared order
  const rank = (k: SearchGroupKey): number => (k === 'leads' ? -1 : order.indexOf(k));
  groups.sort((a, b) => rank(a.key) - rank(b.key));
  return { q, total: groups.reduce((t, g) => t + g.hits.length, 0), groups };
}
