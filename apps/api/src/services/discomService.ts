/**
 * DISCOM applications: feasibility (deemed on silence above the exempt kW), inspection, meter, commissioning and the agreement.
 * Also orchestrates the installation certificate (starts the DISCOM commissioning clock) and commissioning (serials → installed,
 * warranty / O&M dates, subsidy-linked receivables), and computes per-DISCOM stage ageing.
 */
import {
  daysBetween, type Clock, type DiscomApplication, type DiscomApplicationCreateInput, type DiscomApplicationUpdateInput, type DiscomStageAgeingResult,
  type DiscomStageAgeingRow, type DiscomStageAgeingStat, type Installation, type Json,
} from '@solar/shared';
import type { AppContext } from '../auth/context';
import { assertCanRead, scopedWhere } from '../auth/access';
import { badRequest, guardBlocked, invalidState, notFound } from '../http/errors';
import { audit } from '../lib/audit';
import type { ClockHandlers } from './contracts';
import { getClockHandlers, registerClockHandlers, registerJob } from './hooks';
import {
  geoTaggedPhotoCount, markCertified, markCommissioned, regulationVersionFor, type WithWarnings,
} from './installationService';
import { actorId, daysFractional, dueAfterDays, istDay, loadByIds, mapById, median, percentile, round1, ruleNumber } from './postsaleShared';
import { closeSubsidyLinkedReceivables } from './receivableService';

/* ───────────── clock handlers ───────────── */
async function applicationForClock(ctx: AppContext, clock: Clock): Promise<DiscomApplication | null> {
  if (clock.entity_type === 'discom_application') return ctx.db.table('discom_applications').get(clock.entity_id);
  if (clock.entity_type === 'installation') return ctx.db.table('discom_applications').one({ installation_id: clock.entity_id });
  return null;
}

async function applicationLabel(ctx: AppContext, app: DiscomApplication): Promise<string> {
  const customer = app.customer_id ? await ctx.db.table('customers').get(app.customer_id) : null;
  return `${app.application_no ? `${app.application_no} · ` : ''}${customer?.display_name ?? customer?.legal_name ?? `${app.applied_kw} kW application`}`;
}

/** Commissioning clock breached: flag the deemed breach, log the evidence and tell the DSM. */
export async function markCommissioningBreach(ctx: AppContext, app: DiscomApplication, clock: Clock | null): Promise<void> {
  if (app.commissioning_at) return;
  const updated = app.deemed_breach ? app : await ctx.db.table('discom_applications').update(app.id, { deemed_breach: true });
  const now = ctx.now();
  const evidence = {
    application_id: app.id, application_no: app.application_no, installation_id: app.installation_id, discom_id: app.discom_id, applied_kw: app.applied_kw,
    certificate_submitted_at: app.certificate_submitted_at, commissioning_due_at: app.commissioning_due_at, detected_at: now.toISOString(),
    days_overdue: app.commissioning_due_at ? Math.max(0, daysBetween(app.commissioning_due_at, now)) : null, clock_id: clock?.id ?? null,
  };
  await audit(ctx, { action: 'discom.deemed_breach', table: 'discom_applications', record_id: app.id, old: { deemed_breach: app.deemed_breach }, new: { deemed_breach: updated.deemed_breach }, detail: { evidence } as unknown as Json });
  await ctx.svc.notify.notify({
    roles: ['dsm'], kind: 'discom.deemed_breach', severity: 'critical', entity_type: 'discom_application', entity_id: app.id,
    title: `DISCOM commissioning deadline missed — ${await applicationLabel(ctx, app)}`,
    body: `Certificate submitted ${istDay(app.certificate_submitted_at ?? now)}; commissioning was due by ${istDay(app.commissioning_due_at ?? now)}. Deemed-clock breach logged with evidence — escalate to the DISCOM.`,
  });
}

/** Feasibility clock breached: the DISCOM stayed silent, so feasibility is deemed granted. */
export async function markDeemedFeasibility(ctx: AppContext, app: DiscomApplication, clock: Clock | null): Promise<void> {
  if (app.feasibility_status !== 'pending') return;
  await ctx.db.table('discom_applications').update(app.id, { feasibility_status: 'deemed' });
  // the lapse is the DISCOM's, not ours: resolve the clock (it stays 'breached' for the KPI) so it stops escalating internally
  await ctx.svc.clocks.complete('discom_application', app.id, 'discom_feasibility', { deemed: true });
  const now = ctx.now();
  await audit(ctx, {
    action: 'discom.feasibility_deemed', table: 'discom_applications', record_id: app.id, old: { feasibility_status: 'pending' }, new: { feasibility_status: 'deemed' },
    detail: { evidence: { application_id: app.id, application_no: app.application_no, complete_at: app.complete_at, feasibility_due_at: app.feasibility_due_at, detected_at: now.toISOString(), clock_id: clock?.id ?? null } } as unknown as Json,
  });
  await ctx.svc.notify.notify({
    roles: ['dsm'], kind: 'discom.feasibility_deemed', severity: 'warning', entity_type: 'discom_application', entity_id: app.id,
    title: `Feasibility deemed granted — ${await applicationLabel(ctx, app)}`,
    body: `The DISCOM did not respond by ${istDay(app.feasibility_due_at ?? now)}; the study is treated as deemed feasible. Proceed with installation.`,
  });
}

registerClockHandlers('discom_commissioning', {
  async onBreach(ctx, clock) {
    const app = await applicationForClock(ctx, clock);
    if (app) await markCommissioningBreach(ctx, app, clock);
  },
});

// The site-survey module also starts `discom_feasibility` clocks (entity "site_survey"). Handlers are single-slot per clock type, so chain to whatever was registered first.
const previousFeasibility: ClockHandlers | undefined = getClockHandlers('discom_feasibility');
registerClockHandlers('discom_feasibility', {
  async onWarn(ctx, clock) { if (clock.entity_type !== 'discom_application') await previousFeasibility?.onWarn?.(ctx, clock); },
  async onBreach(ctx, clock) {
    if (clock.entity_type !== 'discom_application') { await previousFeasibility?.onBreach?.(ctx, clock); return; }
    const app = await applicationForClock(ctx, clock);
    if (app) await markDeemedFeasibility(ctx, app, clock);
  },
  async onEscalate(ctx, clock, level) { if (clock.entity_type !== 'discom_application') await previousFeasibility?.onEscalate?.(ctx, clock, level); },
});

/** Safety net for the single-slot handler registry: any pending application whose feasibility date has passed is deemed granted. */
export async function sweepDeemedFeasibility(ctx: AppContext): Promise<{ deemed: number }> {
  const now = ctx.now().toISOString();
  const due = await ctx.db.table('discom_applications').all({ feasibility_status: 'pending', feasibility_due_at: { lt: now } });
  for (const app of due) await markDeemedFeasibility(ctx, app, null);
  return { deemed: due.length };
}
registerJob({ name: 'discom.deemed_feasibility_sweep', schedule: '15 2 * * *', run: (ctx) => sweepDeemedFeasibility(ctx) });

/* ───────────── feasibility ───────────── */
async function feasibilityStatusFor(ctx: AppContext, kw: number, warnings: string[]): Promise<DiscomApplication['feasibility_status']> {
  const exempt = await ruleNumber(ctx, 'discom.feasibility_study_exempt_up_to_kw', 10, 'cannot tell whether a feasibility study is needed');
  if (exempt.value === null) { if (exempt.warning) warnings.push(exempt.warning); return 'pending'; }
  return kw <= exempt.value ? 'not_required' : 'pending';
}

/** (Re)start the feasibility clock from `complete_at` and store `feasibility_due_at`. No-op unless feasibility is pending and the application is complete. */
async function startFeasibilityClock(ctx: AppContext, app: DiscomApplication, warnings: string[]): Promise<DiscomApplication> {
  if (app.feasibility_status !== 'pending' || !app.complete_at) return app;
  const days = await ruleNumber(ctx, 'discom.feasibility_study_days_above_10kw', 15, 'feasibility clock not started', app.complete_at);
  if (days.value === null) { if (days.warning) warnings.push(days.warning); return app; }
  const due = dueAfterDays(app.complete_at, days.value);
  const updated = await ctx.db.table('discom_applications').update(app.id, { feasibility_due_at: due.toISOString() });
  await ctx.svc.clocks.start({
    entity_type: 'discom_application', entity_id: app.id, clock_type: 'discom_feasibility', due_at: due, started_at: app.complete_at, owner_id: actorId(ctx),
    meta: { application_id: app.id, days: days.value, rule_basis: days.basis } as Json,
  });
  return updated;
}

/* ───────────── create / update ───────────── */
export async function createDiscomApplication(ctx: AppContext, input: DiscomApplicationCreateInput): Promise<WithWarnings<DiscomApplication>> {
  const warnings: string[] = [];
  let installation: Installation | null = null;
  if (input.installation_id) {
    installation = await ctx.db.table('installations').get(input.installation_id);
    if (!installation) throw notFound('Installation');
    await assertCanRead(ctx, 'installations', installation);
  }
  const soId = input.sales_order_id ?? installation?.sales_order_id ?? null;
  const so = soId ? await ctx.db.table('sales_orders').get(soId) : null;
  if (soId && !so) throw notFound('Sales order');
  if (so) await assertCanRead(ctx, 'sales_orders', so);
  const siteId = input.site_id ?? installation?.site_id ?? so?.site_id ?? null;
  const site = siteId ? await ctx.db.table('sites').get(siteId) : null;
  if (installation) {
    const dup = await ctx.db.table('discom_applications').one({ installation_id: installation.id });
    if (dup) throw guardBlocked('A DISCOM application already exists for this installation', { application_id: dup.id });
  }
  const draft = {
    sales_order_id: soId, installation_id: installation?.id ?? null, site_id: siteId, customer_id: input.customer_id ?? installation?.customer_id ?? so?.customer_id ?? site?.customer_id ?? null,
    discom_id: input.discom_id ?? site?.discom_id ?? null, dealer_id: input.dealer_id ?? installation?.dealer_id ?? so?.dealer_id ?? null,
    distributor_id: input.distributor_id ?? installation?.distributor_id ?? so?.distributor_id ?? null,
  };
  await assertCanRead(ctx, 'discom_applications', draft); // external users may only file for their own party

  // pick up the dates already captured at survey stage (feasibility application)
  const survey = siteId ? (await ctx.db.table('site_surveys').all({ site_id: siteId }, { orderBy: { col: 'created_at', dir: 'desc' } }))[0] ?? null : null;
  const submitted_at = input.submitted_at ?? survey?.feasibility_application_submitted_at ?? null;
  const complete_at = input.complete_at ?? survey?.feasibility_application_complete_at ?? null;
  const status = await feasibilityStatusFor(ctx, input.applied_kw, warnings);
  const feasibility_status = survey && survey.feasibility_status !== 'pending' && survey.feasibility_status !== 'not_required' && status === 'pending' ? survey.feasibility_status : status;

  const row = await ctx.db.table('discom_applications').insert({
    ...draft, application_no: input.application_no ?? null, applied_kw: input.applied_kw, submitted_at, complete_at, feasibility_due_at: null, feasibility_status,
    inspection_at: null, meter_type: null, meter_at: null, certificate_submitted_at: installation?.certificate_at ?? null, commissioning_due_at: null, commissioning_at: null,
    agreement_status: input.agreement_status ?? (installation?.no_connectivity_agreement ? 'not_required' : 'pending'), regulation_version: null, deemed_breach: false, created_by: actorId(ctx),
  });
  await audit(ctx, { action: 'discom_application.create', table: 'discom_applications', record_id: row.id, new: row as unknown as Json });
  const started = await startFeasibilityClock(ctx, row, warnings);
  return { ...started, warnings };
}

export async function updateDiscomApplication(ctx: AppContext, id: string, input: DiscomApplicationUpdateInput): Promise<WithWarnings<DiscomApplication>> {
  const warnings: string[] = [];
  const before = await ctx.db.table('discom_applications').get(id);
  if (!before) throw notFound('DISCOM application');
  await assertCanRead(ctx, 'discom_applications', before);

  const { commissioning_at, ...rest } = input;
  const patch: Partial<DiscomApplication> = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Partial<DiscomApplication>;
  let status = patch.feasibility_status ?? before.feasibility_status;

  // capacity change may add or remove the feasibility requirement
  if (patch.applied_kw !== undefined && patch.applied_kw !== before.applied_kw && patch.feasibility_status === undefined && ['not_required', 'pending'].includes(before.feasibility_status)) {
    status = await feasibilityStatusFor(ctx, patch.applied_kw, warnings);
    patch.feasibility_status = status;
  }
  if (commissioning_at && before.installation_id) {
    const inst = await ctx.db.table('installations').get(before.installation_id);
    if (inst && !inst.certificate_at) throw guardBlocked('Record the installation certificate before commissioning');
  }
  let row = Object.keys(patch).length ? await ctx.db.table('discom_applications').update(id, patch) : before;

  // feasibility outcome / clock
  if (patch.feasibility_status && patch.feasibility_status !== before.feasibility_status) {
    if (['approved', 'rejected', 'deemed'].includes(patch.feasibility_status)) await ctx.svc.clocks.complete('discom_application', id, 'discom_feasibility', { outcome: patch.feasibility_status });
    else if (patch.feasibility_status === 'not_required') { await ctx.svc.clocks.cancel('discom_application', id, 'discom_feasibility'); row = await ctx.db.table('discom_applications').update(id, { feasibility_due_at: null }); }
  }
  const completeChanged = patch.complete_at !== undefined && patch.complete_at !== before.complete_at;
  const becamePending = row.feasibility_status === 'pending' && before.feasibility_status !== 'pending';
  if ((completeChanged || becamePending) && row.feasibility_status === 'pending') row = await startFeasibilityClock(ctx, row, warnings);
  else if (completeChanged && !row.complete_at) await ctx.svc.clocks.cancel('discom_application', id, 'discom_feasibility');

  await audit(ctx, { action: 'discom_application.update', table: 'discom_applications', record_id: id, old: before as unknown as Json, new: row as unknown as Json });

  if (commissioning_at && !before.commissioning_at) {
    const res = await finishCommissioning(ctx, row, commissioning_at);
    warnings.push(...res.warnings);
    row = res.application;
  } else if (commissioning_at === null) {
    throw badRequest('Commissioning cannot be cleared once recorded');
  }
  return { ...row, warnings };
}

/* ───────────── installation certificate → commissioning clock ───────────── */
async function ensureApplicationForInstallation(ctx: AppContext, inst: Installation, warnings: string[]): Promise<DiscomApplication> {
  const existing = (await ctx.db.table('discom_applications').one({ installation_id: inst.id })) ?? (await ctx.db.table('discom_applications').one({ sales_order_id: inst.sales_order_id, installation_id: null }));
  if (existing) return existing;
  if (!inst.kw) throw guardBlocked('Record the installed capacity (kW) before the certificate — the DISCOM application needs it');
  const site = inst.site_id ? await ctx.db.table('sites').get(inst.site_id) : null;
  const survey = inst.site_id ? (await ctx.db.table('site_surveys').all({ site_id: inst.site_id }, { orderBy: { col: 'created_at', dir: 'desc' } }))[0] ?? null : null;
  const status = await feasibilityStatusFor(ctx, inst.kw, warnings);
  const row = await ctx.db.table('discom_applications').insert({
    sales_order_id: inst.sales_order_id, installation_id: inst.id, site_id: inst.site_id, customer_id: inst.customer_id, discom_id: site?.discom_id ?? null, dealer_id: inst.dealer_id,
    distributor_id: inst.distributor_id, application_no: null, applied_kw: inst.kw, submitted_at: survey?.feasibility_application_submitted_at ?? null, complete_at: survey?.feasibility_application_complete_at ?? null,
    feasibility_due_at: survey?.feasibility_due_at ?? null, feasibility_status: status === 'pending' && survey && survey.feasibility_status !== 'pending' && survey.feasibility_status !== 'not_required' ? survey.feasibility_status : status,
    inspection_at: null, meter_type: null, meter_at: null, certificate_submitted_at: null, commissioning_due_at: null, commissioning_at: null,
    agreement_status: inst.no_connectivity_agreement ? 'not_required' : 'pending', regulation_version: null, deemed_breach: false, created_by: actorId(ctx),
  });
  await audit(ctx, { action: 'discom_application.create', table: 'discom_applications', record_id: row.id, new: row as unknown as Json, detail: { source: 'installation_certificate' } });
  return row;
}

/**
 * Record the installation certificate: installation → certified, the DISCOM application is created / updated and the commissioning clock
 * (rule discom.commissioning_days, default 15) starts from the certificate date.
 */
export async function certifyInstallation(ctx: AppContext, installationId: string, certificateAt?: string): Promise<WithWarnings<{ installation: Installation; discom_application: DiscomApplication }>> {
  const warnings: string[] = [];
  const inst = await ctx.db.table('installations').get(installationId);
  if (!inst) throw notFound('Installation');
  await assertCanRead(ctx, 'installations', inst);
  if (!inst.install_date) throw guardBlocked('Enter the installation date before recording the certificate');
  const at = certificateAt ?? ctx.now().toISOString();
  if (istDay(at) < inst.install_date) throw guardBlocked('The certificate cannot be dated before the installation date');
  if (geoTaggedPhotoCount(inst) === 0) warnings.push('No geo-tagged installation photo is on file yet — PM Surya Ghar needs geo-tagged photos for the DISCOM and subsidy steps.');

  const installation = await markCertified(ctx, inst, at);
  let app = await ensureApplicationForInstallation(ctx, installation, warnings);
  const days = await ruleNumber(ctx, 'discom.commissioning_days', 15, 'commissioning clock not started', at);
  const due = days.value !== null ? dueAfterDays(at, days.value) : null;
  if (days.warning) warnings.push(days.warning);
  app = await ctx.db.table('discom_applications').update(app.id, {
    installation_id: installation.id, certificate_submitted_at: at, commissioning_due_at: due ? due.toISOString() : null, deemed_breach: false,
    agreement_status: installation.no_connectivity_agreement ? 'not_required' : app.agreement_status === 'not_required' ? 'pending' : app.agreement_status,
  });
  if (due && !installation.commissioned_at && !app.commissioning_at) {
    await ctx.svc.clocks.start({
      entity_type: 'discom_application', entity_id: app.id, clock_type: 'discom_commissioning', due_at: due, started_at: at, owner_id: actorId(ctx),
      meta: { installation_id: installation.id, certificate_at: at, days: days.value, rule_basis: days.basis } as Json,
    });
  }
  await audit(ctx, { action: 'installation.certificate', table: 'installations', record_id: installation.id, old: inst as unknown as Json, new: installation as unknown as Json, detail: { discom_application_id: app.id, commissioning_due_at: app.commissioning_due_at } });
  return { installation, discom_application: app, warnings };
}

/* ───────────── commissioning ───────────── */
async function finishCommissioning(ctx: AppContext, app: DiscomApplication, commissioningAt: string, extra: { meter_type?: string | null; meter_at?: string } = {}): Promise<{ application: DiscomApplication; installation: Installation | null; serials_installed: number; receivables_closed: number; warnings: string[] }> {
  const warnings: string[] = [];
  const late = !!app.commissioning_due_at && commissioningAt > app.commissioning_due_at;
  let application = await ctx.db.table('discom_applications').update(app.id, {
    commissioning_at: commissioningAt, deemed_breach: app.deemed_breach || late,
    ...(extra.meter_type !== undefined ? { meter_type: extra.meter_type } : {}), ...(extra.meter_at ? { meter_at: extra.meter_at } : {}),
  });
  await ctx.svc.clocks.complete('discom_application', app.id, 'discom_commissioning', { commissioned_at: commissioningAt });

  let installation: Installation | null = null;
  let serials_installed = 0;
  const inst = app.installation_id ? await ctx.db.table('installations').get(app.installation_id) : null;
  if (inst && !inst.commissioned_at) {
    const res = await markCommissioned(ctx, inst, commissioningAt);
    installation = res.installation; serials_installed = res.serials_installed; warnings.push(...res.warnings);
    if (res.regulation_version) application = await ctx.db.table('discom_applications').update(app.id, { regulation_version: res.regulation_version });
  } else if (!inst) {
    const rv = await regulationVersionFor(ctx, istDay(commissioningAt));
    if (rv) application = await ctx.db.table('discom_applications').update(app.id, { regulation_version: rv });
  } else installation = inst;

  // a subsidy that is already released closes the subsidy-linked receivables as soon as the job is commissioned
  let receivables_closed = 0;
  const claimWhere = app.installation_id ? { installation_id: app.installation_id } : app.sales_order_id ? { sales_order_id: app.sales_order_id } : null;
  const claims = claimWhere ? await ctx.db.table('subsidy_claims').all({ status: 'released', ...claimWhere }) : [];
  for (const c of claims) receivables_closed += await closeSubsidyLinkedReceivables(ctx, [c.sales_order_id, c.installation_id, c.opportunity_id], 'commissioned after subsidy release');
  await audit(ctx, { action: 'discom.commissioned', table: 'discom_applications', record_id: app.id, old: app as unknown as Json, new: application as unknown as Json, detail: { late, serials_installed, receivables_closed } });
  return { application, installation, serials_installed, receivables_closed, warnings };
}

export async function commissionInstallation(ctx: AppContext, installationId: string, input: { commissioned_at?: string; meter_type?: string | null; meter_at?: string }): Promise<WithWarnings<{ installation: Installation; discom_application: DiscomApplication; serials_installed: number; receivables_closed: number }>> {
  const inst = await ctx.db.table('installations').get(installationId);
  if (!inst) throw notFound('Installation');
  await assertCanRead(ctx, 'installations', inst);
  if (inst.commissioned_at) throw invalidState('This installation is already commissioned');
  if (!inst.certificate_at) throw guardBlocked('Record the installation certificate before commissioning');
  const warnings: string[] = [];
  const app = await ensureApplicationForInstallation(ctx, inst, warnings);
  const at = input.commissioned_at ?? ctx.now().toISOString();
  if (istDay(at) < istDay(inst.certificate_at)) throw guardBlocked('Commissioning cannot be dated before the installation certificate');
  const res = await finishCommissioning(ctx, app, at, { meter_type: input.meter_type, meter_at: input.meter_at });
  return {
    installation: res.installation ?? (await ctx.db.table('installations').getOrThrow(installationId)), discom_application: res.application,
    serials_installed: res.serials_installed, receivables_closed: res.receivables_closed, warnings: [...warnings, ...res.warnings],
  };
}

/* ───────────── hydration ───────────── */
export async function hydrateDiscomApplications(ctx: AppContext, rows: DiscomApplication[]): Promise<DiscomApplication[]> {
  const now = ctx.now();
  const [customers, dealers, discoms, clocks] = await Promise.all([
    loadByIds(ctx, 'customers', rows.map((r) => r.customer_id)).then(mapById),
    loadByIds(ctx, 'dealers', rows.map((r) => r.dealer_id)).then(mapById),
    loadByIds(ctx, 'discoms', rows.map((r) => r.discom_id)).then(mapById),
    rows.length ? ctx.db.table('clocks').all({ entity_type: 'discom_application', entity_id: rows.map((r) => r.id), clock_type: ['discom_feasibility', 'discom_commissioning'] }, { orderBy: { col: 'started_at', dir: 'desc' } }) : Promise.resolve([]),
  ]);
  return rows.map((r) => {
    const feas = clocks.find((c) => c.entity_id === r.id && c.clock_type === 'discom_feasibility') ?? null;
    const comm = clocks.find((c) => c.entity_id === r.id && c.clock_type === 'discom_commissioning') ?? null;
    const c = customers.get(r.customer_id ?? '');
    return {
      ...r,
      customer_name: c?.display_name ?? c?.legal_name ?? null, dealer_name: dealers.get(r.dealer_id ?? '')?.legal_name ?? null,
      discom_code: discoms.get(r.discom_id ?? '')?.code ?? null, discom_name: discoms.get(r.discom_id ?? '')?.name ?? null,
      commissioning_overdue: !!r.commissioning_due_at && !r.commissioning_at && new Date(r.commissioning_due_at) < now,
      days_to_commissioning_due: r.commissioning_due_at && !r.commissioning_at ? daysBetween(now, r.commissioning_due_at) : null,
      feasibility_clock: feas ? { status: feas.status, due_at: feas.due_at } : null, commissioning_clock: comm ? { status: comm.status, due_at: comm.due_at } : null,
    } as DiscomApplication;
  });
}

/* ───────────── per-DISCOM stage ageing ───────────── */
export interface DiscomAgeingFilters { discom_id?: string; distributor_id?: string; dealer_id?: string; from?: string; to?: string }

interface Durations { feasibility: number[]; inspection: number[]; meter: number[]; commissioning: number[]; pending: Record<'feasibility' | 'inspection' | 'meter' | 'commissioning', number> }
const emptyDurations = (): Durations => ({ feasibility: [], inspection: [], meter: [], commissioning: [], pending: { feasibility: 0, inspection: 0, meter: 0, commissioning: 0 } });
const stat = (values: number[], pending: number): DiscomStageAgeingStat => ({ n: values.length, pending, median_days: median(values) === null ? null : round1(median(values)!), p90_days: percentile(values, 90) === null ? null : round1(percentile(values, 90)!) });

/**
 * Stage ageing per DISCOM, in TypeScript (no SQL): median and 90th percentile of the days each stage took, plus deemed-clock breaches.
 *   feasibility  — application complete (or submitted) → feasibility outcome (clock resolved; a lapsed clock counts to its due date)
 *   inspection   — installation certificate submitted → DISCOM inspection
 *   meter        — inspection (else certificate) → meter installed
 *   commissioning— installation certificate submitted → commissioning (the statutory 15-day measure)
 * `pending` counts applications that started the stage but have not finished it. Scoped to what the caller may read.
 */
export async function discomStageAgeing(ctx: AppContext, filters: DiscomAgeingFilters = {}): Promise<DiscomStageAgeingResult> {
  const where = await scopedWhere(ctx, 'discom_applications', {
    ...(filters.discom_id ? { discom_id: filters.discom_id } : {}), ...(filters.distributor_id ? { distributor_id: filters.distributor_id } : {}), ...(filters.dealer_id ? { dealer_id: filters.dealer_id } : {}),
  });
  let apps = await ctx.db.table('discom_applications').all(where);
  if (filters.from || filters.to) {
    apps = apps.filter((a) => {
      const day = istDay(a.submitted_at ?? a.certificate_submitted_at ?? a.created_at);
      return (!filters.from || day >= filters.from) && (!filters.to || day <= filters.to);
    });
  }
  const [discoms, clocks] = await Promise.all([
    ctx.db.table('discoms').all(),
    apps.length ? ctx.db.table('clocks').all({ entity_type: 'discom_application', entity_id: apps.map((a) => a.id), clock_type: 'discom_feasibility' }) : Promise.resolve([]),
  ]);
  const discomBy = mapById(discoms);
  const feasClock = new Map<string, Clock>();
  for (const c of clocks) { const cur = feasClock.get(c.entity_id); if (!cur || c.started_at > cur.started_at) feasClock.set(c.entity_id, c); }

  type Acc = { d: Durations; apps: number; commissioningBreaches: number; feasibilityBreaches: number };
  const groups = new Map<string, Acc>();
  const total: Acc = { d: emptyDurations(), apps: 0, commissioningBreaches: 0, feasibilityBreaches: 0 };
  const acc = (key: string): Acc => { let a = groups.get(key); if (!a) { a = { d: emptyDurations(), apps: 0, commissioningBreaches: 0, feasibilityBreaches: 0 }; groups.set(key, a); } return a; };

  for (const app of apps) {
    const targets = [acc(app.discom_id ?? '∅'), total];
    const add = (stage: keyof Omit<Durations, 'pending'>, from: string | null, to: string | null) => {
      if (!from) return;
      for (const t of targets) { if (to) t.d[stage].push(Math.max(0, daysFractional(from, to))); else t.d.pending[stage]++; }
    };
    for (const t of targets) t.apps++;
    // feasibility
    if (app.feasibility_status !== 'not_required') {
      const start = app.complete_at ?? app.submitted_at;
      const clock = feasClock.get(app.id);
      const decided = ['approved', 'rejected', 'deemed'].includes(app.feasibility_status);
      const end = decided ? (clock ? (clock.status === 'breached' ? clock.due_at : clock.resolved_at) : null) : null;
      add('feasibility', start, end);
      if (clock?.status === 'breached') for (const t of targets) t.feasibilityBreaches++;
    }
    add('inspection', app.certificate_submitted_at, app.inspection_at);
    add('meter', app.inspection_at ?? app.certificate_submitted_at, app.meter_at);
    add('commissioning', app.certificate_submitted_at, app.commissioning_at);
    if (app.deemed_breach) for (const t of targets) t.commissioningBreaches++;
  }

  const toRow = (a: Acc) => ({
    applications: a.apps,
    feasibility: stat(a.d.feasibility, a.d.pending.feasibility), inspection: stat(a.d.inspection, a.d.pending.inspection),
    meter: stat(a.d.meter, a.d.pending.meter), commissioning: stat(a.d.commissioning, a.d.pending.commissioning),
    breaches: { commissioning: a.commissioningBreaches, feasibility: a.feasibilityBreaches, total: a.commissioningBreaches + a.feasibilityBreaches },
  });
  const rows: DiscomStageAgeingRow[] = [...groups.entries()].map(([key, a]) => {
    const d = key === '∅' ? null : discomBy.get(key) ?? null;
    return { discom_id: key === '∅' ? null : key, discom_code: d?.code ?? null, discom_name: d?.name ?? 'No DISCOM recorded', ...toRow(a) };
  }).sort((a, b) => b.applications - a.applications || a.discom_name.localeCompare(b.discom_name));
  return { rows, totals: toRow(total), generated_at: ctx.now().toISOString() };
}

