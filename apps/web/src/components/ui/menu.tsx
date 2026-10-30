import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface MenuItem { key: string; label: ReactNode; icon?: ReactNode; onSelect?: () => void; danger?: boolean; hidden?: boolean; disabled?: boolean; divider?: boolean }

/** Small accessible dropdown menu. */
export function Menu({ trigger, items, align = 'right', label, className }: { trigger: (p: { open: boolean; toggle: () => void }) => ReactNode; items: MenuItem[]; align?: 'left' | 'right'; label: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', click);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', click); document.removeEventListener('keydown', key); };
  }, [open]);
  const visible = items.filter((i) => !i.hidden);
  return (
    <div ref={ref} className={cn('relative inline-block', className)}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div role="menu" aria-label={label} className={cn('absolute z-40 mt-1 min-w-[200px] animate-pop-in overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-pop', align === 'right' ? 'right-0' : 'left-0')}>
          {visible.map((i) =>
            i.divider ? <hr key={i.key} className="my-1 border-border" /> : (
              <button
                key={i.key} role="menuitem" type="button" disabled={i.disabled}
                onClick={() => { setOpen(false); i.onSelect?.(); }}
                className={cn('flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2 disabled:opacity-50', i.danger ? 'text-danger-text' : 'text-fg')}
              >
                {i.icon}{i.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** Hover/focus tooltip for short explanations (e.g. KPI definitions, rule source). */
export function Tip({ text, children, className }: { text: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span className={cn('group relative inline-flex', className)}>
      {children}
      <span role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 hidden w-max max-w-[260px] -translate-x-1/2 rounded-md bg-fg px-2.5 py-1.5 text-[11px] font-normal leading-snug text-bg shadow-pop group-focus-within:block group-hover:block">{text}</span>
    </span>
  );
}
