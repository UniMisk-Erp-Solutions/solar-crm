import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { FollowupListItem, LeadListItem } from '@solar/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { FilterPills } from '@/components/ui/filters';
import { Card } from '@/components/ui/surface';
import { TemperatureBadge } from '@/components/domain/status';
import { RelativeDay } from '@/components/domain/values';
import { errorMessage } from '@/lib/api';
import { useUrlState } from '@/lib/hooks';
import { useList } from '@/lib/query';
import { LogContactModal } from './LogContactModal';

const PILLS = [
  { value: 'all', label: 'All' }, { value: 'overdue', label: 'Overdue' }, { value: 'due_today', label: 'Today' }, { value: 'upcoming', label: 'Upcoming' }, { value: 'done', label: 'Done' },
];

/** Overdue follow-ups carry the escalation level the backend reached (owner, DSM, Sales Manager, Management). */
export function escalationText(level: number): string {
  return level >= 3 ? 'Overdue — escalated to Management' : level === 2 ? 'Overdue — escalated to Sales Manager' : 'Overdue — escalated to DSM';
}

export function FollowupsTab() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [f, setF] = useUrlState({ when: 'all' });
  const [logFor, setLogFor] = useState<FollowupListItem | null>(null);
  const list = useList<FollowupListItem>('/followups', f.when === 'done' ? { bucket: 'all', status: 'done', scope: 'team', limit: 100 } : { bucket: f.when, scope: 'team', limit: 100 });
  // the score is not part of the work-list row: borrow it from the leads list (optional, the column shows a dash without it)
  const leads = useList<LeadListItem>('/leads', { limit: 200, sort: 'quality_score', order: 'desc' }, { retry: false });
  const scores = useMemo(() => new Map((leads.data?.data ?? []).map((l) => [l.id, l.quality_score])), [leads.data]);
  const rows = useMemo(() => {
    const open = (list.data?.data ?? []).slice();
    const rank = (r: FollowupListItem) => (r.overdue ? 0 : new Date(r.due_at).toDateString() === new Date().toDateString() ? 1 : 2);
    return open.sort((a, b) => rank(a) - rank(b) || new Date(a.due_at).getTime() - new Date(b.due_at).getTime());
  }, [list.data]);

  const columns: Column<FollowupListItem>[] = [
    { key: 'lead', header: t('fu.col.lead', 'Lead'), cell: (r) => <span className="font-semibold">{r.lead_name}</span> },
    { key: 'temp', header: t('fu.col.temp', 'Temperature'), cell: (r) => <TemperatureBadge value={r.lead_temperature} /> },
    {
      key: 'next', header: t('fu.col.next', 'Next action'),
      cell: (r) => (
        <div className="space-y-1">
          <p>{r.note ?? '—'}</p>
          {r.overdue && <Badge tone="danger">{escalationText(r.escalated_level)}</Badge>}
        </div>
      ),
    },
    { key: 'due', header: t('fu.col.due', 'Due'), cell: (r) => <RelativeDay value={r.due_at} /> },
    { key: 'score', header: t('fu.col.score', 'Score'), align: 'right', hideBelow: 'md', cell: (r) => scores.get(r.lead_id) ?? '—' },
    { key: 'log', header: <span className="sr-only">{t('common.actions', 'Actions')}</span>, align: 'right', cell: (r) => f.when === 'done' ? null : <Button size="sm" variant="secondary" aria-label={`${t('fu.log', 'Log a contact')} — ${r.lead_name}`} onClick={(e) => { e.stopPropagation(); setLogFor(r); }}>{t('fu.log', 'Log a contact')}</Button> },
  ];

  return (
    <div className="space-y-6">
      <FilterPills label={t('fu.filter', 'Show follow-ups')} value={f.when} onChange={(v) => setF({ when: v })} options={PILLS.map((p) => ({ value: p.value, label: t(`fu.pill.${p.value}`, p.label) }))} />
      <Card>
        <DataTable
          caption={t('fu.title', 'Follow-ups')} columns={columns} rows={list.data ? rows : undefined} rowKey={(r) => r.id} loading={list.isLoading}
          error={list.isError ? errorMessage(list.error) : null} onRetry={() => void list.refetch()} onRowClick={(r) => nav(`/leads/${r.lead_id}`)}
          empty={{ title: t('fu.empty', 'Nothing to follow up'), description: t('fu.emptyHint', 'Follow-ups appear here once an inquiry has been accepted.') }}
        />
      </Card>
      {logFor && <LogContactModal open leadId={logFor.lead_id} leadName={logFor.lead_name} onClose={() => setLogFor(null)} />}
    </div>
  );
}
