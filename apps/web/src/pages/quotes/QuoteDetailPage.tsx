import { ChevronRight } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { AppRole } from '@solar/shared';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/form';
import { Modal } from '@/components/ui/overlay';
import { Callout, ErrorState, SkeletonCards } from '@/components/ui/surface';
import { StatusBadge } from '@/components/domain/status';
import { RecordConsentModal } from '@/components/domain/RecordConsentModal';
import { DateText } from '@/components/domain/values';
import { ApiError, api, errorMessage, type One } from '@/lib/api';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { invalidatePaths, useAction, useGet } from '@/lib/query';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/lib/auth';
import { OfferCard } from './OfferCard';
import { OfferHistoryCard } from './OfferHistoryCard';
import { DiscussionCard, PriceReviewCard } from './ReviewCards';
import { blockersOf, commercialApprovers, warningsOf, type QuoteDetail } from './types';

const CANCELLABLE = ['draft', 'blocked', 'price_review', 'pending_approval', 'approved', 'sent', 'negotiation', 'accepted', 'requote_required'];

type Step = 'approval' | 'wait' | 'send' | 'accept' | 'pi' | 'revise' | 'latest';

/** What the flow says comes next for a quotation in this status. */
export function stepFor(q: Pick<QuoteDetail, 'status' | 'sent_at'>): Step {
  switch (q.status) {
    case 'pending_approval': return 'wait';
    case 'approved': return 'send';
    case 'sent': case 'negotiation': return 'accept';
    case 'accepted': return 'pi';
    case 'rejected': case 'expired': return 'revise';
    case 'requote_required': return q.sent_at ? 'revise' : 'approval';
    case 'revised': return 'latest';
    default: return 'approval';
  }
}

export default function QuoteDetailPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { hasRole } = useAuth(); 
  const q = useGet<QuoteDetail>(`/quotes/${id}`);
  const [dirty, setDirty] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [deciding, setDeciding] = useState<'approved' | 'rejected' | null>(null);
  const [comment, setComment] = useState('');
  const [reason, setReason] = useState('');
  const [piId, setPiId] = useState<string | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);

  const closeDecline = useCallback(() => setDeclining(false), []);
  const closeDeciding = useCallback(() => setDeciding(null), []);
  const base = { invalidate: ['/quotes', '/opportunities', '/approvals'] };
  const approval = useAction({ ...base, path: `/quotes/${id}/request-approval`, successMessage: t('quote.sentForApproval', 'Sent for approval') });
  const send = useAction({ ...base, path: `/quotes/${id}/send`, successMessage: t('quote.sent', 'Quotation sent to the customer') });
  const accept = useAction({ ...base, path: `/quotes/${id}/accept`, successMessage: t('quote.accepted', 'Commercial terms confirmed') });
  const decline = useAction<{ reason: string }>({ ...base, path: `/quotes/${id}/reject`, successMessage: t('quote.declined', 'Marked as declined'), onSuccess: () => { setDeclining(false); setReason(''); } });
  const qc = useQueryClient();
  const decide = useMutation({
    // only the decision and the comment go in the body; the approval id is part of the address
    mutationFn: async ({ ids, ...payload }: { ids: string[]; decision: 'approved' | 'rejected'; comment?: string }) => {
      for (const approvalId of ids) await api.post<One<unknown>>('/approvals/' + approvalId + '/decide', payload);
    },
    onSuccess: async () => { await invalidatePaths(qc, ['/quotes', '/opportunities', '/approvals']); toast.success(t('quote.decided', 'Decision recorded')); setDeciding(null); setComment(''); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const revise = useAction<unknown, { id: string }>({ ...base, path: `/quotes/${id}/revise`, onSuccess: (n) => navigate(`/quotes/${n.id}`) });
  const pi = useAction<{ quote_id: string }, { id: string }>({ path: '/pis', invalidate: ['/quotes', '/pis'], toastError: false, onSuccess: (p) => setPiId(p.id) });

  if (q.isLoading) return <main className="page"><SkeletonCards count={3} /></main>;
  if (q.error || !q.data) return <main className="page"><ErrorState message={q.error ? errorMessage(q.error) : undefined} onRetry={() => void q.refetch()} /></main>;
  const quote = q.data;
  const blockers = blockersOf(quote);
  // the next approval in line that this person may decide (the system checks the order and the role again)
  const myApprovals = quote.status === 'pending_approval' ? [...quote.approvals].filter((a) => a.decision === 'pending' && hasRole(a.required_role as AppRole)).sort((a, b) => a.step - b.step) : [];
  const myApproval = myApprovals[0];
  const warnings = warningsOf(quote);
  const approvers = commercialApprovers(quote);
  const step = stepFor(quote);
  const latest = [...quote.versions].sort((a, b) => b.version - a.version)[0];

  const createPi = () => pi.mutate({ quote_id: quote.id }, {
    onError: (e) => {
      const existing = e instanceof ApiError && (e.details as { pi_id?: string } | undefined)?.pi_id;
      if (existing) setPiId(existing); else toast.error(errorMessage(e));
    },
  });

  const sentence: Record<Step, string> = {
    approval: quote.status === 'blocked' ? t('quote.next.blocked', 'Fix what is blocking this quotation, then send it for approval.') : t('quote.next.approval', 'Finish the offer, then send it for approval.'),
    wait: approvers.length ? t('quote.next.wait', 'Waiting for approval from {{who}}.', { who: approvers.join(' → ') }) : t('quote.next.wait2', 'Waiting for approval.'),
    send: t('quote.next.send', 'Approved. Send the quotation to the customer.'),
    accept: t('quote.next.accept', 'Sent to the customer. Waiting for their answer: did they approve or reject the quotation?'),
    pi: t('quote.next.pi', 'Commercial terms confirmed. Create the proforma invoice.'),
    revise: quote.rejected_reason ? t('quote.next.reviseWhy', 'Stopped: {{why}}. Start again with a new version of the offer.', { why: quote.rejected_reason }) : t('quote.next.revise', 'This quotation needs a new version. Revise it to continue.'),
    latest: t('quote.next.latest', 'This version has been replaced by a newer one.'),
  };

  // Why the primary button cannot be used right now, in one sentence.
  const why = step === 'approval'
    ? (quote.lines.length === 0 ? t('quote.why.noLines', 'Add at least one product first.') : dirty ? t('quote.why.unsaved', 'Save the offer first.') : blockers.length ? t('quote.why.blocked', 'Fix the problem above first.') : '')
    : step === 'send' && blockers.length ? t('quote.why.blocked', 'Fix the problem above first.') : '';

  const primary = (() => {
    switch (step) {
      case 'approval': return <Button size="lg" loading={approval.isPending} disabled={!!why} onClick={() => approval.mutate({})}>{t('quote.btn.approval', 'Send for approval')}</Button>;
      case 'send': return <Button size="lg" loading={send.isPending} disabled={!!why} onClick={() => send.mutate({})}>{t('quote.btn.send', 'Send to customer')}</Button>;
      case 'accept': return <Button size="lg" loading={accept.isPending} onClick={() => accept.mutate({})}>{t('quote.btn.accept', 'Customer approved')}</Button>;
      case 'revise': return <Button size="lg" loading={revise.isPending} onClick={() => revise.mutate({})}>{t('quote.btn.revise', 'Revise quote')}</Button>;
      case 'pi': return piId
        ? <LinkButton size="lg" to={`/orders/pi/${piId}`}>{t('quote.btn.openPi', 'Open proforma invoice')}</LinkButton>
        : <Button size="lg" loading={pi.isPending} onClick={createPi}>{t('quote.btn.pi', 'Create proforma invoice')}</Button>;
      case 'latest': return latest && latest.id !== quote.id ? <LinkButton size="lg" to={`/quotes/${latest.id}`}>{t('quote.btn.latest', 'Open latest version')}</LinkButton> : null;
      default: return null;
    }
  })();

  return (
    <main className="page space-y-8">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted">
        <Link to="/quotes" className="hover:text-fg hover:underline">{t('quote.crumb', 'Quotation')}</Link>
        <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        <span aria-current="page" className="code font-semibold text-fg">{quote.quote_no}</span>
      </nav>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="code text-[34px] leading-tight">{quote.quote_no}</h1>
          <StatusBadge kind="quote_status" value={quote.status} />
          {quote.version > 1 && <span className="text-sm text-muted">{t('quote.version', 'Version')} {quote.version}</span>}
        </div>
        <p className="text-[15px] text-muted">{quote.customer?.legal_name ?? quote.customer?.display_name ?? quote.opportunity?.name ?? ''} · {quote.kw} kW · {t('quote.validUntil', 'valid until')} <DateText value={quote.validity_date} /></p>
      </header>

      <section aria-label={t('quote.nextStep', 'Next step')} className="card flex flex-wrap items-center justify-between gap-4 p-6">
        <div className="min-w-0 max-w-xl">
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted">{t('quote.nextStep', 'Next step')}</p>
          <p className="mt-1 text-lg font-semibold">{sentence[step]}</p>
          {why && <p className="mt-1 text-sm text-muted">{why}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {step === 'wait' && myApproval && (
            <>
              <Button variant="danger" onClick={() => setDeciding('rejected')}>{t('quote.btn.rejectApproval', 'Reject')}</Button>
              <Button onClick={() => setDeciding('approved')}>{t('quote.btn.approve', 'Approve')}</Button>
            </>
          )}
          {step === 'accept' && <Button size="lg" variant="danger" onClick={() => setDeclining(true)}>{t('quote.btn.customerRejected', 'Customer rejected')}</Button>}
          {step !== 'accept' && step !== 'pi' && CANCELLABLE.includes(quote.status) && <Button variant="secondary" onClick={() => setDeclining(true)}>{t('quote.btn.cancelDeal', 'Cancel deal')}</Button>}
          {step === 'wait' && <LinkButton variant="secondary" to="/quotes?tab=approvals">{t('quote.btn.seeApprovals', 'See approvals')}</LinkButton>}
          {primary}
        </div>
      </section>

      {blockers.length > 0 && (step === 'approval' || step === 'send' || step === 'wait') && (
        <Callout tone="danger" title={t('quote.cannotSend', 'Cannot be sent yet')} actions={quote.lead_id && blockers.some((f) => f.gate === 'G1' || /consent/i.test(f.message)) ? <Button size="sm" variant="secondary" onClick={() => setConsentOpen(true)}>{t('quote.recordConsent', 'Record customer consent')}</Button> : undefined}>
          <ul className="list-disc space-y-1 pl-5">{blockers.map((f, i) => <li key={i}>{f.message}</li>)}</ul>
        </Callout>
      )}
      {quote.lead_id && <RecordConsentModal leadId={quote.lead_id} open={consentOpen} onClose={() => setConsentOpen(false)} onDone={() => void api.post(`/quotes/${id}/evaluate`, {}).then(() => q.refetch())} />}
      {blockers.length === 0 && warnings.length > 0 && (
        <Callout tone="warning">{warnings[0]!.message}{warnings.length > 1 && ` (+${warnings.length - 1} more)`}</Callout>
      )}

      <OfferCard quote={quote} onDirty={setDirty} canTax={hasRole('accounts', 'compliance_officer')} />
      <PriceReviewCard quote={quote} />
      <DiscussionCard quote={quote} />
      <OfferHistoryCard quote={quote} />

      <Modal open={declining} onClose={closeDecline} size="sm" title={step === 'accept' ? t('quote.decline.titleCustomer', 'Customer rejected the quotation') : t('quote.decline.title', 'Cancel this deal')} description={t('quote.decline.sub', 'Use this when the customer cancels (for example on a call) or the deal is called off. You can start again with a new version afterwards.')}
        footer={<><Button variant="ghost" onClick={closeDecline}>{t('common.cancel', 'Cancel')}</Button><Button variant="danger" loading={decline.isPending} disabled={reason.trim().length < 3} onClick={() => decline.mutate({ reason: reason.trim() })}>{t('quote.decline.confirm', 'Cancel the deal')}</Button></>}>
        <Field label={step === 'accept' ? t('quote.decline.reasonCustomer', 'What did the customer say?') : t('quote.decline.reason', 'Why is it cancelled?')} required><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>
      <Modal open={!!deciding} onClose={closeDeciding} size="sm" title={deciding === 'rejected' ? t('quote.reject.title', 'Reject this quotation') : t('quote.approve.title', 'Approve this quotation')}
        description={deciding === 'rejected' ? t('quote.reject.sub', 'It goes back to quotation preparation: you start again with a new version of the offer.') : undefined}
        footer={<><Button variant="ghost" onClick={closeDeciding}>{t('common.cancel', 'Cancel')}</Button><Button variant={deciding === 'rejected' ? 'danger' : 'primary'} loading={decide.isPending} disabled={deciding === 'rejected' && comment.trim().length < 3} onClick={() => myApproval && deciding && decide.mutate({ ids: deciding === 'approved' ? myApprovals.map((a) => a.id) : [myApproval.id], decision: deciding, comment: comment.trim() || undefined })}>{deciding === 'rejected' ? t('quote.btn.rejectApproval', 'Reject') : t('quote.btn.approve', 'Approve')}</Button></>}>
        <Field label={deciding === 'rejected' ? t('quote.reject.reason', 'Reason') : t('quote.approve.note', 'Comment')} required={deciding === 'rejected'} optional={deciding !== 'rejected'}><Textarea value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      </Modal>
    </main>
  );
}
