import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** One collapsible card of the visit workspace. The parent keeps only one open at a time. */
export function Step({ id, no, title, summary, open, onToggle, children }: {
  id: string; no: string; title: string; summary?: ReactNode; open: boolean; onToggle: () => void; children: ReactNode;
}) {
  return (
    <section className="card overflow-hidden">
      <button type="button" aria-expanded={open} aria-controls={`${id}-body`} onClick={onToggle}
        className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left hover:bg-surface-2">
        <span className="flex min-w-0 items-center gap-4">
          <span className="code flex h-9 min-w-9 items-center justify-center rounded-full bg-primary-soft px-2 text-sm font-semibold text-primary-text">{no}</span>
          <span className="min-w-0">
            <span className="block text-base font-bold">{title}</span>
            {summary && <span className="block text-sm text-muted">{summary}</span>}
          </span>
        </span>
        <ChevronDown className={cn('h-5 w-5 shrink-0 text-muted transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && <div id={`${id}-body`} className="space-y-5 border-t border-border p-6">{children}</div>}
    </section>
  );
}
