import { entityPath, formatDuration, type AppRole, type Clock, type ClockType, type Json, type Profile } from '@solar/shared';
import type { AppContext } from '../auth/context';
import type { AppDeps } from '../deps';
import { buildContext, systemUser } from '../deps';
import { audit } from '../lib/audit';
import type { ClockService, StartClockInput } from './contracts';
import { getClockHandlers } from './hooks';

export const CLOCK_LABEL: Record<ClockType, string> = {
  lead_acceptance: 'Lead acceptance', followup: 'Follow-up', quote_followup: 'Quote follow-up', approval: 'Approval', discom_feasibility: 'DISCOM feasibility (deemed after 15 days)',
  discom_commissioning: 'DISCOM commissioning', cfa_release: 'CFA release', legacy_cfa_claim_deadline: 'Legacy CFA claim deadline', sop_reply: 'MNRE SOP — vendor reply', sop_show_cause: 'MNRE SOP — show-cause',
  grievance: 'Grievance resolution', loan_ageing: 'Loan ageing', warranty_rma: 'Warranty / RMA turnaround', almm_exemption_commissioning: 'ALMM List-II exemption — commissioning date', payment_reminder: 'Payment reminder',
};

const asDate = (v: Date | string): Date => (typeof v === 'string' ? new Date(v) : v);

export function createClockService(ctx: AppContext): ClockService {
  const repo = () => ctx.db.table('clocks');
  return {
    async start(input: StartClockInput) {
      const started = input.started_at ? asDate(input.started_at) : ctx.now();
      const due = asDate(input.due_at);
      const open = await repo().all({ entity_type: input.entity_type, entity_id: input.entity_id, clock_type: input.clock_type, resolved_at: null });
      for (const c of open) {
        await repo().update(c.id, c.status === 'running' ? { status: 'cancelled', resolved_at: ctx.now().toISOString() } : { resolved_at: ctx.now().toISOString() });
      }
      const warn = input.warn_at === null ? null : input.warn_at ? asDate(input.warn_at) : new Date(started.getTime() + (due.getTime() - started.getTime()) * 0.7);
      return repo().insert({
        entity_type: input.entity_type, entity_id: input.entity_id, clock_type: input.clock_type, started_at: started.toISOString(), due_at: due.toISOString(),
        warn_at: warn ? warn.toISOString() : null, status: 'running', escalated_level: 0, owner_id: input.owner_id ?? null, warned_at: null, breached_at: null, resolved_at: null,
        last_escalated_at: null, meta: (input.meta ?? {}) as Json, created_by: ctx.system ? null : ctx.user.id,
      });
    },

    async complete(entity_type, entity_id, clock_type, meta) {
      const open = await repo().all({ entity_type, entity_id, clock_type, resolved_at: null });
      let last: Clock | null = null;
      const now = ctx.now().toISOString();
      for (const c of open) {
        last = await repo().update(c.id, {
          status: c.status === 'running' ? 'met' : c.status, // a clock that already breached stays 'breached' for KPI purposes
          resolved_at: now, meta: meta ? ({ ...(c.meta as Record<string, Json>), ...(meta as Record<string, Json>) } as Json) : c.meta,
        });
      }
      return last;
    },

    async cancel(entity_type, entity_id, clock_type) {
      const open = await repo().all({ entity_type, entity_id, resolved_at: null, ...(clock_type ? { clock_type } : {}) });
      for (const c of open) await repo().update(c.id, { status: 'cancelled', resolved_at: ctx.now().toISOString() });
      return open.length;
    },

    async forEntity(entity_type, entity_id) {
      return repo().all({ entity_type, entity_id }, { orderBy: { col: 'started_at', dir: 'desc' } });
    },
  };
}

/* ───────────── escalation targets ───────────── */
async function dsmFor(ctx: AppContext, owner: Profile | null): Promise<string[]> {
  const dsms = await ctx.db.table('profiles').all({ role: 'dsm', active: true });
  if (!owner) return dsms.map((d) => d.id);
  const sameTerritory = dsms.filter((d) => d.territory_ids.some((t) => owner.territory_ids.includes(t)));
  if (sameTerritory.length) return sameTerritory.map((d) => d.id);
  if (owner.reports_to) return [owner.reports_to];
  return dsms.map((d) => d.id);
}

/** Level 0 = warning to owner, 1 = owner + DSM, 2 = Sales Manager, 3 = Management. */
export async function escalationTargets(ctx: AppContext, clock: Clock, level: number): Promise<{ user_ids: string[]; roles: AppRole[] }> {
  const owner = clock.owner_id ? await ctx.db.table('profiles').get(clock.owner_id) : null;
  const ids: string[] = owner ? [owner.id] : [];
  if (level === 1) ids.push(...(await dsmFor(ctx, owner)));
  if (level === 0 && !owner) ids.push(...(await dsmFor(ctx, null)));
  const roles: AppRole[] = level === 2 ? ['sales_manager'] : level >= 3 ? ['management'] : [];
  return { user_ids: [...new Set(ids)], roles };
}

export interface TickResult { warned: number; breached: number; escalated: number; scanned: number }

/** Cron entry point (every minute): warn at 70 %, mark breaches at 100 %, then escalate level by level. */
export async function tickClocks(deps: AppDeps, now: Date = deps.now()): Promise<TickResult> {
  const result: TickResult = { warned: 0, breached: 0, escalated: 0, scanned: 0 };
  const orgs = await deps.db.table('organizations').all();
  for (const org of orgs) {
    const ctx = buildContext(deps, org.id, systemUser(org.id), { system: true, requestId: `tick-${now.getTime()}`, now: () => now });
    const clocks = await ctx.db.table('clocks').all({ status: ['running', 'breached'], resolved_at: null });
    const stepMin = await ctx.svc.rules.value<number>('sla.escalation_step_minutes', now, 240);
    for (const c of clocks) {
      result.scanned++;
      const handlers = getClockHandlers(c.clock_type);
      const label = CLOCK_LABEL[c.clock_type];
      const link = entityPath(c.entity_type, c.entity_id);
      try {
        if (c.status === 'running') {
          if (c.warn_at && !c.warned_at && now >= new Date(c.warn_at) && now < new Date(c.due_at)) {
            const left = formatDuration(new Date(c.due_at).getTime() - now.getTime());
            const t = await escalationTargets(ctx, c, 0);
            await ctx.svc.notify.notify({ ...t, kind: `clock.${c.clock_type}.warn`, title: `${label} — ${left} left`, body: '70% of the allowed time has passed.', severity: 'warning', link, entity_type: c.entity_type, entity_id: c.entity_id });
            await ctx.db.table('clocks').update(c.id, { warned_at: now.toISOString() });
            await handlers?.onWarn?.(ctx, c);
            result.warned++;
          }
          if (now >= new Date(c.due_at)) {
            // the warning always comes first: when a tick lands after both the 70 % mark and the deadline (short SLAs), send it now rather than skip it
            if (c.warn_at && !c.warned_at) { await handlers?.onWarn?.(ctx, c); result.warned++; }
            const t = await escalationTargets(ctx, c, 1);
            const breached = await ctx.db.table('clocks').update(c.id, { status: 'breached', breached_at: now.toISOString(), escalated_level: 1, last_escalated_at: now.toISOString(), warned_at: c.warned_at ?? now.toISOString() });
            await ctx.svc.notify.notify({ ...t, kind: `clock.${c.clock_type}.breach`, title: `${label} — time is up`, body: 'This has passed its deadline and has been escalated to the DSM.', severity: 'critical', link, entity_type: c.entity_type, entity_id: c.entity_id });
            await audit(ctx, { action: 'clock.breached', table: 'clocks', record_id: c.id, detail: { clock_type: c.clock_type, entity_type: c.entity_type, entity_id: c.entity_id } as Json });
            await handlers?.onBreach?.(ctx, breached);
            result.breached++;
          }
        } else if (c.status === 'breached' && c.escalated_level < 3) {
          const total = new Date(c.due_at).getTime() - new Date(c.started_at).getTime();
          const custom = Number((c.meta as { step_minutes?: unknown } | null)?.step_minutes);
          // a clock can carry its own escalation step (lead acceptance does: Reminder 1 → DSM alert → auto-reassignment on its own timing)
          const step = (Number.isFinite(custom) && custom > 0 ? custom : Math.min(24 * 60, Math.max(stepMin ?? 240, Math.round((total / 60000) * 0.5)))) * 60000;
          const last = c.last_escalated_at ? new Date(c.last_escalated_at).getTime() : new Date(c.breached_at ?? c.due_at).getTime();
          if (now.getTime() - last >= step) {
            const level = c.escalated_level + 1;
            const t = await escalationTargets(ctx, c, level);
            const esc = await ctx.db.table('clocks').update(c.id, { escalated_level: level, last_escalated_at: now.toISOString() });
            await ctx.svc.notify.notify({ ...t, kind: `clock.${c.clock_type}.level${level}`, title: `${label} — escalated to ${level === 2 ? 'Sales Manager' : 'Management'}`, body: 'Still unresolved after the previous escalation.', severity: 'critical', link, entity_type: c.entity_type, entity_id: c.entity_id });
            await handlers?.onEscalate?.(ctx, esc, level);
            result.escalated++;
          }
        }
      } catch (e) {
        ctx.log.error({ err: e, clock: c.id }, 'clock tick failed for one clock');
      }
    }
  }
  return result;
}
