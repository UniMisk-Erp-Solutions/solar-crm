import { ChevronRight } from 'lucide-react';
import { Fragment } from 'react';

/** A simple horizontal row of labelled steps; `current` is highlighted (used for the escalation path). */
export function StepRow({ steps, current }: { steps: string[]; current?: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label="Escalation path">
      {steps.map((s, i) => (
        <Fragment key={s}>
          <li
            aria-current={current === i ? 'step' : undefined}
            className={current === i ? 'rounded-full bg-accent px-3 py-1 text-sm font-bold text-white' : 'rounded-full border border-border-strong bg-surface px-3 py-1 text-sm text-muted'}
          >{s}</li>
          {i < steps.length - 1 && <ChevronRight className="h-4 w-4 text-subtle" aria-hidden />}
        </Fragment>
      ))}
    </ol>
  );
}
