import { ArrowRight, Check, Circle } from 'lucide-react';
import { Fragment } from 'react';
import { formatDateTime, type LeadDetail } from '@solar/shared';
import { cn } from '@/lib/cn';

interface Node { key: string; label: string; state: 'done' | 'due' | 'later'; when: string | null; note?: string }

/**
 * The escalation path from Stage 1 of the flow chart, for the current assignment of one inquiry:
 * Assigned → Reminder 1 → DSM alert → Auto reassignment (→ Lead accepted when the distributor accepts).
 * "done" times come from what really happened; "due" times come from the running acceptance clock.
 */
export function buildTracker(d: Pick<LeadDetail, 'lead' | 'events' | 'clocks' | 'assignments'>): Node[] {
  const { lead } = d;
  // events are newest first; the current cycle is everything since the latest "assigned" event
  const cycle: LeadDetail['events'] = [];
  for (const e of d.events) { cycle.push(e); if (e.event_type === 'assigned') break; }
  const at = (type: string): string | null => cycle.find((e) => e.event_type === type)?.created_at ?? null;
  const clock = d.clocks.find((c) => c.clock_type === 'lead_acceptance');
  const step = Number((clock?.meta as { step_minutes?: number } | null)?.step_minutes);
  const reassignAt = clock && Number.isFinite(step) ? new Date(new Date(clock.due_at).getTime() + step * 60_000).toISOString() : null;
  const accepted = !!lead.accepted_at;
  const nodes: Node[] = [
    { key: 'assigned', label: 'Assigned', state: lead.assigned_at ? 'done' : 'later', when: lead.assigned_at, note: lead.distributor_name ?? undefined },
    { key: 'r1', label: 'Reminder 1', state: at('acceptance_reminder') ? 'done' : 'due', when: at('acceptance_reminder') ?? clock?.warn_at ?? null },
    { key: 'dsm', label: 'DSM alert', state: at('acceptance_breached') ? 'done' : 'due', when: at('acceptance_breached') ?? clock?.due_at ?? null },
    { key: 'reassign', label: 'Auto reassignment', state: at('auto_reassigned') ? 'done' : 'due', when: at('auto_reassigned') ?? reassignAt },
  ];
  if (accepted) return [nodes[0]!, ...nodes.slice(1).map((n) => (n.state === 'done' ? n : { ...n, state: 'later' as const, when: null })), { key: 'accepted', label: 'Lead accepted', state: 'done', when: lead.accepted_at }];
  return nodes;
}

export function AcceptanceTracker({ detail, compact }: { detail: Pick<LeadDetail, 'lead' | 'events' | 'clocks' | 'assignments'>; compact?: boolean }) {
  const nodes = buildTracker(detail);
  return (
    <ol className={cn('flex flex-wrap items-center', compact ? 'gap-1.5' : 'gap-x-2 gap-y-4')} aria-label="Acceptance and escalation path">
      {nodes.map((n, i) => (
        <Fragment key={n.key}>
          <li className="min-w-0">
            <div className={cn('flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5', n.state === 'done' ? (n.key === 'accepted' ? 'border-success/30 bg-success-soft' : n.key === 'assigned' ? 'border-primary/25 bg-primary-soft' : 'border-warning/35 bg-warning-soft') : 'border-border bg-surface')}>
              <span className={cn('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full', n.state === 'done' ? 'bg-fg text-white' : 'border border-border-strong text-subtle')}>
                {n.state === 'done' ? <Check className="h-3 w-3" aria-hidden /> : <Circle className="h-2 w-2" aria-hidden />}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold leading-tight">{n.label}</span>
                <span className="tabular mt-0.5 block text-xs text-muted">
                  {n.when ? `${n.state === 'done' ? '' : 'due '}${formatDateTime(n.when)}` : n.state === 'later' ? 'not needed' : '—'}
                </span>
                {n.note && !compact && <span className="mt-0.5 block text-xs text-subtle">{n.note}</span>}
              </span>
            </div>
          </li>
          {i < nodes.length - 1 && <li aria-hidden className="text-border-strong"><ArrowRight className="h-4 w-4" /></li>}
        </Fragment>
      ))}
    </ol>
  );
}
