import { ChevronRight, MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { LeadDetail, LeadListItem, LeadTimelineItem } from '@solar/shared';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/form';
import { Menu } from '@/components/ui/menu';
import { ConfirmDialog, Modal } from '@/components/ui/overlay';
import { Card, CardBody, CardHeader, ErrorState, Page, SkeletonRows } from '@/components/ui/surface';
import { StatusBadge, TemperatureBadge } from '@/components/domain/status';
import { Timeline, type TimelineItem } from '@/components/domain/timeline';
import { DateText, DateTimeText } from '@/components/domain/values';
import { errorMessage } from '@/lib/api';
import { useAction, useGet, useList } from '@/lib/query';
import { RecordConsentModal } from '@/components/domain/RecordConsentModal';
import { AcceptanceTracker } from './AcceptanceTracker';
import { AssignControl } from './AssignControl';
import { LogContactModal } from './LogContactModal';
import { NextActionCard } from './NextActionCard';
import { QualificationCard } from './QualificationCard';
import { acceptanceFromEvents, sourceLabel } from './leadUi';

export default function LeadDetailPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const q = useGet<LeadDetail>(id ? `/leads/${id}` : null);
  if (q.isLoading) return <Page><SkeletonRows rows={5} /></Page>;
  if (q.isError || !q.data) return <Page><ErrorState message={q.error ? errorMessage(q.error) : undefined} onRetry={() => void q.refetch()} title={t('leads.d.error', 'We could not open this inquiry')} /></Page>;
  return <Detail detail={q.data} />;
}

function Detail({ detail }: { detail: LeadDetail }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { lead, consent_summary: consent, next_best_action: nba } = detail;
  const [logOpen, setLogOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [dialog, setDialog] = useState<'nurture' | 'lost' | 'reject' | 'withdraw' | 'consent' | null>(null);
  const accept = useAction<void, LeadListItem>({ path: `/leads/${lead.id}/accept`, invalidate: ['/leads', '/followups'], successMessage: t('leads.accepted', 'Inquiry accepted') });
  const note = lead.status === 'assigned' || lead.status === 'unassigned' ? acceptanceFromEvents(detail.events) : null;
  const awaiting = lead.status === 'assigned';
  const qualified = lead.status === 'qualified' || detail.can_convert;
  // once a lead has moved on (opportunity, won, lost, merged) the lead-stage actions no longer apply
  const moved = ['opportunity', 'won', 'lost', 'merged', 'duplicate'].includes(lead.status);

  /** The one button for what the PDF says comes next. */
  const step = (() => {
    switch (nba.code) {
      case 'accept': return { label: t('leads.accept', 'Accept'), run: () => accept.mutate(), loading: accept.isPending };
      case 'assign': case 'route': case 'review_duplicate': return { label: t('leads.assign.button', 'Assign'), run: () => setAssignOpen(true) };
      case 'contact': case 'followup_overdue': case 'reengage': return { label: t('leads.d.logContact', 'Log a contact'), run: () => setLogOpen(true) };
      case 'qualify': case 'requirement': return { label: t('leads.d.qualify', 'Qualify this inquiry'), run: () => document.getElementById('qualification')?.scrollIntoView?.({ behavior: 'smooth' }) };
      case 'site_visit': return ['qualified', 'site_visit'].includes(lead.status) ? { label: t('leads.d.site', 'Go to site visit'), run: () => nav('/site') } : null;
      case 'opportunity': return { label: t('leads.d.convert', 'Decide on opportunity'), run: () => nav('/site?tab=opportunities') };
      default: return null;
    }
  })();

  return (
    <Page className="space-y-8">
      <div>
        <nav aria-label="Breadcrumb" className="mb-4 flex items-center gap-1.5 text-sm text-muted">
          <Link to="/" className="hover:text-fg hover:underline">Dashboard</Link><ChevronRight className="h-3.5 w-3.5" aria-hidden />
          <Link to="/leads" className="hover:text-fg hover:underline">Leads</Link><ChevronRight className="h-3.5 w-3.5" aria-hidden />
          <span aria-current="page" className="font-semibold text-fg">{lead.name}</span>
        </nav>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-[34px] leading-[1.15]">{lead.name}</h1>
              <StatusBadge kind="lead_status" value={lead.status} />
              {lead.temperature && <TemperatureBadge value={lead.temperature} />}
              {note && <Badge tone={note.tone}>{note.text}</Badge>}
            </div>
            <p className="mt-2 text-[15px] text-muted">
              {[sourceLabel(lead.source), lead.city, lead.capacity_kw ? `${lead.capacity_kw} kW` : null, lead.mobile, lead.email].filter(Boolean).join(' · ')}
            </p>
          </div>
          <Menu label={t('leads.d.more', 'More')} trigger={({ toggle }) => <Button variant="secondary" leftIcon={<MoreHorizontal className="h-4 w-4" />} aria-haspopup="menu" onClick={toggle}>{t('leads.d.more', 'More')}</Button>}
            items={[
              { key: 'reject', label: t('leads.reject', 'Reject'), hidden: !awaiting, onSelect: () => setDialog('reject') },
              { key: 'nurture', label: t('leads.d.nurture', 'Nurture'), hidden: moved || lead.status === 'nurture', onSelect: () => setDialog('nurture') },
              { key: 'lost', label: t('leads.d.lost', 'Mark lost'), danger: true, hidden: moved, onSelect: () => setDialog('lost') },
            ]} />
        </div>
      </div>

      <Card className="border-primary/30 bg-primary-soft/40">
        <CardBody className="space-y-4">
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-primary-text">{t('leads.d.nextStep', 'Next step')}</p>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="display text-xl">{nba.label}</p>
              {nba.due_at && <p className="mt-1 text-sm text-muted">{t('leads.d.by', 'By')} <DateTimeText value={nba.due_at} /></p>}
            </div>
            {step && !moved && <Button loading={step.loading} onClick={step.run}>{step.label}</Button>}
            {lead.status === 'opportunity' && <Button onClick={() => nav('/site?tab=opportunities')}>{t('leads.d.openOpp', 'Open the opportunity')}</Button>}
          </div>
          {assignOpen && <AssignControl leadId={lead.id} onDone={() => setAssignOpen(false)} />}
          {lead.status === 'unassigned' && !assignOpen && <p className="text-sm text-muted">{t('leads.d.noDist', 'No distributor is available — the DSM has been alerted. You can assign one yourself.')}</p>}
        </CardBody>
      </Card>

      {(lead.assigned_at || lead.status === 'unassigned') && (
        <Card>
          <CardHeader title={t('leads.d.acceptance', 'Lead acceptance')} description={t('leads.d.acceptanceHint', 'Steps 5–7: the distributor must accept in time, or the system reminds, alerts the DSM and reassigns.')} />
          <CardBody><AcceptanceTracker detail={detail} /></CardBody>
        </Card>
      )}

      {!moved && <div id="qualification"><QualificationCard detail={detail} /></div>}
      {!moved && <NextActionCard detail={detail} />}
      <ActivityCard leadId={lead.id} fallback={detail.events} />

      <section className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-6" aria-label={t('leads.d.footer', 'Related')}>
        <div className="space-y-1">
          {consent.has_active && !consent.withdrawn ? (
            <p className="text-sm">{t('leads.d.consent', 'Consent given for')} <strong>{consent.channels.join(', ')}</strong>. <button type="button" className="font-semibold text-primary-text underline" onClick={() => setDialog('withdraw')}>{t('leads.d.withdraw', 'Withdraw consent')}</button></p>
          ) : consent.withdrawn ? (
            <p className="text-sm text-muted">{t('leads.d.withdrawn', 'Consent withdrawn')}{consent.suppress_until ? <> — {t('leads.d.until', 'no messages until')} <DateText value={consent.suppress_until} /></> : null}.</p>
          ) : <p className="text-sm text-muted">{t('leads.d.noConsent', 'No consent recorded — no messages or quotations can be sent.')} <button type="button" className="font-semibold text-primary-text underline" onClick={() => setDialog('consent')}>{t('leads.d.recordConsent', 'Record consent')}</button></p>}
          {qualified && !moved && <p className="text-sm text-muted">{t('leads.d.ready', 'Qualified. Convert to an opportunity in Site and Opportunity.')}</p>}
        </div>
        <LinkButton to="/site" variant="secondary">{t('leads.d.site', 'Go to site visit')}</LinkButton>
      </section>

      {logOpen && <LogContactModal open leadId={lead.id} leadName={lead.name} onClose={() => setLogOpen(false)} />}
      <ReasonDialog kind={dialog === 'consent' ? null : dialog} leadId={lead.id} onClose={() => setDialog(null)} onLost={() => nav('/leads')} />
      <WithdrawDialog open={dialog === 'withdraw'} leadId={lead.id} onClose={() => setDialog(null)} />
      <RecordConsentModal leadId={lead.id} open={dialog === 'consent'} onClose={() => setDialog(null)} />
    </Page>
  );
}

function ActivityCard({ leadId, fallback }: { leadId: string; fallback: LeadDetail['events'] }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const tl = useList<LeadTimelineItem>(`/leads/${leadId}/timeline`, { limit: 50 }, { retry: false });
  const items: TimelineItem[] = tl.data
    ? tl.data.data.map((x, i) => ({ id: `${x.at}-${i}`, at: x.at, title: x.summary }))
    : fallback.map((e) => ({ id: e.id, at: e.created_at, title: e.summary }));
  const shown = all ? items : items.slice(0, 6);
  return (
    <Card>
      <CardHeader title={t('leads.act.title', '3) Activity')} />
      <CardBody>
        <Timeline items={shown} empty={t('leads.act.empty', 'No activity yet.')} />
        {items.length > 6 && <Button variant="link" className="mt-4" onClick={() => setAll((a) => !a)}>{all ? t('leads.act.less', 'Show less') : t('leads.act.all', 'Show all {{n}}', { n: items.length })}</Button>}
      </CardBody>
    </Card>
  );
}

/** Nurture, Mark lost and Reject each need a short reason (nurture also a date). */
function ReasonDialog({ kind, leadId, onClose, onLost }: { kind: 'nurture' | 'lost' | 'reject' | 'withdraw' | null; leadId: string; onClose: () => void; onLost: () => void }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const act = useAction<Record<string, unknown>>({
    path: kind === 'withdraw' || !kind ? '' : `/leads/${leadId}/${kind}`, invalidate: ['/leads', '/followups'], successMessage: kind === 'nurture' ? t('leads.d.nurtured', 'Moved to nurture') : kind === 'lost' ? t('leads.d.markedLost', 'Marked as lost') : t('leads.rejected', 'Inquiry rejected'),
    onSuccess: () => { setReason(''); setUntil(''); onClose(); if (kind === 'lost') onLost(); },
  });
  if (!kind || kind === 'withdraw') return null;
  const title = kind === 'nurture' ? t('leads.d.nurture', 'Nurture') : kind === 'lost' ? t('leads.d.lost', 'Mark lost') : t('leads.reject.title', 'Reject this inquiry?');
  const ok = reason.trim().length >= 3 && (kind !== 'nurture' || !!until);
  return (
    <Modal open onClose={onClose} size="sm" title={title}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button><Button variant={kind === 'nurture' ? 'primary' : 'danger'} disabled={!ok} loading={act.isPending} onClick={() => act.mutate({ reason: reason.trim(), ...(kind === 'nurture' && { nurture_until: until }) })}>{title}</Button></>}>
      <div className="space-y-5">
        <Field label={t('leads.d.reason', 'Reason')} required><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {kind === 'nurture' && <Field label={t('leads.d.nurtureUntil', 'Follow up again on')} required><Input type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></Field>}
      </div>
    </Modal>
  );
}

function WithdrawDialog({ open, leadId, onClose }: { open: boolean; leadId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const w = useAction<Record<string, unknown>>({ path: `/leads/${leadId}/consents/withdraw`, invalidate: ['/leads'], successMessage: t('leads.d.withdrawDone', 'Consent withdrawn'), onSuccess: onClose });
  return (
    <ConfirmDialog open={open} onClose={onClose} tone="danger" title={t('leads.d.withdraw', 'Withdraw consent')} confirmLabel={t('leads.d.withdraw', 'Withdraw consent')} loading={w.isPending}
      message={t('leads.d.withdrawWarn', 'No calls, SMS or WhatsApp messages will be sent to this customer for 90 days.')} onConfirm={() => w.mutate({ channel: 'ui' })} />
  );
}
