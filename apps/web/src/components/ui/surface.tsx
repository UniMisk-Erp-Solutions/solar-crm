import { AlertTriangle, ChevronRight, Inbox, Info, Loader2, OctagonAlert, RefreshCw, CheckCircle2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { Button } from './button';

/* ───────── Card ───────── */
export function Card({ className, children, as: Tag = 'section' }: { className?: string; children: ReactNode; as?: 'section' | 'div' | 'article' }) {
  return <Tag className={cn('card', className)}>{children}</Tag>;
}
export function CardHeader({ title, description, actions, className, icon }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3 border-b border-border px-6 py-5', className)}>
      <div className="flex min-w-0 items-start gap-2.5">
        {icon && <span className="mt-0.5 text-primary-text">{icon}</span>}
        <div className="min-w-0">
          <h2 className="font-sans text-base font-bold leading-tight">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('p-6', className)}>{children}</div>;
}

/* ───────── Page scaffolding ───────── */
export function PageHeader({ title, subtitle, actions, breadcrumbs, badge }: {
  title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; breadcrumbs?: { label: string; to?: string }[]; badge?: ReactNode;
}) {
  return (
    <header className="mb-8">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-1.5 flex flex-wrap items-center gap-1 text-xs text-muted">
          {breadcrumbs.map((b, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              {b.to ? <Link to={b.to} className="hover:text-fg hover:underline">{b.label}</Link> : <span aria-current="page">{b.label}</span>}
              {i < breadcrumbs.length - 1 && <ChevronRight className="h-3 w-3" aria-hidden />}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[34px] leading-[1.15]">{title}</h1>
            {badge}
          </div>
          {subtitle && <p className="mt-2 max-w-2xl text-[15px] text-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <main className={cn('page', className)}>{children}</main>;
}

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mb-4 flex flex-wrap items-center gap-3', className)}>{children}</div>;
}

/* ───────── States ───────── */
export function Spinner({ className, label }: { className?: string; label?: string }) {
  return <span role="status" className={cn('inline-flex items-center gap-2 text-sm text-muted', className)}><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{label ?? <span className="sr-only">Loading</span>}</span>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton h-4 w-full', className)} aria-hidden />;
}
export function SkeletonRows({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-3', className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-9" />)}
    </div>
  );
}
export function SkeletonCards({ count = 4 }: { count?: number }) {
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" role="status" aria-label="Loading">{Array.from({ length: count }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>;
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-muted">{icon ?? <Inbox className="h-6 w-6" aria-hidden />}</span>
      <h3 className="text-base font-bold">{title}</h3>
      {description && <p className="max-w-md text-sm text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry, title = 'We could not load this' }: { message?: string; onRetry?: () => void; title?: string }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-danger-soft text-danger"><OctagonAlert className="h-6 w-6" aria-hidden /></span>
      <h3 className="text-base font-bold">{title}</h3>
      <p className="max-w-md text-sm text-muted">{message ?? 'Something went wrong. Please try again.'}</p>
      {onRetry && <Button variant="secondary" size="sm" onClick={onRetry} leftIcon={<RefreshCw className="h-4 w-4" />}>Try again</Button>}
    </div>
  );
}

/* ───────── Callout ───────── */
const CALLOUT = {
  info: { box: 'border-info/30 bg-info-soft text-info-text', icon: Info },
  success: { box: 'border-success/30 bg-success-soft text-success-text', icon: CheckCircle2 },
  warning: { box: 'border-warning/40 bg-warning-soft text-warning-text', icon: AlertTriangle },
  danger: { box: 'border-danger/40 bg-danger-soft text-danger-text', icon: OctagonAlert },
  neutral: { box: 'border-border bg-surface-2 text-fg', icon: Info },
} as const;
export function Callout({ tone = 'info', title, children, actions, className }: { tone?: keyof typeof CALLOUT; title?: ReactNode; children?: ReactNode; actions?: ReactNode; className?: string }) {
  const { box, icon: Icon } = CALLOUT[tone];
  return (
    <div role={tone === 'danger' || tone === 'warning' ? 'alert' : 'note'} className={cn('flex gap-3 rounded-lg border p-3 text-sm', box, className)}>
      <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        {title && <p className="font-bold">{title}</p>}
        {children && <div className="text-[13px] leading-relaxed [&_a]:underline">{children}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ───────── Key/value ───────── */
export function KeyValue({ items, cols = 2, className }: { items: { label: string; value: ReactNode; hidden?: boolean }[]; cols?: 1 | 2 | 3; className?: string }) {
  return (
    <dl className={cn('grid gap-x-6 gap-y-3', cols === 1 ? 'grid-cols-1' : cols === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3', className)}>
      {items.filter((i) => !i.hidden).map((i) => (
        <div key={i.label} className="min-w-0">
          <dt className="text-xs font-bold uppercase tracking-wide text-muted">{i.label}</dt>
          <dd className="mt-0.5 break-words text-sm text-fg">{i.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ───────── Stat tile with hover definition ───────── */
export function StatTile({ label, value, sub, tone = 'neutral', definition, to, icon, className }: {
  label: string; value: ReactNode; sub?: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'accent'; definition?: string; to?: string; icon?: ReactNode; className?: string;
}) {
  const bar = { neutral: 'bg-border-strong', good: 'bg-success', warn: 'bg-warning', bad: 'bg-danger', accent: 'bg-accent' }[tone];
  const body = (
    <div className={cn('group relative h-full overflow-hidden rounded-lg border border-border bg-surface p-4 shadow-card transition-shadow', to && 'hover:shadow-pop', className)} title={definition}>
      <span className={cn('absolute inset-y-0 left-0 w-1', bar)} aria-hidden />
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-wide text-muted">{label}</p>
        {icon && <span className="text-muted">{icon}</span>}
      </div>
      <p className="tabular mt-1.5 text-2xl font-bold leading-none">{value}</p>
      {sub && <p className="mt-1.5 text-xs text-muted">{sub}</p>}
      {definition && (
        <span role="tooltip" className="pointer-events-none absolute inset-x-2 bottom-2 z-10 hidden rounded-md bg-fg px-2.5 py-1.5 text-[11px] leading-snug text-bg shadow-pop group-hover:block group-focus-within:block">
          {definition}
        </span>
      )}
    </div>
  );
  return to ? <Link to={to} className="block h-full rounded-lg">{body}</Link> : body;
}
