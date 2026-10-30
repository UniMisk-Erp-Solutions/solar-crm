import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { LeadListItem } from '@solar/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { SearchInput } from '@/components/ui/filters';
import { Field, Textarea } from '@/components/ui/form';
import { Modal } from '@/components/ui/overlay';
import { Card } from '@/components/ui/surface';
import { Kw, SlaTimer } from '@/components/domain/values';
import { errorMessage } from '@/lib/api';
import { useUrlState } from '@/lib/hooks';
import { useAction, useList } from '@/lib/query';
import { AssignControl } from './AssignControl';
import { NewInquiryDrawer } from './NewInquiryDrawer';
import { INQUIRY_PILLS, acceptanceNote, sourceLabel, stageOf } from './leadUi';

export function InquiriesTab({ newOpen, setNewOpen }: { newOpen: boolean; setNewOpen: (v: boolean) => void }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [f, setF] = useUrlState({ show: 'all', q: '' });
  const pill = INQUIRY_PILLS.find((p) => p.value === f.show) ?? INQUIRY_PILLS[0]!;
  const list = useList<LeadListItem>('/leads', { status: pill.status, sla_state: pill.sla_state, q: f.q || undefined, sort: 'created_at', order: 'desc', limit: 50 });
  // "Awaiting acceptance" is the assigned inquiries that are still inside their window; the missed ones are in the loop box.
  const rows = f.show === 'awaiting' ? list.data?.data.filter((l) => l.sla_state !== 'breached') : list.data?.data;

  const accept = useAction<string, LeadListItem>({ path: (id) => `/leads/${id}/accept`, invalidate: ['/leads', '/followups'], successMessage: t('leads.accepted', 'Inquiry accepted') });
  const [rejecting, setRejecting] = useState<LeadListItem | null>(null);
  const [assigning, setAssigning] = useState<LeadListItem | null>(null);
  const [reason, setReason] = useState('');
  const reject = useAction<{ id: string; reason: string }>({
    path: (i) => `/leads/${i.id}/reject`, invalidate: ['/leads', '/followups'], successMessage: t('leads.rejected', 'Rejected — the system offers it to the next best distributor'),
    onSuccess: () => { setRejecting(null); setReason(''); },
  });

  const columns: Column<LeadListItem>[] = [
    { key: 'name', header: t('leads.col.name', 'Inquiry'), cell: (l) => <div><div className="font-semibold">{l.name}</div><div className="text-xs text-muted">{sourceLabel(l.source)}{l.city ? ` · ${l.city}` : ''}</div></div> },
    { key: 'kw', header: t('leads.col.kw', 'Size'), align: 'right', hideBelow: 'md', cell: (l) => <Kw value={l.capacity_kw} /> },
    {
      key: 'stage', header: t('leads.col.stage', 'Where it is'),
      cell: (l) => {
        const s = stageOf(l);
        return (
          <div className="flex flex-col items-start gap-1.5">
            <Badge tone={s.tone}>{s.step ? `${s.step} · ` : ''}{s.label}</Badge>
            {l.status === 'assigned' && <SlaTimer due={l.sla_due_at} start={l.assigned_at} compact />}
            {acceptanceNote(l) && <span className="text-xs text-muted">{acceptanceNote(l)!.text}</span>}
          </div>
        );
      },
    },
    { key: 'assigned', header: t('leads.col.assigned', 'Assigned to'), hideBelow: 'md', cell: (l) => l.distributor_name ?? <span className="text-muted">—</span> },
    {
      key: 'actions', header: <span className="sr-only">{t('common.actions', 'Actions')}</span>, align: 'right',
      cell: (l) => {
        const s = stageOf(l);
        if (l.status === 'assigned' && !l.distributor_id) {
          // the request went to several distributors: the answers are recorded on the inquiry page
          return <div className="flex justify-end" onClick={(e) => e.stopPropagation()}><Button size="sm" variant="soft" aria-label={`${t('leads.req.record', 'Record answers')} ${l.name}`} onClick={() => nav(`/leads/${l.id}`)}>{t('leads.req.record', 'Record answers')}</Button></div>;
        }
        if (l.status === 'assigned') {
          return (
            <div className="flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
              <Button size="sm" variant="soft" aria-label={`${t('leads.accept', 'Accept')} ${l.name}`} loading={accept.isPending && accept.variables === l.id} onClick={() => accept.mutate(l.id)}>{t('leads.accept', 'Accept')}</Button>
              <Button size="sm" variant="ghost" aria-label={`${t('leads.reject', 'Reject')} ${l.name}`} onClick={() => setRejecting(l)}>{t('leads.reject', 'Reject')}</Button>
            </div>
          );
        }
        if (s.step === '6' || l.status === 'validated') return <div className="flex justify-end" onClick={(e) => e.stopPropagation()}><Button size="sm" variant="accent" aria-label={`${t('leads.assign.button', 'Assign')} ${l.name}`} onClick={() => setAssigning(l)}>{t('leads.assign.button', 'Assign')}</Button></div>;
        return null;
      },
    },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="font-sans text-lg font-bold">{pill.value === 'all' ? t('leads.inquiries', 'All inquiries') : t(`leads.pill.${pill.value}`, pill.label)}</h2>
        <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
        <select aria-label={t('leads.filter', 'Show')} className="h-11 rounded-lg border border-line bg-surface px-3 text-sm" value={f.show} onChange={(e) => setF({ show: e.target.value })}>
          {INQUIRY_PILLS.map((p) => <option key={p.value} value={p.value}>{t('leads.pill.' + p.value, p.label)}</option>)}
        </select>
        <SearchInput className="w-full sm:w-72" value={f.q} onChange={(v) => setF({ q: v })} placeholder={t('leads.search', 'Search name, mobile or city')} />
        </div>
      </div>
      <Card>
        <DataTable
          caption={t('leads.inquiries', 'Inquiries')} columns={columns} rows={rows} rowKey={(l) => l.id} loading={list.isLoading}
          error={list.isError ? errorMessage(list.error) : null} onRetry={() => void list.refetch()} onRowClick={(l) => nav(`/leads/${l.id}`)}
          empty={{
            title: f.q || f.show !== 'all' ? t('leads.emptyFiltered', 'Nothing here right now') : t('leads.empty', 'No inquiries yet'),
            description: f.q || f.show !== 'all' ? t('leads.emptyFilteredHint', 'Pick another box above, or clear the search.') : t('leads.emptyHint', 'Add the first inquiry to start the flow.'),
            action: <Button variant="secondary" leftIcon={<Plus className="h-4 w-4" />} onClick={() => setNewOpen(true)}>{t('leads.new.button', 'New inquiry')}</Button>,
          }}
        />
      </Card>

      <NewInquiryDrawer open={newOpen} onClose={() => setNewOpen(false)} />
      <Modal open={!!assigning} onClose={() => setAssigning(null)} size="xl" title={t('leads.assign.title', 'Choose distributors')} description={assigning ? `${assigning.name} — pick whom to send the request to.` : undefined}>
        {assigning && <AssignControl leadId={assigning.id} onDone={() => setAssigning(null)} />}
      </Modal>
      <Modal
        open={!!rejecting} onClose={() => setRejecting(null)} size="sm" title={t('leads.reject.title', 'Reject this inquiry?')} description={rejecting?.name}
        footer={<><Button variant="ghost" onClick={() => setRejecting(null)}>{t('common.cancel', 'Cancel')}</Button><Button variant="danger" disabled={reason.trim().length < 3} loading={reject.isPending} onClick={() => rejecting && reject.mutate({ id: rejecting.id, reason: reason.trim() })}>{t('leads.reject', 'Reject')}</Button></>}
      >
        <Field label={t('leads.reject.reason', 'Reason')} required><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>
    </div>
  );
}
