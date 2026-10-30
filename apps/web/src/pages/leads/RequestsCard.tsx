import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LeadDetail, LeadRequestView } from '@solar/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/form';
import { Modal } from '@/components/ui/overlay';
import { Card, CardBody, CardHeader } from '@/components/ui/surface';
import { DateTimeText } from '@/components/domain/values';
import { useAction } from '@/lib/query';
import { DistributorPicker } from './DistributorPicker';

const STATUS: Record<LeadRequestView['status'], { label: string; tone: 'warning' | 'success' | 'danger' | 'neutral' }> = {
  pending: { label: 'Waiting for an answer', tone: 'warning' }, accepted: { label: 'Accepted', tone: 'success' }, rejected: { label: 'Declined', tone: 'danger' },
  expired: { label: 'No answer in time', tone: 'neutral' }, reassigned: { label: 'Closed (another distributor accepted first)', tone: 'neutral' },
};

/** Who the request went to and how each answered. Record an answer here; the first to accept gets the lead and the other requests close. */
export function RequestsCard({ detail }: { detail: LeadDetail }) {
  const { t } = useTranslation();
  const lead = detail.lead;
  const rows = [...(detail.requests ?? [])].sort((a, b) => (a.requested_at < b.requested_at ? 1 : -1));
  const [declining, setDeclining] = useState<LeadRequestView | null>(null);
  const [reason, setReason] = useState('');
  const [more, setMore] = useState(false);
  const closeDecline = useCallback(() => setDeclining(null), []);
  const accept = useAction<{ distributor_id: string }>({ path: `/leads/${lead.id}/accept`, invalidate: ['/leads', '/followups'], successMessage: t('leads.req.accepted', 'Accepted. The other requests are closed.') });
  const decline = useAction<{ reason: string; distributor_id: string }>({
    path: `/leads/${lead.id}/reject`, invalidate: ['/leads', '/followups'], successMessage: t('leads.req.declinedDone', 'Answer recorded'), onSuccess: () => { setDeclining(null); setReason(''); },
  });
  if (!rows.length) return null;
  const open = rows.filter((r) => r.status === 'pending');
  const canAskMore = ['assigned', 'unassigned'].includes(lead.status) && !lead.distributor_id;

  return (
    <Card>
      <CardHeader title={t('leads.req.cardTitle', 'Requests sent')} description={open.length ? t('leads.req.cardSub', 'Record each answer as it comes in. The first to accept gets the lead.') : t('leads.req.cardDone', 'Every request has been answered or closed.')} />
      <CardBody className="space-y-5">
        <ul className="divide-y divide-border rounded-xl border border-border">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{r.distributor_name ?? '—'}</p>
                <p className="text-xs text-muted">{t('leads.req.sentAt', 'Sent')} <DateTimeText value={r.requested_at} />{r.responded_at ? <> · {t('leads.req.answeredAt', 'answered')} <DateTimeText value={r.responded_at} /></> : null}{r.status === 'rejected' && r.reason ? ` · ${r.reason}` : ''}</p>
              </div>
              <Badge tone={STATUS[r.status].tone}>{t(`leads.req.st.${r.status}`, STATUS[r.status].label)}</Badge>
              {r.status === 'pending' && r.distributor_id && (
                <div className="flex gap-2">
                  <Button size="sm" loading={accept.isPending} aria-label={`${t('leads.req.markAccepted', 'Mark accepted')} ${r.distributor_name ?? ''}`} onClick={() => accept.mutate({ distributor_id: r.distributor_id! })}>{t('leads.req.markAccepted', 'Mark accepted')}</Button>
                  <Button size="sm" variant="secondary" aria-label={`${t('leads.req.markDeclined', 'Mark declined')} ${r.distributor_name ?? ''}`} onClick={() => setDeclining(r)}>{t('leads.req.markDeclined', 'Mark declined')}</Button>
                </div>
              )}
            </li>
          ))}
        </ul>

        {canAskMore && (more
          ? <DistributorPicker leadId={lead.id} title={t('leads.req.moreTitle', 'Send to more distributors')} onSent={() => setMore(false)} />
          : <Button variant="secondary" onClick={() => setMore(true)}>{t('leads.req.more', 'Send to more distributors')}</Button>)}
      </CardBody>

      <Modal open={!!declining} onClose={closeDecline} size="sm" title={t('leads.req.declineTitle', 'Distributor declined')} description={declining?.distributor_name ?? undefined}
        footer={<><Button variant="ghost" onClick={closeDecline}>{t('common.cancel', 'Cancel')}</Button><Button variant="danger" loading={decline.isPending} disabled={reason.trim().length < 3} onClick={() => declining?.distributor_id && decline.mutate({ reason: reason.trim(), distributor_id: declining.distributor_id })}>{t('leads.req.recordDecline', 'Record decline')}</Button></>}>
        <Field label={t('leads.req.declineWhy', 'What did they say?')} required><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>
    </Card>
  );
}
