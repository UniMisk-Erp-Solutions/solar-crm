import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatDate, formatDateTime, formatDuration, formatINR, formatINRCompact, formatKw, formatMobile, pct } from '@solar/shared';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';

export const Money = ({ value, compact, decimals, className }: { value: number | null | undefined; compact?: boolean; decimals?: number; className?: string }) => (
  <span className={cn('tabular whitespace-nowrap', className)}>{compact ? formatINRCompact(value) : formatINR(value, decimals)}</span>
);
export const DateText = ({ value, className }: { value: string | Date | null | undefined; className?: string }) => <span className={cn('tabular whitespace-nowrap', className)}>{formatDate(value)}</span>;
export const DateTimeText = ({ value, className }: { value: string | Date | null | undefined; className?: string }) => <span className={cn('tabular whitespace-nowrap', className)}>{formatDateTime(value)}</span>;
export const Kw = ({ value }: { value: number | null | undefined }) => <span className="tabular whitespace-nowrap">{formatKw(value)}</span>;
export const Pct = ({ value, decimals }: { value: number | null | undefined; decimals?: number }) => <span className="tabular">{pct(value, decimals)}</span>;

/** Mobile numbers arrive already masked from the API for roles that should not see them; the eye button asks for the audited unmask. */
export function MobileCell({ value, onUnmask, className }: { value: string | null | undefined; onUnmask?: () => Promise<string | null | undefined>; className?: string }) {
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (!shown) return;
    const t = window.setTimeout(() => setShown(null), 30_000);
    return () => window.clearTimeout(t);
  }, [shown]);
  const display = shown ?? value;
  const masked = !!display && display.includes('•');
  return (
    <span className={cn('tabular inline-flex items-center gap-1.5 whitespace-nowrap', className)}>
      {display ? (masked ? display : formatMobile(display)) : '—'}
      {masked && onUnmask && (
        <button type="button" aria-label="Reveal mobile number (this is logged)" className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-fg" onClick={async (ev) => { ev.stopPropagation(); setShown((await onUnmask()) ?? null); }}>
          <Eye className="h-3.5 w-3.5" />
        </button>
      )}
      {shown && <button type="button" aria-label="Hide number" className="rounded p-0.5 text-muted hover:bg-surface-2" onClick={(ev) => { ev.stopPropagation(); setShown(null); }}><EyeOff className="h-3.5 w-3.5" /></button>}
    </span>
  );
}

/** Live countdown to a due time. Turns amber in the last 30 % and red once overdue. */
export function SlaTimer({ due, start, label, compact }: { due: string | null | undefined; start?: string | null; label?: string; compact?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 20_000); return () => window.clearInterval(t); }, []);
  if (!due) return <span className="text-muted">—</span>;
  const dueMs = new Date(due).getTime();
  const left = dueMs - now;
  const total = start ? dueMs - new Date(start).getTime() : null;
  const overdue = left < 0;
  const tone = overdue ? 'danger' : total && left / total < 0.3 ? 'warning' : left < 2 * 3600_000 ? 'warning' : 'success';
  return (
    <Badge tone={tone} title={formatDateTime(due)}>
      {label && !compact ? `${label}: ` : ''}
      {overdue ? `Overdue ${formatDuration(left)}` : `${formatDuration(left)} left`}
    </Badge>
  );
}

/** "3 days overdue" / "in 5 days" / "today" relative to now, for dates. */
export function RelativeDay({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-muted">—</span>;
  const days = Math.round((new Date(value).getTime() - Date.now()) / 86400000);
  const text = days === 0 ? 'Today' : days > 0 ? `In ${days} d` : `${-days} d overdue`;
  return <Badge tone={days < 0 ? 'danger' : days === 0 ? 'warning' : 'neutral'}>{text}</Badge>;
}

export function Initials({ name, className }: { name: string; className?: string }) {
  const t = name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]!.toUpperCase()).join('');
  return <span className={cn('inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-xs font-bold text-primary-text', className)} aria-hidden>{t}</span>;
}
