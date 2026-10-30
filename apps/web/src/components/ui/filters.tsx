import { Search, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Select } from './form';

/** Search box that debounces typing and syncs with a controlled value. */
export function SearchInput({ value, onChange, placeholder = 'Search…', className, ariaLabel = 'Search' }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; ariaLabel?: string }) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  useEffect(() => {
    if (local === value) return;
    const t = window.setTimeout(() => onChange(local), 300);
    return () => window.clearTimeout(t);
  }, [local, value, onChange]);
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
      <input
        type="search" value={local} onChange={(e) => setLocal(e.target.value)} placeholder={placeholder} aria-label={ariaLabel}
        className="h-10 w-full rounded-md border border-border-strong bg-surface pl-9 pr-8 text-sm placeholder:text-subtle hover:border-primary/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-accent/40 [&::-webkit-search-cancel-button]:hidden"
      />
      {local && <button type="button" aria-label="Clear search" onClick={() => { setLocal(''); onChange(''); }} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted hover:bg-surface-2"><X className="h-4 w-4" /></button>}
    </div>
  );
}

export interface FilterOption { value: string; label: string }

/** Compact labelled select for filter bars. Empty value = "All". */
export function FilterSelect({ label, value, onChange, options, allLabel = 'All', className }: { label: string; value: string; onChange: (v: string) => void; options: FilterOption[]; allLabel?: string; className?: string }) {
  return (
    <label className={cn('flex min-w-[140px] flex-col gap-1 text-[11px] font-bold uppercase tracking-wide text-muted', className)}>
      {label}
      <Select value={value} onChange={(e) => onChange(e.target.value)} className="h-9 text-sm font-normal normal-case tracking-normal text-fg" aria-label={label}>
        <option value="">{allLabel}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    </label>
  );
}

/** Pill row for the 3–6 most common filters (e.g. status). One click, no dropdown. */
export function FilterPills({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: (FilterOption & { count?: number })[]; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button key={o.value} type="button" aria-pressed={active} onClick={() => onChange(o.value)}
            className={cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-bold transition-colors', active ? 'border-primary bg-primary text-primary-fg' : 'border-border-strong bg-surface text-muted hover:border-primary/50 hover:text-fg')}>
            {o.label}
            {o.count !== undefined && <span className={cn('tabular rounded-full px-1.5 text-[11px]', active ? 'bg-white/20' : 'bg-surface-2')}>{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function FilterBar({ children, onReset, active }: { children: ReactNode; onReset?: () => void; active?: boolean }) {
  return (
    <div className="mb-3 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
      {children}
      {onReset && active && <button type="button" onClick={onReset} className="ml-auto inline-flex h-9 items-center gap-1 rounded-md px-2 text-sm font-bold text-primary-text hover:bg-primary-soft"><X className="h-4 w-4" />Clear filters</button>}
    </div>
  );
}
