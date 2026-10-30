import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface TabDef { key: string; label: ReactNode; count?: number; hidden?: boolean }

/** Accessible tab list (arrow keys, roving tabindex). Content is rendered by the caller based on `value`. */
export function Tabs({ tabs, value, onChange, className, variant = 'underline' }: { tabs: TabDef[]; value: string; onChange: (key: string) => void; className?: string; variant?: 'underline' | 'pills' }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const visible = tabs.filter((t) => !t.hidden);
  const onKey = (e: KeyboardEvent, i: number) => {
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % visible.length;
    if (e.key === 'ArrowLeft') n = (i - 1 + visible.length) % visible.length;
    if (e.key === 'Home') n = 0;
    if (e.key === 'End') n = visible.length - 1;
    if (n >= 0) { e.preventDefault(); refs.current[n]?.focus(); onChange(visible[n]!.key); }
  };
  return (
    <div role="tablist" className={cn('flex gap-8 overflow-x-auto', variant === 'underline' ? 'border-b border-border' : 'rounded-lg bg-surface-2 p-1', className)}>
      {visible.map((t, i) => {
        const active = t.key === value;
        return (
          <button
            key={t.key} ref={(el) => { refs.current[i] = el; }} role="tab" type="button" aria-selected={active} tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.key)} onKeyDown={(e) => onKey(e, i)}
            className={cn(
              'inline-flex items-center gap-2 whitespace-nowrap px-1 py-3 text-[15px] font-semibold transition-colors',
              variant === 'underline'
                ? cn('-mb-px border-b-2', active ? 'border-primary text-fg' : 'border-transparent text-muted hover:text-fg')
                : cn('rounded-md', active ? 'bg-surface text-primary-text shadow-card' : 'text-muted hover:text-fg'),
            )}
          >
            {t.label}
            {t.count !== undefined && <span className={cn('tabular rounded-full px-1.5 text-[11px]', active ? 'bg-primary-soft text-primary-text' : 'bg-surface-2 text-muted')}>{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
