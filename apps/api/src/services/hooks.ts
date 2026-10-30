import type { RuleConfig } from '@solar/shared';
import type { AppContext } from '../auth/context';
import type { ClockHandlers } from './contracts';
import type { ClockType } from '@solar/shared';

/**
 * Tiny in-process registries that let feature modules plug into kernel services
 * without the kernel importing them (e.g. the re-quote engine listens for rule changes,
 * the lead module reacts to a lead_acceptance clock breach).
 */
type RuleChangedFn = (ctx: AppContext, rule: RuleConfig, change: 'created' | 'updated' | 'activated' | 'deactivated') => Promise<void>;
const ruleChanged: RuleChangedFn[] = [];
export const onRuleChanged = (fn: RuleChangedFn): void => { ruleChanged.push(fn); };
export async function fireRuleChanged(ctx: AppContext, rule: RuleConfig, change: Parameters<RuleChangedFn>[2]): Promise<void> {
  for (const fn of ruleChanged) await fn(ctx, rule, change).catch((e) => ctx.log.error({ err: e }, 'rule-changed hook failed'));
}

const clockHandlers = new Map<ClockType, ClockHandlers>();
export const registerClockHandlers = (type: ClockType, handlers: ClockHandlers): void => { clockHandlers.set(type, handlers); };
export const getClockHandlers = (type: ClockType): ClockHandlers | undefined => clockHandlers.get(type);

/* ───────────── approvals: each entity type reacts to decisions in its own module ───────────── */
import type { Approval, ApprovalEntity } from '@solar/shared';
export type ApprovalOutcome = 'step_approved' | 'lane_approved' | 'rejected';
type ApprovalHandler = (ctx: AppContext, approval: Approval, outcome: ApprovalOutcome) => Promise<void>;
const approvalHandlers = new Map<ApprovalEntity, ApprovalHandler>();
/** Register at module load, e.g. registerApprovalHandler('proforma_invoice', onPiApproval). The approvals module calls it after every decision. */
export const registerApprovalHandler = (entity: ApprovalEntity, fn: ApprovalHandler): void => { approvalHandlers.set(entity, fn); };
export const getApprovalHandler = (entity: ApprovalEntity): ApprovalHandler | undefined => approvalHandlers.get(entity);

/* ───────────── nightly / scheduled jobs contributed by feature modules ───────────── */
export interface JobDef { name: string; /** cron expression in Asia/Kolkata, e.g. '0 2 * * *' */ schedule: string; run(ctx: AppContext): Promise<Record<string, unknown> | void> }
const jobs = new Map<string, JobDef>();
/** Register at module load. The job runner (jobs/index.ts) executes every registered job per organisation and records a job_runs row. */
export const registerJob = (job: JobDef): void => { jobs.set(job.name, job); };
export const registeredJobs = (): JobDef[] => [...jobs.values()];
