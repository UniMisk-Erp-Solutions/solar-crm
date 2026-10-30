import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { PiSummary, Quotation, SalesOrderSummary } from '@solar/shared';
import { StatusBadge } from '@/components/domain/status';
import { Money } from '@/components/domain/values';
import { ModulePage } from '@/components/layout/ModulePage';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { FilterPills, SearchInput } from '@/components/ui/filters';
import { Card, CardBody, CardHeader } from '@/components/ui/surface';
import { errorMessage } from '@/lib/api';
import { useDebounced, useUrlState } from '@/lib/hooks';
import { useAction, useList } from '@/lib/query';

const PI_PILLS = [
  { value: 'prep', label: 'To prepare', status: 'draft,pending_approval' },
  { value: 'issued', label: 'Issued', status: 'issued,partially_paid' },
  { value: 'paid', label: 'Paid', status: 'paid' },
  { value: 'cancelled', label: 'Cancelled', status: 'cancelled' },
];
const SO_PILLS = [
  { value: 'hold', label: 'On hold', status: 'on_hold' },
  { value: 'approval', label: 'In approval', status: 'draft,pending_approval' },
  { value: 'approved', label: 'Approved', status: 'approved' },
  { value: 'dispatch', label: 'With dispatch', status: 'dispatch_planning,partially_dispatched,dispatched' },
  { value: 'closed', label: 'Closed', status: 'closed,cancelled' },
];

export default function OrdersModule() {
  return <ModulePage module="orders">{(section) => (section === 'orders' ? <SalesOrdersTab /> : <ProformaTab />)}</ModulePage>;
}

function ProformaTab() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [f, set] = useUrlState({ pill: 'prep', q: '' });
  const q = useDebounced(f.q);
  const pill = PI_PILLS.find((p) => p.value === f.pill) ?? PI_PILLS[0]!;
  const list = useList<PiSummary>('/pis', { status: pill.status, q: q || undefined, limit: 50, sort: 'created_at', order: 'desc' });
  const columns: Column<PiSummary>[] = [
    { key: 'no', header: t('orders.pi.no', 'PI no.'), cell: (r) => <span className="code">{r.pi_no}</span> },
    { key: 'cust', header: t('orders.customer', 'Customer'), cell: (r) => <span className="font-semibold">{r.legal_name ?? r.dealer_name ?? '—'}</span> },
    { key: 'total', header: t('orders.total', 'Total'), align: 'right', cell: (r) => <Money value={r.total} /> },
    { key: 'status', header: t('orders.status', 'Status'), cell: (r) => <StatusBadge kind="pi_status" value={r.status} /> },
    { key: 'paid', header: t('orders.paid', 'Paid so far'), align: 'right', cell: (r) => <Money value={r.paid_amount} /> },
  ];
  return (
    <div className="space-y-8">
      {pill.value === 'prep' && <AcceptedQuotes />}
      <Card>
        <CardBody className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <FilterPills label="Proforma status" value={pill.value} onChange={(v) => set({ pill: v })} options={PI_PILLS} />
            <SearchInput value={f.q} onChange={(v) => set({ q: v })} placeholder="Search PI number or customer" className="w-72" />
          </div>
          <DataTable
            rows={list.data?.data} rowKey={(r) => r.id} columns={columns} loading={list.isLoading} error={list.error?.message} onRetry={() => void list.refetch()}
            onRowClick={(r) => nav(`/orders/pi/${r.id}`)} caption="Proforma invoices"
            empty={{ title: 'No proforma invoices here', description: 'Accept a quotation first, then prepare its proforma invoice.' }}
          />
        </CardBody>
      </Card>
    </div>
  );
}

/** Accepted quotations that do not have a proforma invoice yet — step 28 starts here. */
function AcceptedQuotes() {
  const nav = useNavigate();
  const quotes = useList<Quotation & { customer_name?: string | null }>('/quotes', { status: 'accepted', latest_only: 'true', limit: 20 });
  const pis = useList<PiSummary>('/pis', { limit: 200 });
  const make = useAction<{ quote_id: string }, { id: string }>({ path: '/pis', invalidate: ['/pis'], toastError: false, onSuccess: (pi) => nav(`/orders/pi/${pi.id}`) });
  const have = new Set((pis.data?.data ?? []).filter((p) => p.status !== 'cancelled').map((p) => p.quote_id));
  const waiting = (quotes.data?.data ?? []).filter((x) => !have.has(x.id));
  if (!waiting.length) return null;
  return (
    <Card>
      <CardHeader title="Accepted quotations waiting for a proforma invoice" description="Step 28 — prepare the PI from the agreed quotation." />
      <CardBody className="space-y-3">
        {waiting.map((x) => (
          <div key={x.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3 last:border-0 last:pb-0">
            <p><span className="code">{x.quote_no}</span> <span className="ml-2 text-muted">{x.customer_name ?? ''}</span> <span className="ml-2"><Money value={x.total} /></span></p>
            <Button variant="secondary" size="sm" loading={make.isPending && make.variables?.quote_id === x.id} onClick={() => make.mutate({ quote_id: x.id })}>Prepare PI</Button>
          </div>
        ))}
        {make.error && <p role="alert" className="text-sm text-danger-text">{errorMessage(make.error)}</p>}
      </CardBody>
    </Card>
  );
}

function SalesOrdersTab() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [f, set] = useUrlState({ pill: 'hold', q: '' });
  const q = useDebounced(f.q);
  const pill = SO_PILLS.find((p) => p.value === f.pill) ?? SO_PILLS[0]!;
  const list = useList<SalesOrderSummary>('/sales-orders', { status: pill.status, q: q || undefined, limit: 50, sort: 'created_at', order: 'desc' });
  const columns: Column<SalesOrderSummary>[] = [
    { key: 'no', header: t('orders.so.no', 'SO no.'), cell: (r) => <span className="code">{r.so_no}</span> },
    { key: 'cust', header: t('orders.customer', 'Customer'), cell: (r) => <span className="font-semibold">{r.customer_name ?? r.dealer_name ?? '—'}</span> },
    { key: 'total', header: t('orders.total', 'Total'), align: 'right', cell: (r) => <Money value={r.total} /> },
    { key: 'status', header: t('orders.status', 'Status'), cell: (r) => <StatusBadge kind="so_status" value={r.status} /> },
  ];
  return (
    <Card>
      <CardBody className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <FilterPills label="Sales order status" value={pill.value} onChange={(v) => set({ pill: v })} options={SO_PILLS} />
          <SearchInput value={f.q} onChange={(v) => set({ q: v })} placeholder="Search SO number or customer PO" className="w-72" />
        </div>
        <DataTable
          rows={list.data?.data} rowKey={(r) => r.id} columns={columns} loading={list.isLoading} error={list.error?.message} onRetry={() => void list.refetch()}
          onRowClick={(r) => nav(`/orders/so/${r.id}`)} caption="Sales orders"
          empty={{ title: 'No sales orders here', description: 'A sales order is created from an issued proforma invoice.' }}
        />
      </CardBody>
    </Card>
  );
}
