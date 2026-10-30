import { ChevronRight } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import type { FunnelDashboard, Kpi, SlaDashboard } from '@solar/shared';
import { istDateString } from '@solar/shared';
import { FilterPills } from '@/components/ui/filters';
import { Card, CardBody, ErrorState, SkeletonRows } from '@/components/ui/surface';
import { useGet } from '@/lib/query';

const DAYS = [{ value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }];

const KPI_DEFS: { key: string; source: 'funnel' | 'sla'; label: string; definition: string }[] = [
  { key: 'conv_inquiry_to_qualified', source: 'funnel', label: 'Inquiry to Qualified Lead', definition: 'Of all valid inquiries received, the share that became a qualified lead.' },
  { key: 'conv_qualified_to_opportunity', source: 'funnel', label: 'Qualified Lead to Opportunity', definition: 'Of qualified leads, the share converted to an opportunity.' },
  { key: 'conv_opportunity_to_quotation', source: 'funnel', label: 'Opportunity to Quotation', definition: 'Of opportunities, the share that received a quotation.' },
  { key: 'conv_quotation_to_pi', source: 'funnel', label: 'Quotation to PI', definition: 'Of quotations, the share that reached a proforma invoice.' },
  { key: 'conv_pi_to_sales_order', source: 'funnel', label: 'PI to Sales Order', definition: 'Of proforma invoices, the share that became a sales order.' },
  { key: 'first_response_24h_pct', source: 'sla', label: 'First response SLA', definition: 'Leads that got a first reply within the response window (24 hours; Hot leads in 30 minutes).' },
  { key: 'followup_compliance_pct', source: 'sla', label: 'Follow-up compliance', definition: 'Follow-ups completed on or before their due time.' },
];

const fmt = (k: Kpi | undefined) => (k?.value == null ? '—' : `${k.value.toFixed(k.value % 1 === 0 ? 0 : 1)}%`);

export default function KpisTab() {
  const [days, setDays] = useState('90');
  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - (Number(days) - 1) * 86_400_000);
    return { from: istDateString(from), to: istDateString(to) };
  }, [days]);
  const funnel = useGet<FunnelDashboard>('/dashboards/funnel', range);
  const sla = useGet<SlaDashboard>('/dashboards/sla', range);
  const err = funnel.error ?? sla.error;

  return (
    <div className="space-y-8">
      <FilterPills label="Date range" value={days} onChange={setDays} options={DAYS} />
      {err ? <ErrorState message={err.message} onRetry={() => { void funnel.refetch(); void sla.refetch(); }} />
        : funnel.isLoading || sla.isLoading ? <SkeletonRows />
        : (
          <>
            <Card>
              <CardBody>
                <h2 className="mb-5 text-xl">Conversion gates</h2>
                <ol className="flex flex-wrap items-stretch gap-2" aria-label="Conversion gates">
                  {(funnel.data?.gates ?? []).map((g, i, all) => (
                    <Fragment key={g.key}>
                      <li className="min-w-[130px] flex-1 rounded-xl border border-border bg-surface-2 px-4 py-4 text-center">
                        <p className="display tabular text-3xl">{g.count}</p>
                        <p className="mt-1 text-sm font-semibold">{g.label}</p>
                      </li>
                      {i < all.length - 1 && <ChevronRight className="my-auto h-5 w-5 shrink-0 text-subtle" aria-hidden />}
                    </Fragment>
                  ))}
                </ol>
              </CardBody>
            </Card>
            <section aria-label="The seven KPIs" className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
              {KPI_DEFS.map((d) => {
                const k = (d.source === 'funnel' ? funnel.data : sla.data)?.kpis.find((x) => x.key === d.key);
                return (
                  <article key={d.key} className="card p-6">
                    <h3 className="font-sans text-sm font-bold text-muted">{d.label}</h3>
                    <p className="display tabular mt-3 text-[40px] leading-none">{fmt(k)}</p>
                    <p className="mt-4 text-sm text-muted">{d.definition}</p>
                    {k?.target && <p className="mt-2 text-xs text-subtle">Target: {k.target.direction === 'at_least' ? 'at least' : 'at most'} {k.target.value}%</p>}
                  </article>
                );
              })}
            </section>
          </>
        )}
    </div>
  );
}
