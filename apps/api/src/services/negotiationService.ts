/** Rate negotiation log (step 18): what we quoted per kW, what the customer countered, and notes — newest first. */
import type { Json, Lead, NegotiationCreateInput, NegotiationLog } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { audit } from '../lib/audit';
import { invalidState } from '../http/errors';
import { actorId, assertLeadEditable, logLeadEvent } from './siteAccess';

const NEGOTIABLE = ['accepted', 'contacted', 'qualified', 'site_visit', 'nurture', 'opportunity'];

export interface NegotiationSummary {
  rounds: number;
  latest_quoted_rate_per_kw: number | null;
  latest_counter_per_kw: number | null;
  /** quoted − counter, in rupees per kW (positive = the customer wants a lower rate) */
  gap_per_kw: number | null;
  gap_pct: number | null;
  /** gap × capacity, when the capacity is known */
  gap_total_inr: number | null;
  kw: number | null;
}

export function summarise(rows: NegotiationLog[], kw: number | null): NegotiationSummary {
  const quoted = rows.find((r) => r.quoted_rate_per_kw !== null)?.quoted_rate_per_kw ?? null;
  const counter = rows.find((r) => r.customer_counter_per_kw !== null)?.customer_counter_per_kw ?? null;
  const gap = quoted !== null && counter !== null ? Math.round((quoted - counter) * 100) / 100 : null;
  return {
    rounds: rows.length, latest_quoted_rate_per_kw: quoted, latest_counter_per_kw: counter, gap_per_kw: gap,
    gap_pct: gap !== null && quoted ? Math.round((gap / quoted) * 1000) / 10 : null,
    gap_total_inr: gap !== null && kw ? Math.round(gap * kw) : null, kw,
  };
}

export async function listNegotiations(ctx: AppContext, lead: Lead): Promise<{ rows: NegotiationLog[]; summary: NegotiationSummary }> {
  const rows = await ctx.db.table('negotiation_logs').all({ lead_id: lead.id }, { orderBy: { col: 'logged_at', dir: 'desc' } });
  const opp = await ctx.db.table('opportunities').one({ lead_id: lead.id });
  return { rows, summary: summarise(rows, opp?.kw ?? lead.capacity_kw) };
}

export async function logNegotiation(ctx: AppContext, lead: Lead, input: NegotiationCreateInput): Promise<{ row: NegotiationLog; summary: NegotiationSummary }> {
  assertLeadEditable(lead);
  if (!NEGOTIABLE.includes(lead.status)) throw invalidState(`Rate negotiation is logged once the lead is accepted (current status: ${lead.status})`, { status: lead.status });
  const opp = await ctx.db.table('opportunities').one({ lead_id: lead.id });
  const now = ctx.now().toISOString();
  const row = await ctx.db.table('negotiation_logs').insert({
    lead_id: lead.id, opportunity_id: opp?.id ?? null, quoted_rate_per_kw: input.quoted_rate_per_kw ?? null, customer_counter_per_kw: input.customer_counter_per_kw ?? null,
    notes: input.notes ?? null, logged_by: actorId(ctx), logged_at: now, created_by: actorId(ctx),
  });
  const bits = [
    row.quoted_rate_per_kw !== null ? `quoted \u20b9 ${row.quoted_rate_per_kw}/kW` : null,
    row.customer_counter_per_kw !== null ? `customer countered \u20b9 ${row.customer_counter_per_kw}/kW` : null,
  ].filter(Boolean);
  await ctx.db.table('leads').update(lead.id, { last_action: 'Rate negotiation', last_action_at: now });
  await logLeadEvent(ctx, lead.id, 'negotiation_logged', `Rate negotiation logged${bits.length ? ` \u2014 ${bits.join(', ')}` : ''}`, { negotiation_id: row.id, quoted_rate_per_kw: row.quoted_rate_per_kw, customer_counter_per_kw: row.customer_counter_per_kw } as Json);
  await audit(ctx, { action: 'negotiation.log', table: 'negotiation_logs', record_id: row.id, new: row as unknown as Json });
  const { summary } = await listNegotiations(ctx, lead);
  return { row, summary };
}
