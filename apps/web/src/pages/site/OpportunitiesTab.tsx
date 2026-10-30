import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DataTable, type Column } from '@/components/ui/data-table';
import { FilterPills, SearchInput } from '@/components/ui/filters';
import { DateText, Kw, Money, Pct } from '@/components/domain/values';
import { StatusBadge } from '@/components/domain/status';
import { errorMessage } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import { useList } from '@/lib/query';
import type { OpportunityRow } from './types';
import OpportunityDrawer from './OpportunityDrawer';

const STAGES: Record<string, string> = { open: 'qualified,quotation,negotiation,pi_stage', won: 'won', lost: 'lost' };

export default function OpportunitiesTab() {
  const { t } = useTranslation();
  const [pill, setPill] = useState('open');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const close = useCallback(() => setOpenId(null), []);
  const dq = useDebounced(q);
  const list = useList<OpportunityRow>('/opportunities', { stage: STAGES[pill], q: dq || undefined, limit: 100, sort: 'expected_close_date' });
  const open = list.data?.data.find((o) => o.id === openId) ?? null;

  const columns: Column<OpportunityRow>[] = [
    { key: 'name', header: t('site.opp.name', 'Opportunity'), cell: (o) => <span className="font-semibold">{o.name}</span> },
    { key: 'kw', header: t('site.opp.size', 'Size'), cell: (o) => <Kw value={o.kw} />, align: 'right' },
    { key: 'rev', header: t('site.opp.revenue', 'Expected revenue'), cell: (o) => <Money value={o.expected_value} />, align: 'right' },
    { key: 'prob', header: t('site.opp.prob', 'Probability'), cell: (o) => <Pct value={o.probability} />, align: 'right', hideBelow: 'sm' },
    { key: 'close', header: t('site.opp.close', 'Expected closing'), cell: (o) => <DateText value={o.expected_close_date} />, hideBelow: 'md' },
    { key: 'stage', header: t('site.opp.stage', 'Stage'), cell: (o) => <StatusBadge kind="opportunity_stage" value={o.stage} /> },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <FilterPills label={t('site.opp.filter', 'Opportunity status')} value={pill} onChange={setPill}
          options={[{ value: 'open', label: 'Open' }, { value: 'won', label: 'Won' }, { value: 'lost', label: 'Lost' }]} />
        <SearchInput value={q} onChange={setQ} placeholder={t('site.opp.search', 'Search opportunity')} ariaLabel={t('site.opp.searchLabel', 'Search opportunities')} />
      </div>
      <div className="card p-2">
        <DataTable columns={columns} rows={list.data?.data} rowKey={(o) => o.id} loading={list.isLoading} error={list.error ? errorMessage(list.error) : null} onRetry={() => void list.refetch()}
          onRowClick={(o) => setOpenId(o.id)} caption={t('site.opp.caption', 'Opportunities')}
          empty={{ title: t('site.opp.empty', 'No opportunities here'), description: pill === 'open' ? t('site.opp.emptyHint', 'Convert a qualified lead from Site visits to start one.') : undefined }} />
      </div>
      {open && <OpportunityDrawer key={open.id} opp={open} onClose={close} />}
    </div>
  );
}
