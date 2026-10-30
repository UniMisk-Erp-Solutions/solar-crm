import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { DataTable, type Column } from '@/components/ui/data-table';
import { FilterPills, SearchInput } from '@/components/ui/filters';
import { DateTimeText, Kw } from '@/components/domain/values';
import { errorMessage } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import { useList } from '@/lib/query';
import type { SurveyRow, VisitLead, VisitStage } from './types';
import VisitWorkspace from './VisitWorkspace';

const STAGE_BADGE: Record<VisitStage, { label: string; tone: 'warning' | 'info' | 'success' }> = {
  todo: { label: 'To schedule', tone: 'warning' }, scheduled: { label: 'Scheduled', tone: 'info' }, done: { label: 'Done', tone: 'success' },
};

interface Row { lead: VisitLead; survey: SurveyRow | null; stage: VisitStage }

export default function VisitsTab() {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [pill, setPill] = useState<VisitStage>('todo');
  const [openId, setOpenId] = useState<string | null>(null);
  const close = useCallback(() => setOpenId(null), []);
  const dq = useDebounced(q);
  const leads = useList<VisitLead>('/leads', { status: 'qualified,site_visit,opportunity,won,nurture,lost', q: dq || undefined, limit: 200 });
  const surveys = useList<SurveyRow>('/surveys', { limit: 200 });

  const rows = useMemo<Row[]>(() => {
    const latest = new Map<string, SurveyRow>();
    for (const s of surveys.data?.data ?? []) if (s.status !== 'cancelled' && !latest.has(s.lead_id)) latest.set(s.lead_id, s);
    return (leads.data?.data ?? []).map((lead) => {
      const survey = latest.get(lead.id) ?? null;
      // a lead that has already become an opportunity (or a win) stays in Done: the visit was done, the lead only moved on
      const moved = ['opportunity', 'won', 'nurture', 'lost'].includes(lead.status);
      const stage: VisitStage = survey?.status === 'completed' || moved ? 'done' : survey?.status === 'scheduled' ? 'scheduled' : 'todo';
      return { lead, survey, stage };
    });
  }, [leads.data, surveys.data]);

  const count = (s: VisitStage) => rows.filter((r) => r.stage === s).length;
  const shown = rows.filter((r) => r.stage === pill);
  const open = rows.find((r) => r.lead.id === openId) ?? null;

  const columns: Column<Row>[] = [
    { key: 'name', header: t('site.col.customer', 'Customer'), cell: (r) => <span className="font-semibold">{r.lead.name}</span> },
    { key: 'city', header: t('site.col.city', 'City'), cell: (r) => r.lead.city ?? '—', hideBelow: 'sm' },
    { key: 'kw', header: t('site.col.size', 'Size'), cell: (r) => <Kw value={r.lead.capacity_kw} />, align: 'right' },
    { key: 'visit', header: t('site.col.visit', 'Visit'), cell: (r) => (r.survey?.scheduled_at || r.survey?.surveyed_at ? <DateTimeText value={r.survey.surveyed_at ?? r.survey.scheduled_at} /> : <span className="text-subtle">{t('site.notScheduled', 'Not scheduled')}</span>) },
    { key: 'stage', header: t('site.col.status', 'Status'), cell: (r) => <Badge tone={STAGE_BADGE[r.stage].tone} dot>{STAGE_BADGE[r.stage].label}{r.lead.status === 'opportunity' ? ' · Opportunity' : r.lead.status === 'won' ? ' · Won' : r.lead.status === 'nurture' ? ' · Nurture' : r.lead.status === 'lost' ? ' · Lost' : ''}</Badge> },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <FilterPills label={t('site.visits.filter', 'Visit status')} value={pill} onChange={(v) => setPill(v as VisitStage)}
          options={[{ value: 'todo', label: 'To schedule', count: count('todo') }, { value: 'scheduled', label: 'Scheduled', count: count('scheduled') }, { value: 'done', label: 'Done', count: count('done') }]} />
        <SearchInput value={q} onChange={setQ} placeholder={t('site.visits.search', 'Search customer or city')} ariaLabel={t('site.visits.searchLabel', 'Search site visits')} />
      </div>
      <div className="card p-2">
        <DataTable columns={columns} rows={leads.isLoading || surveys.isLoading ? undefined : shown} rowKey={(r) => r.lead.id} loading={leads.isLoading || surveys.isLoading}
          error={leads.error ? errorMessage(leads.error) : surveys.error ? errorMessage(surveys.error) : null} onRetry={() => { void leads.refetch(); void surveys.refetch(); }}
          onRowClick={(r) => setOpenId(r.lead.id)} caption={t('site.visits.caption', 'Leads ready for a site visit')}
          empty={{ title: pill === 'todo' ? t('site.visits.emptyTodo', 'No visits waiting to be scheduled') : pill === 'scheduled' ? t('site.visits.emptyScheduled', 'No visits scheduled') : t('site.visits.emptyDone', 'No completed visits yet'), description: t('site.visits.emptyHint', 'Qualified leads appear here once the qualification call is done.') }} />
      </div>
      {open && <VisitWorkspace lead={open.lead} survey={open.survey} onClose={close} />}
    </div>
  );
}
