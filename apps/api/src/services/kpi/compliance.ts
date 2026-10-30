import { daysBetween, entityPath, type BlockedGateRow, type ComplianceDashboard, type Finding, type OverrideRow, type Quotation, type QuotationLine, type RequoteRow, type SkuPrice } from '@solar/shared';
import { KpiBuilder, type Family, type KpiDetail } from './common';
import { inPeriod, type KpiScope } from './scope';
import { DAY, chunk, groupBy, ms, ratioPct, round, summarise, sum } from './stats';

/** Gates counted by the compliance-block rate (prompt Section 14: "quotes blocked by G2–G6"). */
export const BLOCK_GATES = ['G2', 'G3', 'G4', 'G5', 'G6'] as const;
const GATE_LABEL: Record<string, string> = {
  G2: 'G2 — DCR-verified modules (PMSG / KUSUM)', G3: 'G3 — ALMM List-I module model', G4: 'G4 — ALMM List-II cells', G5: 'G5 — List-II exemption date', G6: 'G6 — BIS licence',
};
const ISSUED_STATUSES = ['sent', 'negotiation', 'accepted', 'requote_required', 'expired', 'revised'];

const findingsOf = (q: Quotation): Finding[] => (Array.isArray(q.compliance_findings) ? q.compliance_findings : []);
/** Which of G2–G6 raised a hard stop on this quote (overridden hard stops still count: the quote was blocked). */
export const blockedGates = (q: Quotation): Set<string> => new Set(findingsOf(q).filter((f) => f.severity === 'hard_stop' && (BLOCK_GATES as readonly string[]).includes(f.gate)).map((f) => f.gate));
export const isRequoteFlagged = (q: Quotation): boolean => q.status === 'requote_required' || !!q.requote_reason;
export const isIssued = (q: Quotation): boolean => !!q.sent_at || ISSUED_STATUSES.includes(q.status) || isRequoteFlagged(q);

function priceOn(prices: SkuPrice[] | undefined, on: string): number | null {
  const p = (prices ?? []).filter((x) => x.valid_from <= on && (!x.valid_to || x.valid_to >= on)).sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0];
  return p ? p.base_price : null;
}

export async function computeCompliance(scope: KpiScope): Promise<Family<Pick<ComplianceDashboard, 'blocked_by_gate' | 'requotes' | 'open_overrides'>>> {
  const { ctx, filters: f } = scope;
  const kb = await KpiBuilder.create(ctx, 'compliance');

  /* ───────── compliance-block rate ───────── */
  const quotes = await scope.rows('quotations', { created_at: { gte: f.fromIso, lte: f.toIso } });
  const gateQuotes = new Map<string, number>(BLOCK_GATES.map((g) => [g, 0]));
  let blocked = 0;
  for (const q of quotes) {
    const gates = blockedGates(q);
    if (gates.size) blocked++;
    for (const g of gates) gateQuotes.set(g, (gateQuotes.get(g) ?? 0) + 1);
  }
  const blocked_by_gate: BlockedGateRow[] = BLOCK_GATES.map((g) => ({ gate: g, label: GATE_LABEL[g]!, quotes: gateQuotes.get(g) ?? 0 }));

  /* ───────── re-quote rate + price-change leakage ───────── */
  const issued = quotes.filter(isIssued);
  const flagged = quotes.filter(isRequoteFlagged);
  const internal = !scope.external;
  const lines: QuotationLine[] = [];
  const prices = new Map<string, SkuPrice[]>();
  if (internal && flagged.length) {
    for (const part of chunk(flagged.map((q) => q.id), 100)) lines.push(...(await ctx.db.table('quotation_lines').all({ quote_id: part })));
    for (const p of await scope.reference('sku_prices')) { const a = prices.get(p.sku_id) ?? []; a.push(p); prices.set(p.sku_id, a); }
  }
  const linesBy = groupBy(lines, (l) => l.quote_id);
  const requoteRows: RequoteRow[] = flagged.map((q) => {
    const ls = linesBy.get(q.id) ?? [];
    let repriced = 0, quoted = 0;
    for (const l of ls) {
      quoted += l.line_total;
      const cur = l.sku_id ? priceOn(prices.get(l.sku_id), f.today) : null;
      repriced += cur === null ? l.line_total : l.qty * cur * (1 - l.discount_pct / 100);
    }
    const diff = round(repriced - quoted, 2);
    return { quote_id: q.id, quote_no: q.quote_no, version: q.version, status: q.status, reason: q.requote_reason, total: q.total, repriced_difference: diff, leakage: Math.max(0, diff), owner_id: q.owner_id, path: entityPath('quotation', q.id) };
  }).sort((a, b) => b.leakage - a.leakage);
  const leakage = round(sum(requoteRows.map((r) => r.leakage)), 2);
  const bySegLeak = new Map<string, number>();
  for (const q of flagged) bySegLeak.set(q.segment, (bySegLeak.get(q.segment) ?? 0) + (requoteRows.find((r) => r.quote_id === q.id)?.leakage ?? 0));

  /* ───────── RMA turnaround + brand recovery ───────── */
  const tickets = await scope.rows('warranty_tickets');
  const rmaClosed = tickets.filter((t) => t.type === 'rma' && t.closed_at && inPeriod(t.closed_at, f));
  const turnarounds = rmaClosed.map((t) => Math.max(0, ((ms(t.closed_at) ?? 0) - (ms(t.opened_at) ?? 0)) / DAY));
  const rma = summarise(turnarounds);
  const byBearer = groupBy(rmaClosed, (t) => t.cost_bearer);
  const brandTickets = tickets.filter((t) => inPeriod(t.opened_at, f) && (!!t.brand_claim_no || t.cost_bearer === 'brand'));
  const recovered = brandTickets.filter((t) => t.recovered_amount > 0);
  const recoveredAmount = sum(brandTickets.map((t) => t.recovered_amount));

  /* ───────── open overrides (internal) ───────── */
  const open_overrides: OverrideRow[] = [];
  if (internal) {
    const approvals = await ctx.db.table('approvals').all({ entity_type: 'compliance_override', decision: 'pending' });
    for (const a of approvals) {
      const meta = (a.meta && typeof a.meta === 'object' && !Array.isArray(a.meta) ? a.meta : {}) as Record<string, unknown>;
      const quoteId = typeof meta['quote_id'] === 'string' ? meta['quote_id'] : null;
      const soId = typeof meta['sales_order_id'] === 'string' ? meta['sales_order_id'] : null;
      const reason = typeof meta['reason'] === 'string' ? meta['reason'] : null;
      open_overrides.push({
        id: a.id, kind: 'compliance_override', entity_type: a.entity_type, entity_id: a.entity_id, label: `Compliance override${reason ? ` — ${reason}` : ''}`, requested_at: a.requested_at,
        age_days: Math.max(0, daysBetween(a.requested_at, f.today)), path: quoteId ? entityPath('quotation', quoteId) : soId ? entityPath('sales_order', soId) : '/approvals',
      });
    }
    const credit = await ctx.db.table('credit_overrides').all({ status: 'pending' });
    const dealerNames = await scope.names('dealers', credit.map((c) => c.dealer_id));
    for (const c of credit) {
      open_overrides.push({
        id: c.id, kind: 'credit_override', entity_type: 'credit_override', entity_id: c.id, label: `Credit override — ${dealerNames.get(c.dealer_id) ?? 'dealer'}: ${c.reason}`, requested_at: c.created_at,
        age_days: Math.max(0, daysBetween(c.created_at, f.today)), path: '/approvals',
      });
    }
    open_overrides.sort((a, b) => b.age_days - a.age_days);
  }

  /* ───────── tiles ───────── */
  const kpis = [
    kb.make('compliance_block_rate_pct', {
      value: ratioPct(blocked, quotes.length),
      breakdown: blocked_by_gate.map((g) => ({ key: g.gate, label: g.label, value: ratioPct(g.quotes, quotes.length), quotes: g.quotes })),
      secondary: { label: 'Quotes blocked', value: blocked, unit: 'count' }, links: [{ label: 'Quotations', path: '/quotes' }],
      note: quotes.length === 0 ? 'No quotations drafted in the period' : undefined,
    }),
    kb.make('requote_rate_pct', {
      value: ratioPct(flagged.length, new Set([...issued, ...flagged].map((q) => q.id)).size),
      secondary: { label: 'Quotes flagged', value: flagged.length, unit: 'count' },
      breakdown: [...groupBy(flagged, (q) => q.segment)].map(([seg, qs]) => ({ key: seg, label: seg.replace(/_/g, ' '), value: qs.length })),
      links: [{ label: 'Quotes needing a re-quote', path: '/quotes?status=requote_required' }],
    }),
  ];
  if (internal) {
    kpis.push(kb.make('price_change_margin_leakage', {
      value: leakage, secondary: { label: 'Quotes flagged', value: flagged.length, unit: 'count' },
      breakdown: [...bySegLeak].filter(([, v]) => v > 0).map(([seg, v]) => ({ key: seg, label: seg.replace(/_/g, ' '), value: round(v, 2) })),
      links: [{ label: 'Quotes needing a re-quote', path: '/quotes?status=requote_required' }],
    }));
  }
  kpis.push(
    kb.make('rma_turnaround_days', {
      value: rma.median, secondary: { label: '90th percentile', value: rma.p90 },
      breakdown: [...byBearer].map(([k, ts]) => ({ key: k, label: `Cost borne by ${k}`, value: summarise(ts.map((t) => ((ms(t.closed_at) ?? 0) - (ms(t.opened_at) ?? 0)) / DAY)).median, n: ts.length })),
      note: rmaClosed.length === 0 ? 'No RMA tickets closed in the period' : undefined,
    }),
    kb.make('rma_brand_recovery', {
      value: round(recoveredAmount, 2), secondary: { label: 'Brand claims', value: brandTickets.length, unit: 'count' },
      breakdown: [...groupBy(brandTickets, (t) => t.status)].map(([k, ts]) => ({ key: k, label: k.replace(/_/g, ' '), value: round(sum(ts.map((t) => t.recovered_amount)), 2), tickets: ts.length })),
    }),
    kb.make('rma_brand_recovery_rate_pct', {
      value: ratioPct(recovered.length, brandTickets.length), secondary: { label: 'Recovered', value: recovered.length, unit: 'count' },
    }),
  );
  if (internal) {
    kpis.push(kb.make('open_overrides', {
      value: open_overrides.length,
      breakdown: [{ key: 'compliance_override', label: 'Compliance overrides', value: open_overrides.filter((o) => o.kind === 'compliance_override').length }, { key: 'credit_override', label: 'Credit overrides', value: open_overrides.filter((o) => o.kind === 'credit_override').length }],
      links: [{ label: 'Approvals inbox', path: '/approvals' }],
    }));
  }

  /* ───────── export details ───────── */
  const quoteCols: KpiDetail['columns'] = [{ key: 'quote', label: 'Quote', type: 'text' }, { key: 'version', label: 'Version', type: 'int' }, { key: 'segment', label: 'Segment', type: 'text' }, { key: 'status', label: 'Status', type: 'text' }, { key: 'created', label: 'Created', type: 'date' }, { key: 'total', label: 'Total (₹)', type: 'inr' }, { key: 'gates', label: 'Hard-stop gates (G2–G6)', type: 'text' }];
  const quoteRow = (q: Quotation) => ({ quote: q.quote_no, version: q.version, segment: q.segment, status: q.status, created: q.created_at, total: q.total, gates: [...blockedGates(q)].sort().join(', ') });
  const reqCols: KpiDetail['columns'] = [{ key: 'quote', label: 'Quote', type: 'text' }, { key: 'version', label: 'Version', type: 'int' }, { key: 'status', label: 'Status', type: 'text' }, { key: 'reason', label: 'Re-quote reason', type: 'text' }, { key: 'total', label: 'Total (₹)', type: 'inr' }, { key: 'diff', label: 'Price difference at today\'s list (₹)', type: 'inr' }, { key: 'leakage', label: 'Leakage (₹)', type: 'inr' }];
  const reqRows = requoteRows.map((r) => ({ quote: r.quote_no, version: r.version, status: r.status, reason: r.reason, total: r.total, diff: r.repriced_difference, leakage: r.leakage }));
  const ticketCols: KpiDetail['columns'] = [{ key: 'ticket', label: 'Ticket', type: 'text' }, { key: 'type', label: 'Type', type: 'text' }, { key: 'status', label: 'Status', type: 'text' }, { key: 'bearer', label: 'Cost bearer', type: 'text' }, { key: 'claim', label: 'Brand claim no.', type: 'text' }, { key: 'opened', label: 'Opened', type: 'date' }, { key: 'closed', label: 'Closed', type: 'date' }, { key: 'days', label: 'Turnaround (days)', type: 'days' }, { key: 'recovered', label: 'Recovered (₹)', type: 'inr' }];
  const ticketRow = (t: (typeof tickets)[number]) => ({ ticket: t.ticket_no, type: t.type, status: t.status, bearer: t.cost_bearer, claim: t.brand_claim_no, opened: t.opened_at, closed: t.closed_at, days: t.closed_at ? round(((ms(t.closed_at) ?? 0) - (ms(t.opened_at) ?? 0)) / DAY, 1) : null, recovered: t.recovered_amount });
  const details: Record<string, KpiDetail> = {
    compliance_block_rate_pct: { title: 'Quotations drafted in the period', columns: quoteCols, rows: quotes.map(quoteRow) },
    requote_rate_pct: { title: 'Quotations flagged for re-quote', columns: reqCols, rows: reqRows },
    price_change_margin_leakage: { title: 'Re-quote price-change leakage', columns: reqCols, rows: reqRows },
    rma_turnaround_days: { title: 'RMA tickets closed in the period', columns: ticketCols, rows: rmaClosed.map(ticketRow) },
    rma_brand_recovery: { title: 'Brand warranty claims', columns: ticketCols, rows: brandTickets.map(ticketRow) },
    rma_brand_recovery_rate_pct: { title: 'Brand warranty claims', columns: ticketCols, rows: brandTickets.map(ticketRow) },
    open_overrides: {
      title: 'Open overrides', columns: [{ key: 'kind', label: 'Kind', type: 'text' }, { key: 'label', label: 'Override', type: 'text' }, { key: 'requested', label: 'Requested', type: 'date' }, { key: 'age', label: 'Waiting (days)', type: 'days' }],
      rows: open_overrides.map((o) => ({ kind: o.kind, label: o.label, requested: o.requested_at, age: o.age_days })),
    },
  };
  return { kpis, details, extra: { blocked_by_gate, requotes: requoteRows.slice(0, 50), open_overrides } };
}
