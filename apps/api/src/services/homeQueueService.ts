import {
  ROLE_LABEL, entityPath, formatDate, formatDuration, formatINR, formatINRCompact, titleCase,
  type AppRole, type DashboardFilterInput, type HomeDashboard, type HomeItem, type HomeSection, type HomeSeverity, type HomeTile,
} from '@solar/shared';
import type { AppContext } from '../auth/context';
import { istEndOfDay } from '../lib/time';
import { computeCfaPending } from './kpi/cfa';
import { computeConsent } from './kpi/consent';
import { computeDealerExposureDashboard } from './kpi/dealer';
import { entityLabels } from './kpi/labels';
import { KpiScope, resolveFilters } from './kpi/scope';
import { computeStockExposure } from './kpi/stock';
import { DAY, MINUTE, ms, sum } from './kpi/stats';

const TOP_N = 5;
const ALL_ROLES: AppRole[] = ['management', 'regional_head', 'sales_manager', 'dsm', 'distributor_user', 'dealer_user', 'techno_commercial', 'accounts', 'compliance_officer', 'dispatch', 'viewer'];

/** Which roles see which section of the "Today" queue (admin sees everything). */
export const SECTION_ROLES: Record<string, AppRole[]> = {
  leads_awaiting_acceptance: ['distributor_user', 'dsm', 'sales_manager', 'regional_head', 'management'],
  followups_due: ['distributor_user', 'dealer_user', 'dsm', 'sales_manager', 'regional_head', 'management', 'techno_commercial'],
  approvals_waiting: ['management', 'regional_head', 'sales_manager', 'dsm', 'accounts', 'compliance_officer', 'techno_commercial'],
  quotes_to_send: ['techno_commercial', 'dsm', 'sales_manager', 'regional_head', 'management', 'distributor_user', 'dealer_user'],
  payments_credit: ['accounts', 'management', 'regional_head', 'sales_manager', 'distributor_user', 'dealer_user'],
  so_on_hold: ['accounts', 'sales_manager', 'regional_head', 'management', 'dispatch', 'dsm', 'distributor_user', 'dealer_user', 'viewer'],
  dispatch_blocked: ['dispatch', 'compliance_officer', 'sales_manager', 'regional_head', 'management', 'distributor_user', 'dealer_user'],
  discom_cfa_deadlines: ['dsm', 'sales_manager', 'regional_head', 'management', 'techno_commercial', 'accounts', 'distributor_user', 'dealer_user'],
  legacy_cfa_claims: ['dsm', 'sales_manager', 'regional_head', 'management', 'techno_commercial', 'accounts', 'distributor_user', 'dealer_user', 'viewer'],
  dealer_alerts: ['accounts', 'sales_manager', 'regional_head', 'management', 'compliance_officer', 'dsm', 'distributor_user', 'dealer_user', 'viewer'],
  compliance_calendar: ALL_ROLES,
  stock_exposure: ['management', 'regional_head', 'sales_manager', 'accounts', 'compliance_officer', 'dispatch', 'techno_commercial', 'viewer'],
  consent_coverage: ['management', 'regional_head', 'sales_manager', 'dsm', 'compliance_officer', 'distributor_user', 'dealer_user', 'viewer'],
};
const wants = (role: AppRole, key: string): boolean => role === 'admin' || (SECTION_ROLES[key] ?? []).includes(role);

interface ItemInput {
  entity_type: string; entity_id: string; title: string; path: string; subtitle?: string | null; due_at?: string | null; amount?: number | null; badge?: string | null; mine?: boolean; id?: string;
}

export async function homeDashboard(ctx: AppContext, input: DashboardFilterInput = {}): Promise<HomeDashboard> {
  const scope = new KpiScope(ctx, await resolveFilters(ctx, input));
  const f = scope.filters;
  const me = ctx.user;
  const role = me.role;
  const nowMs = f.nowMs;
  const todayEnd = istEndOfDay(f.today).toISOString();

  const leadMap = await scope.leadMap();
  const alertDays = (await ctx.svc.rules.value<number>('reporting.deadline_alert_days', undefined, 3)) ?? 3;
  const legacyAlertDays = (await ctx.svc.rules.value<number>('reporting.legacy_claim_alert_days', undefined, 30)) ?? 30;
  const releaseDays = (await ctx.svc.rules.value<number>('pmsg.cfa_release_days_after_discom_approval', undefined, 15)) ?? 15;
  const lookahead = (await ctx.svc.rules.value<number>('reporting.calendar_lookahead_days', undefined, 60)) ?? 60;

  const item = (o: ItemInput): HomeItem => {
    const due = o.due_at ?? null;
    const dueMs = due ? ms(due) : null;
    const left = dueMs === null ? null : dueMs - nowMs;
    return {
      id: o.id ?? `${o.entity_type}:${o.entity_id}`, entity_type: o.entity_type, entity_id: o.entity_id, title: o.title, subtitle: o.subtitle ?? null, path: o.path, due_at: due,
      time_left_minutes: left === null ? null : Math.round(left / MINUTE),
      time_left_label: left === null ? null : left >= 0 ? `${formatDuration(left)} left` : `${formatDuration(-left)} overdue`,
      overdue: left !== null && left < 0, amount: o.amount ?? null, badge: o.badge ?? null, mine: o.mine ?? false,
    };
  };
  const byDue = (a: HomeItem, b: HomeItem): number => (a.due_at === null ? 1 : b.due_at === null ? -1 : (ms(a.due_at) ?? 0) - (ms(b.due_at) ?? 0));
  const mineFirst = (a: HomeItem, b: HomeItem): number => Number(b.mine) - Number(a.mine) || byDue(a, b);

  const sections: HomeSection[] = [];
  const add = (key: string, title: string, description: string, all: HomeItem[], path: string, extra: { count?: number; headline?: string | null; severity?: HomeSeverity; meta?: HomeSection['meta'] } = {}): HomeSection => {
    const overdueN = all.filter((i) => i.overdue).length;
    const section: HomeSection = {
      key, title, description, count: extra.count ?? all.length, headline: extra.headline ?? null, items: all.slice(0, TOP_N), path, meta: { overdue: overdueN, ...(extra.meta ?? {}) },
      severity: extra.severity ?? (overdueN > 0 ? 'critical' : all.length > 0 ? 'warning' : 'info'),
    };
    sections.push(section);
    return section;
  };

  /* ───────── 1. leads awaiting my acceptance ───────── */
  if (wants(role, 'leads_awaiting_acceptance')) {
    const leads = [...leadMap.values()].filter((l) => l.status === 'assigned');
    const items = leads.map((l) => item({
      entity_type: 'lead', entity_id: l.id, title: l.name, subtitle: [l.temperature ? `${l.temperature.toUpperCase()} lead` : null, l.city, l.capacity_kw ? `${l.capacity_kw} kW` : null].filter(Boolean).join(' · '),
      path: entityPath('lead', l.id), due_at: l.sla_due_at, badge: l.temperature ? titleCase(l.temperature) : null, mine: l.owner_id === me.id,
    })).sort(mineFirst);
    add('leads_awaiting_acceptance', 'Leads awaiting acceptance', 'Assigned leads that need accepting before the SLA runs out.', items, '/leads?status=assigned');
  }

  /* ───────── 2. follow-ups due today / overdue ───────── */
  if (wants(role, 'followups_due')) {
    const fus = (await ctx.db.table('followups').all({ status: 'open', due_at: { lte: todayEnd } })).filter((x) => leadMap.has(x.lead_id));
    const items = fus.map((x) => item({
      entity_type: 'followup', entity_id: x.id, title: `${titleCase(x.kind)} — ${leadMap.get(x.lead_id)!.name}`, subtitle: x.note, path: entityPath('lead', x.lead_id), due_at: x.due_at, mine: x.owner_id === me.id,
    })).sort(mineFirst);
    const overdueN = items.filter((i) => i.overdue).length;
    add('followups_due', 'Follow-ups due today', 'Open follow-ups due today and anything already overdue.', items, '/leads?followup=due', { meta: { overdue: overdueN, due_today: items.length - overdueN } });
  }

  /* ───────── 3. approvals waiting for my role ───────── */
  if (wants(role, 'approvals_waiting')) {
    const pending = await ctx.db.table('approvals').all({ decision: 'pending' });
    const minStep = new Map<string, number>();
    for (const a of pending) { const k = `${a.entity_type}|${a.entity_id}|${a.lane}`; minStep.set(k, Math.min(a.step, minStep.get(k) ?? Infinity)); }
    const actionable = pending.filter((a) => (role === 'admin' || a.required_role === role) && a.step === minStep.get(`${a.entity_type}|${a.entity_id}|${a.lane}`));
    actionable.sort((a, b) => (ms(a.due_at) ?? Infinity) - (ms(b.due_at) ?? Infinity));
    const labels = await entityLabels(ctx, actionable.slice(0, TOP_N).map((a) => ({ type: a.entity_type, id: a.entity_id })));
    const items = actionable.map((a) => {
      const label = labels.get(`${a.entity_type}:${a.entity_id}`) ?? titleCase(a.entity_type);
      const linked = ['quotation', 'proforma_invoice', 'sales_order'].includes(a.entity_type);
      return item({ id: a.id, entity_type: 'approval', entity_id: a.id, title: `${titleCase(a.lane)} approval — ${label}`, subtitle: a.comment ?? `Waiting since ${formatDate(a.requested_at)}`, path: linked ? entityPath(a.entity_type, a.entity_id) : '/approvals', due_at: a.due_at, badge: titleCase(a.lane), mine: true });
    });
    add('approvals_waiting', 'Approvals waiting for you', 'Approval steps that are now with your role, with the SLA time left.', items, '/approvals');
  }

  /* ───────── 4. quotes to send / re-quote ───────── */
  if (wants(role, 'quotes_to_send')) {
    const quotes = await scope.rows('quotations', { status: ['requote_required', 'approved', 'blocked'] });
    const todo = quotes.filter((q) => q.status !== 'blocked');
    const blockedN = quotes.length - todo.length;
    const items = todo.sort((a, b) => Number(b.status === 'requote_required') - Number(a.status === 'requote_required') || a.created_at.localeCompare(b.created_at)).map((q) => item({
      entity_type: 'quotation', entity_id: q.id, title: `${q.quote_no} (v${q.version})`, subtitle: `${formatINR(q.total)} · ${q.kw} kW${q.requote_reason ? ` · ${q.requote_reason}` : ''}`, path: entityPath('quotation', q.id),
      amount: q.total, badge: q.status === 'requote_required' ? 'Re-quote required' : 'Ready to send', mine: q.owner_id === me.id,
    }));
    const requoteN = todo.filter((q) => q.status === 'requote_required').length;
    add('quotes_to_send', 'Quotes to send or re-quote', 'Approved quotes ready to go out and quotes flagged for a re-quote.', items, '/quotes?status=approved,requote_required', {
      severity: requoteN > 0 ? 'warning' : 'info', meta: { requote_required: requoteN, ready_to_send: items.length - requoteN, blocked: blockedN },
    });
  }

  /* ───────── 5. payments / credit pending ───────── */
  if (wants(role, 'payments_credit')) {
    const pis = (await scope.rows('proforma_invoices', { status: ['issued', 'partially_paid'] })).filter((p) => !p.sales_order_id);
    const checks = await scope.rows('credit_checks', { result: 'pending' });
    const dealerNames = await scope.names('dealers', checks.map((c) => c.dealer_id));
    const piItems = pis.map((p) => item({ entity_type: 'proforma_invoice', entity_id: p.id, title: `${p.pi_no} — awaiting advance or credit approval`, subtitle: `${formatINR(p.total)}${p.legal_name ? ` · ${p.legal_name}` : ''}`, path: entityPath('proforma_invoice', p.id), due_at: p.valid_till ? istEndOfDay(p.valid_till).toISOString() : null, amount: p.total, badge: titleCase(p.status) }));
    const ccItems = checks.map((c) => item({ entity_type: 'credit_check', entity_id: c.id, title: `Credit decision pending — ${c.dealer_id ? dealerNames.get(c.dealer_id) ?? 'dealer' : 'dealer'}`, subtitle: `Limit ${formatINR(c.credit_limit)} · outstanding ${formatINR(c.outstanding)}`, path: c.pi_id ? entityPath('proforma_invoice', c.pi_id) : '/approvals', amount: c.outstanding, badge: 'Credit lane' }));
    const items = (role === 'accounts' ? [...ccItems, ...piItems] : [...piItems, ...ccItems]);
    add('payments_credit', 'Payment or credit pending', 'Proforma invoices waiting for the advance and credit checks waiting for a decision.', items, '/invoices?status=issued', { meta: { invoices: piItems.length, credit_checks: ccItems.length } });
  }

  /* ───────── 6. sales orders on hold ───────── */
  if (wants(role, 'so_on_hold')) {
    const sos = await scope.rows('sales_orders', { status: 'on_hold' });
    const items = sos.sort((a, b) => a.created_at.localeCompare(b.created_at)).map((o) => item({ entity_type: 'sales_order', entity_id: o.id, title: `${o.so_no} on hold`, subtitle: o.hold_reason ?? 'Waiting for advance or credit approval', path: entityPath('sales_order', o.id), amount: o.total, badge: 'On hold' }));
    add('so_on_hold', 'Sales orders on hold', 'Orders that cannot move to dispatch planning yet.', items, '/orders?status=on_hold');
  }

  /* ───────── 7. dispatch blocked ───────── */
  if (wants(role, 'dispatch_blocked')) {
    let dispatches = await ctx.db.table('dispatches').all({ status: 'blocked' });
    if (scope.restricted) {
      const soIds = new Set((await scope.rows('sales_orders')).map((o) => o.id));
      dispatches = dispatches.filter((d) => soIds.has(d.so_id));
    }
    const items = dispatches.map((d) => {
      const finding = Array.isArray(d.compliance_findings) ? d.compliance_findings.find((x) => x.severity === 'hard_stop') : undefined;
      return item({ entity_type: 'dispatch', entity_id: d.id, title: `${d.dispatch_no} blocked`, subtitle: finding ? `${finding.gate}: ${finding.message}` : 'Compliance hold', path: entityPath('dispatch', d.id), badge: 'Blocked' });
    });
    add('dispatch_blocked', 'Dispatch blocked', 'Dispatches stopped by a compliance hard stop (non-compliant serials).', items, '/dispatch?status=blocked', { severity: items.length ? 'critical' : 'info' });
  }

  /* ───────── 8. DISCOM / CFA items near deadline ───────── */
  if (wants(role, 'discom_cfa_deadlines')) {
    const apps = await scope.rows('discom_applications');
    const claims = await scope.rows('subsidy_claims');
    const near = (dueIso: string | null): boolean => { const t = ms(dueIso); return t !== null && t - nowMs <= alertDays * DAY; };
    const items: HomeItem[] = [];
    for (const a of apps) {
      const label = a.application_no ?? 'DISCOM application';
      if (a.feasibility_status === 'pending' && a.feasibility_due_at && near(a.feasibility_due_at)) items.push(item({ entity_type: 'discom_application', entity_id: a.id, id: `feas:${a.id}`, title: `Feasibility clock — ${label}`, subtitle: 'DISCOM feasibility is deemed after 15 days of silence', path: entityPath('discom_application', a.id), due_at: a.feasibility_due_at, badge: 'DISCOM' }));
      if (a.certificate_submitted_at && !a.commissioning_at && a.commissioning_due_at && near(a.commissioning_due_at)) items.push(item({ entity_type: 'discom_application', entity_id: a.id, id: `comm:${a.id}`, title: `Commissioning clock — ${label}`, subtitle: 'Installation certificate submitted, commissioning pending', path: entityPath('discom_application', a.id), due_at: a.commissioning_due_at, badge: 'DISCOM' }));
    }
    for (const c of claims) {
      if (!c.discom_approval_at || c.released_at || c.status === 'released' || c.status === 'rejected') continue;
      const due = new Date((ms(c.discom_approval_at) ?? 0) + releaseDays * DAY).toISOString();
      if (near(due)) items.push(item({ entity_type: 'subsidy_claim', entity_id: c.id, id: `cfa:${c.id}`, title: 'CFA release due', subtitle: `${formatINR(c.cfa_computed)} · DISCOM approved ${formatDate(c.discom_approval_at)}`, path: entityPath('subsidy_claim', c.id), due_at: due, amount: c.cfa_computed, badge: 'CFA' }));
    }
    items.sort(byDue);
    add('discom_cfa_deadlines', 'DISCOM and CFA near deadline', `DISCOM clocks and CFA releases due within ${alertDays} days or already overdue.`, items, '/post-sale?tab=discom');
  }

  /* ───────── 9. legacy CFA claims ───────── */
  if (wants(role, 'legacy_cfa_claims')) {
    const cfa = await computeCfaPending(scope);
    const lg = cfa.extra.legacy;
    const deadlineIso = lg.deadline ? istEndOfDay(lg.deadline).toISOString() : null;
    const items = lg.claims.map((c) => item({
      entity_type: 'subsidy_claim', entity_id: c.claim_id, title: `Legacy claim — ${c.dealer_name ?? 'dealer'}`, subtitle: `${titleCase(c.status)} · ${formatINR(c.cfa_computed)}`, path: c.path,
      due_at: c.claim_deadline ? istEndOfDay(c.claim_deadline).toISOString() : deadlineIso, amount: c.cfa_computed, badge: 'Legacy cohort',
    }));
    const sev: HomeSeverity = lg.count === 0 ? 'info' : lg.days_to_deadline !== null && lg.days_to_deadline <= legacyAlertDays ? 'critical' : 'warning';
    add('legacy_cfa_claims', 'Legacy CFA claims', 'Legacy-cohort subsidy claims not yet released, racing the claim deadline.', items, '/post-sale?tab=subsidy&cohort=legacy', {
      count: lg.count, severity: sev,
      headline: lg.deadline ? `${lg.count} legacy claim${lg.count === 1 ? '' : 's'} (${formatINRCompact(lg.value)}) not released — ${lg.days_to_deadline !== null && lg.days_to_deadline >= 0 ? `${lg.days_to_deadline} days to` : 'deadline passed on'} ${formatDate(lg.deadline)}` : null,
      meta: { days_to_deadline: lg.days_to_deadline, deadline: lg.deadline, value: lg.value, advisory: !(lg.rule.status === 'verified' && lg.rule.active) },
    });
  }

  /* ───────── 10. dealer alerts ───────── */
  if (wants(role, 'dealer_alerts')) {
    const dx = await computeDealerExposureDashboard(scope);
    const rank = new Map<string, number>();
    const reasons = new Map<string, string[]>();
    const note = (id: string, r: string, w: number) => { rank.set(id, Math.max(rank.get(id) ?? 0, w)); reasons.set(id, [...(reasons.get(id) ?? []), r]); };
    for (const d of dx.extra.flagged.deactivated) note(d.dealer_id, 'Deactivated on the portal', 4);
    for (const d of dx.extra.flagged.over_limit) note(d.dealer_id, `Over limit by ${formatINR(d.outstanding - d.credit_limit)}`, 3);
    for (const d of dx.extra.flagged.under_sop) note(d.dealer_id, 'Under SOP review', 2);
    for (const d of dx.extra.flagged.bg_expiring) note(d.dealer_id, d.bank_guarantee.days_left !== null && d.bank_guarantee.days_left < 0 ? 'Bank guarantee expired' : `Bank guarantee expires in ${d.bank_guarantee.days_left} days`, 1);
    const rows = dx.extra.dealers.filter((d) => rank.has(d.dealer_id)).sort((a, b) => rank.get(b.dealer_id)! - rank.get(a.dealer_id)! || b.outstanding - a.outstanding);
    const items = rows.map((d) => item({ entity_type: 'dealer', entity_id: d.dealer_id, title: d.dealer_name, subtitle: reasons.get(d.dealer_id)!.join(' · '), path: d.path, amount: d.outstanding, badge: rank.get(d.dealer_id)! >= 3 ? 'Blocked' : 'Watch' }));
    add('dealer_alerts', 'Dealer alerts', 'Dealers under SOP or deactivated, over their credit limit, or with a bank guarantee about to expire.', items, '/dealers', {
      severity: rows.some((d) => rank.get(d.dealer_id)! >= 3) ? 'critical' : items.length ? 'warning' : 'info',
      meta: { under_sop: dx.extra.flagged.under_sop.length, deactivated: dx.extra.flagged.deactivated.length, over_limit: dx.extra.flagged.over_limit.length, bg_expiring: dx.extra.flagged.bg_expiring.length },
    });
  }

  /* ───────── 11. compliance calendar ───────── */
  if (wants(role, 'compliance_calendar')) {
    const until = new Date(f.nowMs + lookahead * DAY).toISOString().slice(0, 10);
    const cal = (await scope.reference('compliance_calendar_items', { active: true })).filter((c) => c.due_date >= f.today && c.due_date <= until).sort((a, b) => a.due_date.localeCompare(b.due_date));
    const items = cal.map((c) => item({ entity_type: 'calendar', entity_id: c.id, title: c.title, subtitle: `${formatDate(c.due_date)} · ${titleCase(c.confidence)} confidence`, path: '/calendar', due_at: istEndOfDay(c.due_date).toISOString(), badge: titleCase(c.confidence) }));
    const soonest = items[0]?.time_left_minutes ?? null;
    add('compliance_calendar', 'Compliance calendar', `Regulatory dates falling in the next ${lookahead} days.`, items, '/calendar', {
      severity: soonest !== null && soonest <= 14 * 24 * 60 ? 'critical' : items.length ? 'warning' : 'info', meta: { lookahead_days: lookahead },
    });
  }

  /* ───────── 12. stock exposure headline ───────── */
  if (wants(role, 'stock_exposure')) {
    const st = await computeStockExposure(scope);
    const { totals, exemption } = st.extra;
    const items = st.extra.by_sku.map((s) => item({ entity_type: 'sku', entity_id: s.sku_id, title: `${s.make} ${s.model}`, subtitle: `${s.units} units · ${formatINR(s.value)}`, path: s.path, amount: s.value }));
    add('stock_exposure', 'Non-List-II stock exposure', 'Module stock whose cells are not on ALMM List-II, ahead of the exemption end date.', items, '/catalogue?stale=list2', {
      count: totals.units, severity: exemption.urgency === 'critical' || exemption.urgency === 'passed' ? 'critical' : exemption.urgency === 'watch' ? 'warning' : 'info',
      headline: `${totals.units} non-List-II unit${totals.units === 1 ? '' : 's'} worth ${formatINRCompact(totals.value)} — ${exemption.days_left !== null && exemption.days_left >= 0 ? `${exemption.days_left} days to` : 'exemption ended'} ${exemption.date ? formatDate(exemption.date) : ''}`.trim(),
      meta: { units: totals.units, value: totals.value, days_left: exemption.days_left, exemption_date: exemption.date },
    });
  }

  /* ───────── 13. consent coverage headline ───────── */
  if (wants(role, 'consent_coverage')) {
    const cs = await computeConsent(scope);
    const k = cs.kpis.find((x) => x.key === 'consent_coverage_pct')!;
    const { coverage } = cs.extra;
    const items = cs.extra.uncovered_leads.map((l) => item({ entity_type: 'lead', entity_id: l.lead_id, title: l.name, subtitle: 'No valid consent before first contact', path: l.path, badge: 'No consent' }));
    add('consent_coverage', 'Consent coverage', 'Leads without a valid consent on record before contact.', items, '/leads?consent=missing', {
      count: coverage.uncovered, severity: coverage.uncovered > 0 ? 'warning' : 'info',
      headline: k.value === null ? 'No leads captured in the period' : `Consent coverage ${k.value}% (${coverage.covered} of ${coverage.leads} leads)`, meta: { coverage_pct: k.value, leads: coverage.leads },
    });
  }

  /* ───────── summary tiles ───────── */
  const OPEN = ['new', 'validated', 'unassigned', 'assigned', 'accepted', 'contacted', 'qualified', 'site_visit'];
  const openLeads = [...leadMap.values()].filter((l) => OPEN.includes(l.status));
  const opps = await scope.rows('opportunities', { stage: ['qualified', 'quotation', 'negotiation', 'pi_stage'] });
  const monthPrefix = f.today.slice(0, 7);
  const orders = (await scope.rows('sales_orders')).filter((o) => o.status !== 'cancelled' && o.order_date.startsWith(monthPrefix));
  const summary: HomeTile[] = [
    { key: 'open_leads', label: 'Open leads', value: openLeads.length, unit: 'count', path: '/leads' },
    { key: 'hot_leads', label: 'Hot leads', value: openLeads.filter((l) => l.temperature === 'hot').length, unit: 'count', path: '/leads?temperature=hot' },
    { key: 'pipeline_inr', label: 'Pipeline value', value: Math.round(sum(opps.map((o) => o.expected_value))), unit: 'inr', path: '/opportunities' },
    { key: 'orders_this_month', label: 'Orders this month', value: orders.length, unit: 'count', path: '/orders' },
  ];

  return {
    generated_at: f.now.toISOString(), user: { id: me.id, name: me.full_name, role, role_label: ROLE_LABEL[role] }, summary,
    next_best_action: nextBestAction(sections, role), sections,
  };
}

/** The single most useful thing to do next, picked from the queue by urgency. */
function nextBestAction(sections: HomeSection[], role: AppRole): HomeDashboard['next_best_action'] {
  const sec = (k: string) => sections.find((s) => s.key === k);
  const first = (k: string) => sec(k)?.items[0];
  const left = (i: HomeItem) => i.time_left_label ?? '';

  const accept = first('leads_awaiting_acceptance');
  if (accept?.overdue) return { text: `Accept "${accept.title}" now — the acceptance deadline passed (${left(accept)}).`, path: accept.path, severity: 'critical' };
  const appr = first('approvals_waiting');
  if (appr?.overdue) return { text: `Decide on ${appr.title} — ${left(appr)}.`, path: appr.path, severity: 'critical' };
  const fu = first('followups_due');
  if (fu?.overdue) return { text: `Follow up: ${fu.title} — ${left(fu)}.`, path: fu.path, severity: 'critical' };
  const legacy = sec('legacy_cfa_claims');
  if (legacy && legacy.count > 0 && legacy.severity === 'critical') return { text: legacy.headline ?? 'Push the legacy CFA claims through before the deadline.', path: legacy.path, severity: 'critical' };
  const blocked = first('dispatch_blocked');
  if (blocked) return { text: `Clear the compliance hold on ${blocked.title.replace(' blocked', '')} so it can ship.`, path: blocked.path, severity: 'critical' };
  const req = sections.find((s) => s.key === 'quotes_to_send')?.items.find((i) => i.badge === 'Re-quote required');
  if (req) return { text: `Re-quote ${req.title} — prices or rules changed since it was sent.`, path: req.path, severity: 'warning' };
  if (accept) return { text: `Accept "${accept.title}" — ${left(accept)}.`, path: accept.path, severity: 'warning' };
  if (appr) return { text: `Decide on ${appr.title} — ${left(appr)}.`, path: appr.path, severity: 'warning' };
  if (fu) return { text: `Follow up: ${fu.title} — ${left(fu)}.`, path: fu.path, severity: 'warning' };
  const pay = first('payments_credit');
  if (pay) return { text: `Chase the advance or credit decision for ${pay.title.split(' — ')[0]}.`, path: pay.path, severity: 'info' };
  const near = first('discom_cfa_deadlines');
  if (near) return { text: `${near.title} — ${left(near)}.`, path: near.path, severity: 'warning' };
  const hold = first('so_on_hold');
  if (hold) return { text: `Release ${hold.title.replace(' on hold', '')} from hold once the advance or credit is cleared.`, path: hold.path, severity: 'info' };
  const quote = first('quotes_to_send');
  if (quote) return { text: `Send ${quote.title} to the customer.`, path: quote.path, severity: 'info' };
  const external = role === 'distributor_user' || role === 'dealer_user';
  return { text: 'You are all caught up. Review open leads and add the next follow-up.', path: external ? '/leads' : '/opportunities', severity: 'info' };
}
