/**
 * Approvals: the generic inbox and decision engine (every entity type), plus the quotation lanes and compliance overrides.
 *
 *  · Quote approval has up to three PARALLEL lanes — commercial (discount band → DSM → Regional Head → Management, sequential),
 *    compliance (compliance officer) and credit (accounts). Each step has its own `approval` SLA clock, started when the step becomes active.
 *  · `decideApproval` works for every entity type (quotation, proforma_invoice, sales_order, credit_override, compliance_override): it validates the
 *    approver, the turn and the comment, records the decision and calls the entity's registered handler (services/hooks.ts) with the outcome.
 *  · This module registers the handlers for `quotation` and `compliance_override`.
 */
import {
  ROLE_LABEL, entityPath, type AppRole, type Approval, type ApprovalEntity, type ApprovalLane, type ApprovalRule, type Clock, type Json, type Quotation,
} from '@solar/shared';
import type { AppContext } from '../auth/context';
import { conflict, forbidden, invalidState, notFound, AppError } from '../http/errors';
import { audit } from '../lib/audit';
import { DEFAULT_WORK_CALENDAR, addWorkingMinutes, type WorkCalendar } from '../lib/time';
import type { EvaluationResult } from './contracts';
import { readOverrideMeta, lineSignature } from './compliance/overrides';
import { computeDealerExposure, creditBlock } from './exposure';
import { getApprovalHandler, registerApprovalHandler, registerClockHandlers, type ApprovalOutcome } from './hooks';

const toJson = (v: unknown): Json => v as Json;
const roundOf = (a: Approval): number => Number((a.meta as { round?: number } | null)?.round ?? 1);

/* ───────────── working calendar ───────────── */
export async function workCalendar(ctx: AppContext): Promise<WorkCalendar> {
  const hours = await ctx.svc.rules.value<Partial<Pick<WorkCalendar, 'days' | 'start' | 'end'>>>('work_calendar.hours', undefined, null);
  const [days, start, end, holidays] = await Promise.all([
    ctx.svc.rules.value<number[]>('work_calendar.days', undefined, null), ctx.svc.rules.value<string>('work_calendar.start', undefined, null),
    ctx.svc.rules.value<string>('work_calendar.end', undefined, null), ctx.svc.rules.value<unknown[]>('work_calendar.holidays', undefined, null),
  ]);
  const hm = /^\d{1,2}:\d{2}$/;
  const pickDays = Array.isArray(hours?.days) ? hours.days : days;
  return {
    days: Array.isArray(pickDays) && pickDays.length ? pickDays : DEFAULT_WORK_CALENDAR.days,
    start: [hours?.start, start].find((s): s is string => typeof s === 'string' && hm.test(s)) ?? DEFAULT_WORK_CALENDAR.start,
    end: [hours?.end, end].find((s): s is string => typeof s === 'string' && hm.test(s)) ?? DEFAULT_WORK_CALENDAR.end,
    holidays: Array.isArray(holidays) ? holidays.map((h) => (typeof h === 'string' ? h : h && typeof h === 'object' && typeof (h as { date?: unknown }).date === 'string' ? (h as { date: string }).date : '')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : DEFAULT_WORK_CALENDAR.holidays,
  };
}

/* ───────────── who may decide ───────────── */
/** Commercial hierarchy: a higher authority may decide a lower step. Other roles must match exactly. */
const RANK: Partial<Record<AppRole, number>> = { dsm: 1, regional_head: 2, sales_manager: 2, management: 3 };

export function canDecideRole(user: AppRole, required: AppRole): boolean {
  if (user === 'admin' || user === required) return true;
  const u = RANK[user], r = RANK[required];
  return u !== undefined && r !== undefined && u > r;
}

/* ───────────── plan: which lanes does a quote need? ───────────── */
export interface LanePlan { lane: ApprovalLane; roles: AppRole[]; slaHours: number; reasons: string[]; ruleId: string | null }

const DEFAULT_BREACH_CHAIN: AppRole[] = ['dsm', 'regional_head', 'management'];
const isRoleArray = (v: Json | undefined): v is AppRole[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

async function laneSla(ctx: AppContext, lane: ApprovalLane, row: ApprovalRule | null): Promise<number> {
  if (row && row.sla_hours > 0) return row.sla_hours;
  const cfg = await ctx.svc.rules.value<Record<string, number>>('quote.approval_sla_hours', undefined, null);
  const v = cfg?.[lane];
  return typeof v === 'number' && v > 0 ? v : 24;
}

async function commercialPlan(ctx: AppContext, quote: Quotation): Promise<LanePlan | null> {
  const rows = await ctx.db.table('approval_rules').all({ lane: 'commercial', active: true }, { orderBy: { col: 'min_value' } });
  const reasons: string[] = [];
  let roles: AppRole[] = [];
  let row: ApprovalRule | null = null;
  let ruleId: string | null = null;
  const within = (v: number, min: number, max: number | null): boolean => v >= min && (max === null || v < max);
  if (rows.length) {
    row = rows.find((r) => within((r.conditions as { metric?: string } | null)?.metric === 'value' ? quote.total : quote.discount_pct, r.min_value, r.max_value)) ?? null;
    roles = row?.role_chain ?? [];
    ruleId = row?.id ?? null;
  } else {
    const bands = await ctx.svc.rules.value<{ min_pct: number; max_pct: number | null; role_chain: AppRole[] }[]>('quote.discount_bands', undefined, null);
    const band = Array.isArray(bands) ? bands.find((b) => within(quote.discount_pct, b.min_pct, b.max_pct)) : undefined;
    roles = band?.role_chain ?? (quote.discount_pct >= 8 ? DEFAULT_BREACH_CHAIN : quote.discount_pct >= 5 ? ['dsm', 'regional_head'] : quote.discount_pct >= 2 ? ['dsm'] : []);
  }
  if (roles.length) reasons.push(`Effective discount ${quote.discount_pct}% needs ${roles.map((r) => ROLE_LABEL[r]).join(' → ')} approval.`);

  const floor = quote.floor_check;
  if (floor && !floor.ok) {
    const forced = await ctx.svc.rules.value<AppRole[]>('price_floor.breach_role_chain', undefined, null);
    const chain = isRoleArray(forced as Json) && (forced as AppRole[]).length ? (forced as AppRole[]) : DEFAULT_BREACH_CHAIN;
    if (chain.length > roles.length) roles = chain;
    reasons.push(floor.lines.some((l) => l.below_floor) ? 'One or more lines are priced below the floor price.' : 'The margin is below the minimum margin.');
  }
  return roles.length ? { lane: 'commercial', roles, slaHours: await laneSla(ctx, 'commercial', row), reasons, ruleId } : null;
}

const allowed = (row: ApprovalRule | null, trigger: string): boolean => {
  const list = (row?.conditions as { triggers?: unknown } | null)?.triggers;
  return !Array.isArray(list) || list.includes(trigger);
};

async function compliancePlan(ctx: AppContext, quote: Quotation, evaluation: EvaluationResult): Promise<LanePlan | null> {
  const row = await ctx.db.table('approval_rules').one({ lane: 'compliance', active: true });
  const reasons: string[] = [];
  if (quote.exemption_reliance && allowed(row, 'exemption_reliance')) reasons.push('The job relies on the ALMM List-II exemption.');
  if (quote.parent_quote_id && allowed(row, 'sku_substitution')) {
    const [mine, parent] = await Promise.all([ctx.db.table('quotation_lines').all({ quote_id: quote.id }), ctx.db.table('quotation_lines').all({ quote_id: quote.parent_quote_id })]);
    if (lineSignature(mine.map((l) => l.sku_id)) !== lineSignature(parent.map((l) => l.sku_id))) reasons.push('SKUs were substituted compared with the previous version of this quote.');
  }
  if (allowed(row, 'unverified_rule_dependency')) {
    const dependent = evaluation.findings.filter((f) => f.severity !== 'info' && !f.overridden && (f.advisory || (f.ruleStatus && f.ruleStatus !== 'verified')));
    if (dependent.length) reasons.push(`${dependent.length} finding(s) depend on a rule that is not verified (${[...new Set(dependent.map((f) => f.gate))].join(', ')}).`);
  }
  if (!reasons.length) return null;
  return { lane: 'compliance', roles: row?.role_chain.length ? row.role_chain : ['compliance_officer'], slaHours: await laneSla(ctx, 'compliance', row), reasons, ruleId: row?.id ?? null };
}

async function creditPlan(ctx: AppContext, quote: Quotation): Promise<LanePlan | null> {
  if (!quote.dealer_id || !(await ctx.db.table('dealers').get(quote.dealer_id))) return null;
  const row = await ctx.db.table('approval_rules').one({ lane: 'credit', active: true });
  if (row && quote.total < row.min_value) return null;
  const exposure = await computeDealerExposure(ctx, quote.dealer_id, ctx.now());
  const reasons: string[] = [];
  const block = creditBlock(exposure, quote.total);
  if (block.some((r) => /exceed/i.test(r)) && allowed(row, 'over_credit_limit')) reasons.push(block.find((r) => /exceed/i.test(r))!);
  if (exposure.portal_status === 'deactivated' && allowed(row, 'portal_deactivated')) reasons.push('The dealer is deactivated on the PM Surya Ghar portal.');
  if (exposure.portal_status === 'under_sop' && allowed(row, 'under_sop')) reasons.push('The dealer is under an MNRE SOP review.');
  const days = (await ctx.svc.rules.value<number>('quote.credit_overdue_days', undefined, 60)) ?? 60;
  const overdue = days >= 90 ? exposure.ageing.d90_plus : days >= 60 ? exposure.ageing.d61_90 + exposure.ageing.d90_plus : days >= 30 ? exposure.ageing.d31_60 + exposure.ageing.d61_90 + exposure.ageing.d90_plus : exposure.overdue_amount;
  if (overdue > 0 && allowed(row, 'ageing_over_60_days')) reasons.push(`The dealer has ₹ ${Math.round(overdue).toLocaleString('en-IN')} overdue by more than ${days} days.`);
  if (exposure.bank_guarantee.amount > 0 && !exposure.bank_guarantee.valid && allowed(row, 'bank_guarantee_expired')) reasons.push('The dealer\'s bank guarantee has expired.');
  if (!reasons.length) return null;
  return { lane: 'credit', roles: row?.role_chain.length ? row.role_chain : ['accounts'], slaHours: await laneSla(ctx, 'credit', row), reasons, ruleId: row?.id ?? null };
}

export async function planQuoteApprovals(ctx: AppContext, quote: Quotation, evaluation: EvaluationResult): Promise<LanePlan[]> {
  const plans = await Promise.all([commercialPlan(ctx, quote), compliancePlan(ctx, quote, evaluation), creditPlan(ctx, quote)]);
  return plans.filter((p): p is LanePlan => !!p);
}

/* ───────────── opening approvals ───────────── */
async function startStepClock(ctx: AppContext, approval: Approval, ownerId: string | null, label: string): Promise<void> {
  if (!approval.due_at) return;
  await ctx.svc.clocks.start({ entity_type: 'approval', entity_id: approval.id, clock_type: 'approval', due_at: approval.due_at, owner_id: ownerId, meta: toJson({ label, lane: approval.lane, entity_type: approval.entity_type, entity_id: approval.entity_id, role: approval.required_role }) });
}

export async function openQuoteApprovals(ctx: AppContext, quote: Quotation, plans: LanePlan[], note?: string | null): Promise<Approval[]> {
  const prior = await ctx.db.table('approvals').all({ entity_type: 'quotation', entity_id: quote.id });
  const round = prior.reduce((m, a) => Math.max(m, roundOf(a)), 0) + 1;
  const cal = await workCalendar(ctx);
  const now = ctx.now();
  const label = `Quotation ${quote.quote_no} v${quote.version}`;
  const created: Approval[] = [];
  for (const plan of plans) {
    for (const [i, role] of plan.roles.entries()) {
      const due = i === 0 ? addWorkingMinutes(now, Math.round(plan.slaHours * 60), cal).toISOString() : null;
      const row = await ctx.db.table('approvals').insert({
        entity_type: 'quotation', entity_id: quote.id, lane: plan.lane, step: i + 1, required_role: role, approver_id: null, decision: 'pending', comment: null, decided_at: null,
        due_at: due, requested_by: ctx.system ? null : ctx.user.id, requested_at: now.toISOString(), created_by: ctx.system ? null : ctx.user.id,
        meta: toJson({ round, label, chain: plan.roles, reasons: plan.reasons, rule_id: plan.ruleId, sla_hours: plan.slaHours, note: note ?? null, total: quote.total, quote_no: quote.quote_no }),
      });
      created.push(row);
      if (i === 0) {
        await startStepClock(ctx, row, quote.owner_id, label);
        await ctx.svc.notify.notify({
          roles: [role], kind: 'approval.quotation.requested', title: `Approval needed — ${label}`, body: `${plan.lane} lane${plan.roles.length > 1 ? `, step 1 of ${plan.roles.length}` : ''}. ${plan.reasons[0] ?? ''}`.trim(),
          severity: 'info', link: '/approvals', entity_type: 'quotation', entity_id: quote.id,
        });
      }
    }
  }
  return created;
}

/* ───────────── compliance override requests ───────────── */
export async function openOverrideApproval(ctx: AppContext, input: { target: 'quotation' | 'dispatch' | 'sales_order'; entity_id: string; gates: string[]; reason: string; label: string; extra?: Record<string, Json> }): Promise<Approval> {
  const existing = await ctx.db.table('approvals').all({ entity_type: 'compliance_override', entity_id: input.entity_id });
  if (existing.some((a) => a.decision === 'pending')) throw conflict('A compliance override for this record is already waiting for the compliance officer');
  const row = await ctx.db.table('approval_rules').one({ lane: 'compliance', active: true });
  const sla = await laneSla(ctx, 'compliance', row);
  const due = addWorkingMinutes(ctx.now(), Math.round(sla * 60), await workCalendar(ctx)).toISOString();
  const round = existing.reduce((m, a) => Math.max(m, roundOf(a)), 0) + 1;
  const approval = await ctx.db.table('approvals').insert({
    entity_type: 'compliance_override', entity_id: input.entity_id, lane: 'compliance', step: 1, required_role: 'compliance_officer', approver_id: null, decision: 'pending', comment: null, decided_at: null,
    due_at: due, requested_by: ctx.system ? null : ctx.user.id, requested_at: ctx.now().toISOString(), created_by: ctx.system ? null : ctx.user.id,
    meta: toJson({ kind: 'override', target: input.target, gates: input.gates, reason: input.reason, round, label: input.label, chain: ['compliance_officer'], ...(input.extra ?? {}) }),
  });
  await startStepClock(ctx, approval, ctx.system ? null : ctx.user.id, input.label);
  await ctx.svc.notify.notify({
    roles: ['compliance_officer'], kind: 'approval.compliance_override.requested', title: `Compliance override requested — ${input.label}`, body: `Gates ${input.gates.join(', ')}. Reason: ${input.reason}`,
    severity: 'warning', link: '/approvals', entity_type: 'compliance_override', entity_id: input.entity_id,
  });
  await audit(ctx, { action: 'compliance.override_requested', table: 'approvals', record_id: approval.id, detail: toJson({ target: input.target, entity_id: input.entity_id, gates: input.gates, reason: input.reason }) });
  return approval;
}

/* ───────────── entity summaries (inbox / quote card) ───────────── */
export interface EntitySummary { entity_type: ApprovalEntity; entity_id: string; title: string; subtitle: string | null; value: number | null; segment: string | null; link: string; territory_id: string | null; owner_id: string | null }

async function summarise(ctx: AppContext, rows: Approval[]): Promise<Map<string, EntitySummary>> {
  const out = new Map<string, EntitySummary>();
  const ids = (t: ApprovalEntity) => [...new Set(rows.filter((r) => r.entity_type === t).map((r) => r.entity_id))];
  const key = (t: string, id: string) => `${t}:${id}`;

  const quoteIds = ids('quotation');
  const quotes = quoteIds.length ? await ctx.db.table('quotations').all({ id: quoteIds }) : [];
  const custIds = [...new Set(quotes.map((q) => q.customer_id).filter((c): c is string => !!c))];
  const customers = new Map((custIds.length ? await ctx.db.table('customers').all({ id: custIds }) : []).map((c) => [c.id, c]));
  for (const q of quotes) {
    out.set(key('quotation', q.id), { entity_type: 'quotation', entity_id: q.id, title: `Quotation ${q.quote_no} v${q.version}`, subtitle: `${customers.get(q.customer_id ?? '')?.legal_name ?? 'Customer'} · ${q.kw} kW · ${q.discount_pct}% discount`, value: q.total, segment: q.segment, link: `/quotes/${q.id}`, territory_id: q.territory_id, owner_id: q.owner_id });
  }
  const piIds = ids('proforma_invoice');
  for (const p of piIds.length ? await ctx.db.table('proforma_invoices').all({ id: piIds }) : []) {
    out.set(key('proforma_invoice', p.id), { entity_type: 'proforma_invoice', entity_id: p.id, title: `Proforma invoice ${p.pi_no}`, subtitle: p.legal_name, value: p.total, segment: null, link: entityPath('proforma_invoice', p.id), territory_id: null, owner_id: null });
  }
  const soIds = ids('sales_order');
  for (const s of soIds.length ? await ctx.db.table('sales_orders').all({ id: soIds }) : []) {
    out.set(key('sales_order', s.id), { entity_type: 'sales_order', entity_id: s.id, title: `Sales order ${s.so_no}`, subtitle: s.customer_po_no ? `PO ${s.customer_po_no}` : null, value: s.total, segment: s.segment, link: entityPath('sales_order', s.id), territory_id: s.territory_id, owner_id: null });
  }
  const coIds = ids('credit_override');
  for (const c of coIds.length ? await ctx.db.table('credit_overrides').all({ id: coIds }) : []) {
    const dealer = await ctx.db.table('dealers').get(c.dealer_id);
    out.set(key('credit_override', c.id), { entity_type: 'credit_override', entity_id: c.id, title: `Credit override — ${dealer?.legal_name ?? 'dealer'}`, subtitle: c.reason, value: null, segment: null, link: '/approvals', territory_id: null, owner_id: null });
  }
  for (const id of ids('compliance_override')) {
    const a = rows.find((r) => r.entity_type === 'compliance_override' && r.entity_id === id)!;
    const meta = (a.meta ?? {}) as { label?: string; reason?: string; gates?: string[] };
    const quote = await ctx.db.table('quotations').get(id);
    out.set(key('compliance_override', id), {
      entity_type: 'compliance_override', entity_id: id, title: meta.label ?? 'Compliance override', subtitle: [meta.gates?.length ? `Gates ${meta.gates.join(', ')}` : null, meta.reason].filter(Boolean).join(' — ') || null,
      value: quote?.total ?? null, segment: quote?.segment ?? null, link: quote ? `/quotes/${quote.id}` : '/approvals', territory_id: quote?.territory_id ?? null, owner_id: quote?.owner_id ?? null,
    });
  }
  return out;
}

export interface ApprovalView extends Approval {
  actionable: boolean;
  sla: { state: 'waiting' | 'running' | 'overdue' | 'done'; due_at: string | null; remaining_minutes: number | null; overdue: boolean; clock: Pick<Clock, 'id' | 'status' | 'escalated_level'> | null };
  entity: EntitySummary | null;
  chain: { step: number; required_role: AppRole; decision: Approval['decision']; decided_at: string | null; approver_id: string | null }[];
}

export async function hydrateApprovals(ctx: AppContext, rows: Approval[]): Promise<ApprovalView[]> {
  if (!rows.length) return [];
  const siblings = await ctx.db.table('approvals').all({ entity_id: [...new Set(rows.map((r) => r.entity_id))] });
  const clocks = await ctx.db.table('clocks').all({ clock_type: 'approval', entity_type: 'approval', entity_id: rows.map((r) => r.id) });
  const clockBy = new Map(clocks.map((c) => [c.entity_id, c]));
  const summaries = await summarise(ctx, rows);
  const now = ctx.now().getTime();
  return rows.map((r) => {
    const group = siblings.filter((s) => s.entity_type === r.entity_type && s.entity_id === r.entity_id && s.lane === r.lane && roundOf(s) === roundOf(r)).sort((a, b) => a.step - b.step);
    const earlierOpen = group.some((s) => s.step < r.step && s.decision !== 'approved' && s.decision !== 'skipped');
    const clock = clockBy.get(r.id) ?? null;
    const due = r.due_at ? new Date(r.due_at).getTime() : null;
    const pending = r.decision === 'pending';
    const state: ApprovalView['sla']['state'] = !pending ? 'done' : earlierOpen ? 'waiting' : due !== null && due < now ? 'overdue' : 'running';
    return {
      ...r, actionable: pending && !earlierOpen,
      sla: { state, due_at: r.due_at, remaining_minutes: pending && due !== null && !earlierOpen ? Math.round((due - now) / 60000) : null, overdue: state === 'overdue', clock: clock ? { id: clock.id, status: clock.status, escalated_level: clock.escalated_level } : null },
      entity: summaries.get(`${r.entity_type}:${r.entity_id}`) ?? null,
      chain: group.map((g) => ({ step: g.step, required_role: g.required_role, decision: g.decision, decided_at: g.decided_at, approver_id: g.approver_id })),
    };
  });
}

export interface InboxQuery { scope: 'mine' | 'all'; lane?: ApprovalLane; entity_type?: ApprovalEntity; decision: Approval['decision']; actionable?: boolean; limit: number; offset: number; q?: string }

export async function listApprovals(ctx: AppContext, q: InboxQuery): Promise<{ rows: ApprovalView[]; total: number }> {
  const where: Record<string, string | string[]> = { decision: q.decision };
  if (q.lane) where['lane'] = q.lane;
  if (q.entity_type) where['entity_type'] = q.entity_type;
  const mineOnly = q.scope === 'mine' && ctx.user.role !== 'admin';
  if (mineOnly) {
    // a higher authority also sees the lower commercial steps it may decide
    const roles = (Object.keys(RANK) as AppRole[]).filter((r) => canDecideRole(ctx.user.role, r));
    where['required_role'] = [...new Set([ctx.user.role, ...roles])];
  }
  const all = await ctx.db.table('approvals').all(where, { orderBy: [{ col: 'requested_at', dir: 'desc' }, { col: 'step' }] });
  let views = await hydrateApprovals(ctx, all);
  if (ctx.user.territory_ids.length) views = views.filter((v) => !v.entity?.territory_id || ctx.user.territory_ids.includes(v.entity.territory_id));
  if (q.actionable) views = views.filter((v) => v.actionable);
  if (q.q) { const n = q.q.toLowerCase(); views = views.filter((v) => `${v.entity?.title ?? ''} ${v.entity?.subtitle ?? ''}`.toLowerCase().includes(n)); }
  views.sort((a, b) => (a.due_at ?? '9999').localeCompare(b.due_at ?? '9999') || b.requested_at.localeCompare(a.requested_at));
  return { rows: views.slice(q.offset, q.offset + q.limit), total: views.length };
}

/** Number of pending approvals the signed-in user can act on right now (sidebar badge). */
export async function approvalSummary(ctx: AppContext): Promise<{ mine: number }> {
  const { total } = await listApprovals(ctx, { scope: 'mine', decision: 'pending', actionable: true, limit: 1, offset: 0 });
  return { mine: total };
}

export async function getApprovalView(ctx: AppContext, id: string): Promise<ApprovalView> {
  const a = await ctx.db.table('approvals').get(id);
  if (!a) throw notFound('Approval');
  return (await hydrateApprovals(ctx, [a]))[0]!;
}

/** All approvals of a quote (every round), hydrated with SLA timers. */
export async function quoteApprovals(ctx: AppContext, quoteId: string): Promise<ApprovalView[]> {
  const ids = [quoteId];
  const rows = await ctx.db.table('approvals').all({ entity_type: ['quotation', 'compliance_override'], entity_id: ids }, { orderBy: [{ col: 'requested_at' }, { col: 'step' }] });
  return hydrateApprovals(ctx, rows);
}

/* ───────────── deciding ───────────── */
export interface DecisionResult { approval: ApprovalView; outcome: ApprovalOutcome }

async function entityTerritory(ctx: AppContext, a: Approval): Promise<string | null> {
  if (a.entity_type === 'quotation' || a.entity_type === 'compliance_override') return (await ctx.db.table('quotations').get(a.entity_id))?.territory_id ?? null;
  if (a.entity_type === 'sales_order') return (await ctx.db.table('sales_orders').get(a.entity_id))?.territory_id ?? null;
  return null;
}

export async function decideApproval(ctx: AppContext, id: string, input: { decision: 'approved' | 'rejected'; comment?: string }): Promise<DecisionResult> {
  const a = await ctx.db.table('approvals').get(id);
  if (!a) throw notFound('Approval');
  if (a.decision !== 'pending') throw invalidState(`This approval has already been ${a.decision}`, { decision: a.decision });
  if (!canDecideRole(ctx.user.role, a.required_role)) throw forbidden(`This step needs a ${ROLE_LABEL[a.required_role]} to decide`);
  if (ctx.user.territory_ids.length) {
    const territory = await entityTerritory(ctx, a);
    if (territory && !ctx.user.territory_ids.includes(territory)) throw forbidden('This record is outside your territory');
  }
  const comment = input.comment?.trim() ?? '';
  const needsComment = input.decision === 'rejected' || a.entity_type === 'compliance_override' || a.entity_type === 'credit_override';
  if (needsComment && comment.length < 3) {
    throw new AppError(422, 'VALIDATION_ERROR', input.decision === 'rejected' ? 'A written reason is required to reject' : 'A written reason is required to decide an override', [{ path: 'comment', message: 'Enter a written comment (at least 3 characters)' }]);
  }
  const siblings = (await ctx.db.table('approvals').all({ entity_type: a.entity_type, entity_id: a.entity_id })).filter((s) => s.lane === a.lane && roundOf(s) === roundOf(a));
  if (siblings.some((s) => s.step < a.step && s.decision !== 'approved' && s.decision !== 'skipped')) {
    throw invalidState('An earlier approval step in this lane is still pending — it has to be decided first');
  }

  const now = ctx.now().toISOString();
  const row = await ctx.db.table('approvals').update(a.id, { decision: input.decision, comment: comment || null, decided_at: now, approver_id: ctx.user.id });
  await ctx.svc.clocks.complete('approval', a.id, 'approval', toJson({ decision: input.decision }));
  await audit(ctx, { action: `approval.${input.decision}`, table: 'approvals', record_id: a.id, old: toJson({ decision: a.decision }), new: toJson({ decision: row.decision, comment: row.comment }), detail: toJson({ entity_type: a.entity_type, entity_id: a.entity_id, lane: a.lane, step: a.step }) });

  const laterOpen = siblings.some((s) => s.step > a.step && s.decision === 'pending');
  const outcome: ApprovalOutcome = input.decision === 'rejected' ? 'rejected' : laterOpen ? 'step_approved' : 'lane_approved';
  await getApprovalHandler(a.entity_type)?.(ctx, row, outcome);
  return { approval: await getApprovalView(ctx, a.id), outcome };
}

/* ───────────── handler: quotation ───────────── */
async function skipOpenSteps(ctx: AppContext, rows: Approval[], note: string): Promise<void> {
  for (const r of rows.filter((x) => x.decision === 'pending')) {
    await ctx.db.table('approvals').update(r.id, { decision: 'skipped', decided_at: ctx.now().toISOString(), comment: note });
    await ctx.svc.clocks.cancel('approval', r.id, 'approval');
  }
}

async function onQuotationApproval(ctx: AppContext, approval: Approval, outcome: ApprovalOutcome): Promise<void> {
  const quote = await ctx.db.table('quotations').get(approval.entity_id);
  if (!quote) return;
  const rows = (await ctx.db.table('approvals').all({ entity_type: 'quotation', entity_id: quote.id })).filter((r) => roundOf(r) === roundOf(approval));
  const label = `Quotation ${quote.quote_no} v${quote.version}`;
  const owner = quote.owner_id ? [quote.owner_id] : [];

  if (outcome === 'rejected') {
    await skipOpenSteps(ctx, rows, 'Closed — another approver rejected the quote');
    if (quote.status === 'pending_approval') {
      const why = `Rejected in the ${approval.lane} lane (${ROLE_LABEL[approval.required_role]}): ${approval.comment ?? ''}`.trim();
      await ctx.db.table('quotations').update(quote.id, { status: 'rejected', rejected_reason: why });
      await audit(ctx, { action: 'quote.approval_rejected', table: 'quotations', record_id: quote.id, detail: toJson({ lane: approval.lane, comment: approval.comment }) });
      if (owner.length) await ctx.svc.notify.notify({ user_ids: owner, kind: 'quote.approval_rejected', title: `${label} was rejected`, body: why, severity: 'warning', entity_type: 'quotation', entity_id: quote.id });
    }
    return;
  }
  if (outcome === 'step_approved') {
    const next = rows.filter((r) => r.lane === approval.lane && r.step > approval.step && r.decision === 'pending').sort((a, b) => a.step - b.step)[0];
    if (!next) return;
    const sla = Number((next.meta as { sla_hours?: number } | null)?.sla_hours) || 24;
    const due = addWorkingMinutes(ctx.now(), Math.round(sla * 60), await workCalendar(ctx)).toISOString();
    const active = await ctx.db.table('approvals').update(next.id, { due_at: due });
    await startStepClock(ctx, active, quote.owner_id, label);
    await ctx.svc.notify.notify({ roles: [next.required_role], kind: 'approval.quotation.requested', title: `Approval needed — ${label}`, body: `${next.lane} lane, step ${next.step} of ${rows.filter((r) => r.lane === next.lane).length}.`, severity: 'info', link: '/approvals', entity_type: 'quotation', entity_id: quote.id });
    return;
  }
  // lane complete — the quote is approved when every lane of this round is approved
  const live = rows.filter((r) => r.decision !== 'skipped');
  if (live.length && live.every((r) => r.decision === 'approved') && quote.status === 'pending_approval') {
    await ctx.db.table('quotations').update(quote.id, { status: 'approved' });
    await audit(ctx, { action: 'quote.approved', table: 'quotations', record_id: quote.id, detail: toJson({ lanes: [...new Set(live.map((r) => r.lane))] }) });
    if (owner.length) await ctx.svc.notify.notify({ user_ids: owner, kind: 'quote.approved', title: `${label} is approved`, body: 'All approval lanes have signed off. You can send the quotation to the customer.', severity: 'success', entity_type: 'quotation', entity_id: quote.id });
  }
}
registerApprovalHandler('quotation', onQuotationApproval);

/* ───────────── handler: compliance_override ───────────── */
async function onComplianceOverride(ctx: AppContext, approval: Approval, outcome: ApprovalOutcome): Promise<void> {
  if (outcome === 'step_approved') return;
  const meta = readOverrideMeta(approval.meta);
  const requester = approval.requested_by ? [approval.requested_by] : [];
  const target = meta?.target ?? ((approval.meta as { dispatch_id?: string } | null)?.dispatch_id ? 'dispatch' : null);
  const approved = outcome !== 'rejected';
  await audit(ctx, { action: approved ? 'compliance.override_approved' : 'compliance.override_rejected', table: 'approvals', record_id: approval.id, detail: toJson({ target, entity_id: approval.entity_id, gates: meta?.gates ?? null, reason: meta?.reason ?? null, comment: approval.comment }) });

  if (target === 'quotation') {
    const quote = await ctx.db.table('quotations').get(approval.entity_id);
    if (quote && approved) {
      const result = await ctx.svc.compliance.evaluateQuote(quote.id);
      const fresh = await ctx.db.table('quotations').getOrThrow(quote.id);
      if (fresh.status === 'blocked' && !result.hasHardStop) await ctx.db.table('quotations').update(quote.id, { status: 'draft' });
    }
  }
  if (requester.length) {
    await ctx.svc.notify.notify({
      user_ids: requester, kind: approved ? 'compliance.override_approved' : 'compliance.override_rejected', title: approved ? 'Compliance override approved' : 'Compliance override rejected',
      body: approved ? `Gates ${meta?.gates.join(', ') ?? ''} are overridden. Re-evaluate to continue.` : approval.comment ?? undefined, severity: approved ? 'success' : 'warning',
      entity_type: target === 'quotation' ? 'quotation' : target === 'dispatch' ? 'dispatch' : 'compliance_override', entity_id: approval.entity_id,
    });
  }
}
registerApprovalHandler('compliance_override', onComplianceOverride);

/* ───────────── approval SLA clock: tell the approver, not just the requester ───────────── */
registerClockHandlers('approval', {
  async onWarn(ctx, clock) { await remindApprover(ctx, clock, 'is about to breach its SLA'); },
  async onBreach(ctx, clock) { await remindApprover(ctx, clock, 'has breached its SLA'); },
});

async function remindApprover(ctx: AppContext, clock: Clock, what: string): Promise<void> {
  if (clock.entity_type !== 'approval') return; // clocks of other modules (PI, sales order) are handled by their own modules
  const a = await ctx.db.table('approvals').get(clock.entity_id);
  if (!a || a.decision !== 'pending') return;
  const label = (a.meta as { label?: string } | null)?.label ?? a.entity_type;
  await ctx.svc.notify.notify({ roles: [a.required_role], kind: `approval.${a.entity_type}.sla`, title: `Approval ${what} — ${label}`, body: `${a.lane} lane, step ${a.step}.`, severity: 'critical', link: '/approvals', entity_type: a.entity_type, entity_id: a.entity_id });
}

