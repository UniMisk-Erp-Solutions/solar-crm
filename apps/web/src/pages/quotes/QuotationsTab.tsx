import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { Quotation } from '@solar/shared';
import { DataTable, type Column } from '@/components/ui/data-table';
import { FilterPills, SearchInput } from '@/components/ui/filters';
import { DateText, Money } from '@/components/domain/values';
import { StatusBadge } from '@/components/domain/status';
import { errorMessage } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import { useList } from '@/lib/query';

type QuoteRow = Quotation & { customer_name?: string | null; opportunity_name?: string | null };

/** The four pills group the quote statuses into the words the flow uses. */
const GROUPS: Record<string, string> = {
  draft: 'draft,blocked,price_review,pending_approval,approved',
  sent: 'sent,negotiation',
  accepted: 'accepted',
  revision: 'rejected,requote_required,expired',
};

export default function QuotationsTab() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [pill, setPill] = useState('draft');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const list = useList<QuoteRow>('/quotes', { status: GROUPS[pill], latest_only: true, q: dq || undefined, limit: 100, sort: 'created_at' });

  const columns: Column<QuoteRow>[] = [
    { key: 'no', header: t('quotes.col.no', 'Quotation'), cell: (r) => <span className="code font-semibold">{r.quote_no}{r.version > 1 ? ` v${r.version}` : ''}</span> },
    { key: 'cust', header: t('quotes.col.customer', 'Customer'), cell: (r) => r.customer_name ?? r.opportunity_name ?? '—' },
    { key: 'total', header: t('quotes.col.total', 'Total'), cell: (r) => <Money value={r.total} />, align: 'right' },
    { key: 'status', header: t('quotes.col.status', 'Status'), cell: (r) => <StatusBadge kind="quote_status" value={r.status} /> },
    { key: 'valid', header: t('quotes.col.valid', 'Valid until'), cell: (r) => <DateText value={r.validity_date} />, hideBelow: 'sm' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <FilterPills label={t('quotes.filter', 'Quotation status')} value={pill} onChange={setPill}
          options={[{ value: 'draft', label: 'Draft' }, { value: 'sent', label: 'Sent' }, { value: 'accepted', label: 'Accepted' }, { value: 'revision', label: 'Needs revision' }]} />
        <SearchInput value={q} onChange={setQ} placeholder={t('quotes.search', 'Search quotation number')} ariaLabel={t('quotes.searchLabel', 'Search quotations')} />
      </div>
      <div className="card p-2">
        <DataTable columns={columns} rows={list.data?.data} rowKey={(r) => r.id} loading={list.isLoading} error={list.error ? errorMessage(list.error) : null} onRetry={() => void list.refetch()}
          onRowClick={(r) => navigate(`/quotes/${r.id}`)} caption={t('quotes.caption', 'Quotations')}
          empty={{ title: t('quotes.empty', 'No quotations here'), description: pill === 'draft' ? t('quotes.emptyHint', 'Use New quotation to start one from an opportunity.') : undefined }} />
      </div>
    </div>
  );
}
