import { ArrowDown, ArrowRight } from 'lucide-react';
import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { MODULES, type ModuleDef } from '@/lib/modules';
import { useGet, useList } from '@/lib/query';
import { useAuth } from '@/lib/auth';

/** How many things in each module are waiting for someone right now. Each is one cheap list call; failures simply show no number. */
function useWaiting(): Record<ModuleDef['key'], number | null> {
  const leads = useList<unknown>('/leads', { status: 'unassigned,assigned', limit: 1 }, { retry: false, staleTime: 30_000 });
  const visits = useList<unknown>('/surveys', { status: 'scheduled', limit: 1 }, { retry: false, staleTime: 30_000 });
  const approvals = useGet<{ mine?: number }>('/approvals/summary', undefined, { retry: false, staleTime: 30_000 });
  const orders = useList<unknown>('/sales-orders', { status: 'on_hold,pending_approval', limit: 1 }, { retry: false, staleTime: 30_000 });
  return {
    leads: leads.data?.total ?? null,
    site: visits.data?.total ?? null,
    quotes: approvals.data?.mine ?? null,
    orders: orders.data?.total ?? null,
    control: null,
  };
}

export default function HomePage() {
  const { me } = useAuth();
  const waiting = useWaiting();
  const first = me?.profile.full_name.split(' ')[0];
  return (
    <main className="page">
      <header className="mb-12 text-center">
        <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.22em] text-primary-text">{first ? `Welcome, ${first}` : 'Welcome'}</p>
        <h1 className="text-[44px] leading-[1.08]">Where do you want to go?</h1>
        <p className="mx-auto mt-4 max-w-xl text-[16px] text-muted">One customer’s whole journey, from first enquiry to sales order. Pick a step.</p>
      </header>

      <ol className="flex flex-col items-stretch gap-3 lg:flex-row lg:items-center lg:justify-center lg:gap-2" aria-label="The flow">
        {MODULES.map((m, i) => {
          const n = waiting[m.key];
          const Icon = m.icon;
          return (
            <Fragment key={m.key}>
              <li className="lg:w-[196px]">
                <Link
                  to={m.path}
                  className="group flex h-full min-h-[212px] flex-col rounded-2xl border border-border bg-surface p-6 transition hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-pop"
                >
                  <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary-soft text-primary-text transition group-hover:bg-primary group-hover:text-primary-fg"><Icon className="h-6 w-6" aria-hidden /></span>
                  <span className="mt-5 text-[11px] font-bold uppercase tracking-[0.14em] text-subtle">{m.steps}</span>
                  <span className="display mt-1 text-[22px] font-semibold leading-tight">{m.label}</span>
                  <span className="mt-auto pt-5">
                    {n !== null && n > 0
                      ? <span className={cn('tabular inline-flex items-center rounded-full bg-fg px-3 py-1 text-xs font-bold text-white')}>{n} need{n === 1 ? 's' : ''} action</span>
                      : <span className="text-sm text-muted">{n === 0 ? 'All clear' : 'Open'}</span>}
                  </span>
                </Link>
              </li>
              {i < MODULES.length - 1 && (
                <li aria-hidden className="flex justify-center text-border-strong">
                  <ArrowRight className="hidden h-5 w-5 lg:block" />
                  <ArrowDown className="h-5 w-5 lg:hidden" />
                </li>
              )}
            </Fragment>
          );
        })}
      </ol>
    </main>
  );
}
