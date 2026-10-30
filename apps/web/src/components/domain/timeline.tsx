import type { ReactNode } from 'react';
import { formatDateTime } from '@solar/shared';
import { cn } from '@/lib/cn';
import type { Tone } from '@/components/ui/badge';

export interface TimelineItem { id: string; at: string; title: ReactNode; detail?: ReactNode; actor?: string | null; tone?: Tone; icon?: ReactNode }

const DOT: Record<Tone, string> = {
  neutral: 'bg-border-strong', primary: 'bg-primary', accent: 'bg-accent', success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger', info: 'bg-info',
};

export function Timeline({ items, className, empty = 'No activity yet.' }: { items: TimelineItem[]; className?: string; empty?: string }) {
  if (!items.length) return <p className="py-6 text-center text-sm text-muted">{empty}</p>;
  return (
    <ol className={cn('relative space-y-4 border-l border-border pl-5', className)}>
      {items.map((i) => (
        <li key={i.id} className="relative">
          <span className={cn('absolute -left-[25px] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-surface', DOT[i.tone ?? 'neutral'])} aria-hidden />
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <p className="text-sm font-bold">{i.title}</p>
            <time className="tabular text-xs text-muted" dateTime={i.at}>{formatDateTime(i.at)}</time>
          </div>
          {i.detail && <div className="mt-0.5 text-sm text-muted">{i.detail}</div>}
          {i.actor && <p className="mt-0.5 text-xs text-subtle">by {i.actor}</p>}
        </li>
      ))}
    </ol>
  );
}
