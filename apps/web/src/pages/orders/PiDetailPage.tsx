import { Check, Circle } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PRE_PI_LABELS, type Address, type AppRole, type PiDetail, type PreFlightChecklist, type SalesOrder } from '@solar/shared';
import { StatusBadge } from '@/components/domain/status';
import { DateText, Money } from '@/components/domain/values';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Modal } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/toast';
import { Callout, Card, CardBody, CardHeader, ErrorState, Page, SkeletonRows } from '@/components/ui/surface';
import { api, errorMessage, type One } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { invalidatePaths, useAction, useGet } from '@/lib/query';
import { NextStep, PricedLines, Refusal } from './parts';

type Key = keyof PreFlightChecklist;
const KEYS = Object.keys(PRE_PI_LABELS) as Key[];
const SHORT: Record<Key, string> = {
  legal_name: 'Legal name', billing_address: 'Billing address', shipping_address: 'Shipping address', gst: 'GST', product: 'Product', quantity: 'Quantity', price: 'Price', freight: 'Freight', payment_terms: 'Payment terms',
};
const PI_REFRESH = ['/pis', '/quotes', '/sales-orders'];

interface CreditPosition { dealer_name: string; credit_limit: number; outstanding: number; available: number; over_limit: boolean }

/** Whether the PDF's decision "Advance received OR credit approved?" is YES. */
export function decisionYes(pi: Pick<PiDetail, 'advance_ok' | 'credit_check'>): boolean {
  return pi.advance_ok || pi.credit_check?.result === 'approved';
}

export default function PiDetailPage() {
  const { id = '' } = useParams();
  const q = useGet<PiDetail>(id ? `/pis/${id}` : null);
  if (q.isLoading) return <Page><SkeletonRows /></Page>;
  if (q.error || !q.data) return <Page><ErrorState message={q.error?.message} onRetry={() => void q.refetch()} /></Page>;
  return <PiView pi={q.data} />;
}

function PiView({ pi }: { pi: PiDetail }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const missing = KEYS.filter((k) => !pi.pre_pi_checklist[k]);
  const submit = useAction<undefined, PiDetail>({ path: `/pis/${pi.id}/submit`, invalidate: PI_REFRESH, successMessage: 'Sent for approval', toastError: false });
  const { hasRole } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [deciding, setDeciding] = useState<'approved' | 'rejected' | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [comment, setComment] = useState('');
  const closeDeciding = useCallback(() => setDeciding(null), []);
  const closeCancelling = useCallback(() => setCancelling(false), []);
  // approve every pending step this person may decide (an admin holds every role); reject decides one step and needs a reason
  const mine = pi.status === 'pending_approval' ? pi.approvals.filter((a) => a.decision === 'pending' && hasRole(a.required_role as AppRole)).sort((a, b) => a.step - b.step) : [];
  const decide = useMutation({
    mutationFn: async ({ ids, ...payload }: { ids: string[]; decision: 'approved' | 'rejected'; comment?: string }) => { for (const approvalId of ids) await api.post<One<unknown>>('/approvals/' + approvalId + '/decide', payload); },
    onSuccess: async () => { await invalidatePaths(qc, [...PI_REFRESH, '/approvals']); toast.success('Decision recorded'); setDeciding(null); setComment(''); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const cancel = useMutation({
    mutationFn: (note: string) => api.post<One<unknown>>('/pis/' + pi.id + '/cancel', { note }),
    onSuccess: async () => { await invalidatePaths(qc, PI_REFRESH); toast.success('Proforma invoice cancelled'); setCancelling(false); setComment(''); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const rejectedWhy = [...pi.approvals].filter((a) => a.decision === 'rejected' && a.comment).sort((a, b) => (b.decided_at ?? '').localeCompare(a.decided_at ?? ''))[0]?.comment ?? null;
  const yes = decisionYes(pi);
  const open = pi.status === 'issued' || pi.status === 'partially_paid' || pi.status === 'paid';
  const so = pi.sales_order;

  let text = '';
  let action: React.ReactNode = null;
  if (pi.status === 'draft') {
    text = rejectedWhy ? `It was not approved: ${rejectedWhy}. Correct it and issue it again.` : missing.length ? `Fill in the missing details (${missing.map((k) => SHORT[k]).join(', ')}) so the PI can be issued.` : 'Issue the proforma invoice. It goes for approval first.';
    action = <Button disabled={missing.length > 0} loading={submit.isPending} onClick={() => submit.mutate(undefined)}>Issue PI</Button>;
  } else if (pi.status === 'pending_approval') {
    text = mine.length ? 'The proforma invoice is waiting for your approval. Approve it to issue it, or reject it to send it back for correction.' : 'The proforma invoice is waiting for approval. It is issued as soon as it is approved.';
    action = mine.length ? <div className="flex gap-3"><Button variant="danger" onClick={() => setDeciding('rejected')}>Reject</Button><Button onClick={() => setDeciding('approved')}>Approve</Button></div> : null;
  }
  else if (so) {
    text = 'The sales order exists. Open it to follow approval and hand-over.';
    action = <Button onClick={() => nav(`/orders/so/${so.id}`)}>Open sales order</Button>;
  } else if (open) text = yes ? 'Advance received or credit approved. Create the sales order from the customer PO.' : 'Record the advance payment, or ask for credit approval. Without either the sales order is put on hold.';
  else text = 'This proforma invoice is cancelled.';

  return (
    <Page>
      <Link to="/orders" className="text-sm text-muted hover:text-fg hover:underline">Back to Order</Link>
      <header className="mb-6 mt-2 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[34px] leading-[1.15]"><span className="code">{pi.pi_no}</span></h1>
          <p className="mt-2 text-[15px] text-muted">{pi.legal_name ?? pi.dealer_name ?? 'Customer'} · <Money value={pi.total} /></p>
        </div>
        <div className="flex items-center gap-3">
          {['draft', 'pending_approval', 'issued'].includes(pi.status) && !so && !(pi.paid_amount > 0) && <Button variant="secondary" onClick={() => setCancelling(true)}>Cancel PI</Button>}
          <StatusBadge kind="pi_status" value={pi.status} />
        </div>
      </header>
      <NextStep text={text} action={action} />
      {submit.error && <div className="mb-8"><Callout tone="danger" title="The PI cannot be issued yet">{errorMessage(submit.error)}</Callout></div>}
      <div className="space-y-8">
        <ChecklistCard pi={pi} missing={missing} editable={pi.status === 'draft'} />
        {pi.lines.length > 0 && (
          <Card>
            <CardHeader title="Items and total" description="What the customer is invoiced for, with GST." />
            <CardBody><PricedLines lines={pi.lines} freight={pi.freight} total={pi.total} /></CardBody>
          </Card>
        )}
        <ApprovalCard pi={pi} />
        {open && <PaymentCard pi={pi} yes={yes} />}
        {open && !so && <SalesOrderCard pi={pi} yes={yes} />}
      </div>
      <Modal open={!!deciding} onClose={closeDeciding} size="sm" title={deciding === 'rejected' ? 'Reject this proforma invoice' : 'Approve this proforma invoice'}
        description={deciding === 'rejected' ? 'It goes back to draft so it can be corrected and issued again.' : undefined}
        footer={<><Button variant="ghost" onClick={closeDeciding}>Cancel</Button><Button variant={deciding === 'rejected' ? 'danger' : 'primary'} loading={decide.isPending} disabled={deciding === 'rejected' && comment.trim().length < 3} onClick={() => deciding && mine[0] && decide.mutate({ ids: deciding === 'approved' ? mine.map((a) => a.id) : [mine[0].id], decision: deciding, comment: comment.trim() || undefined })}>{deciding === 'rejected' ? 'Reject' : 'Approve'}</Button></>}>
        <Field label={deciding === 'rejected' ? 'Reason' : 'Comment'} required={deciding === 'rejected'} optional={deciding !== 'rejected'}><Textarea value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      </Modal>
      <Modal open={cancelling} onClose={closeCancelling} size="sm" title="Cancel this proforma invoice" description="Use this if the deal is called off. A PI with payments or a sales order cannot be cancelled."
        footer={<><Button variant="ghost" onClick={closeCancelling}>Keep it</Button><Button variant="danger" loading={cancel.isPending} disabled={comment.trim().length < 3} onClick={() => cancel.mutate(comment.trim())}>Cancel the PI</Button></>}>
        <Field label="Why is it cancelled?" required><Textarea value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      </Modal>
      <p className="sr-only">{t('orders.pi.title', 'Proforma invoice')}</p>
    </Page>
  );
}

function ChecklistCard({ pi, missing, editable }: { pi: PiDetail; missing: Key[]; editable: boolean }) {
  const save = useAction<Record<string, unknown>, PiDetail>({ method: 'patch', path: `/pis/${pi.id}`, invalidate: PI_REFRESH, successMessage: 'Saved' });
  return (
    <Card>
      <CardHeader title="1  Before the PI — confirm" description="Step 28 — all nine must be ticked before the PI can be issued." />
      <CardBody>
        <ul className="divide-y divide-border">
          {KEYS.map((k) => {
            const ok = pi.pre_pi_checklist[k];
            return (
              <li key={k} className="py-3">
                <div className="flex items-center gap-3">
                  {ok ? <Check className="h-5 w-5 text-primary-text" aria-label="Confirmed" /> : <Circle className="h-5 w-5 text-danger" aria-label="Missing" />}
                  <span className={ok ? 'text-[15px]' : 'text-[15px] font-semibold'}>{SHORT[k]}</span>
                  {!ok && <span className="text-sm text-danger-text">missing</span>}
                </div>
                {!ok && editable && <FixField k={k} saving={save.isPending} quoteId={pi.quote_id} onSave={(body) => save.mutate(body)} />}
              </li>
            );
          })}
        </ul>
        {missing.length > 0 && <p className="mt-4 text-sm text-muted">Cannot issue yet — missing: {missing.map((k) => SHORT[k]).join(', ')}.</p>}
      </CardBody>
    </Card>
  );
}

function FixField({ k, onSave, saving, quoteId }: { k: Key; onSave: (b: Record<string, unknown>) => void; saving: boolean; quoteId: string }) {
  const [v, setV] = useState('');
  const [addr, setAddr] = useState<Address>({ line1: '', city: '', state: '', pincode: '' });
  const [unreg, setUnreg] = useState(false);
  const label = SHORT[k];
  if (k === 'product' || k === 'quantity' || k === 'price') return <p className="ml-8 mt-2 text-sm text-muted">This comes from the quotation lines. <Link className="font-semibold text-primary-text underline" to={'/quotes/' + quoteId}>Open the quotation</Link> and revise it there.</p>;
  if (k === 'billing_address' || k === 'shipping_address') {
    const set = (p: Partial<Address>) => setAddr((a) => ({ ...a, ...p }));
    return (
      <div className="ml-8 mt-3 grid gap-4 md:grid-cols-2">
        <Field label={`${label} — street`}><Input value={addr.line1} onChange={(e) => set({ line1: e.target.value })} /></Field>
        <Field label="City"><Input value={addr.city} onChange={(e) => set({ city: e.target.value })} /></Field>
        <Field label="State"><Input value={addr.state} onChange={(e) => set({ state: e.target.value })} /></Field>
        <Field label="Pincode"><Input inputMode="numeric" maxLength={6} value={addr.pincode} onChange={(e) => set({ pincode: e.target.value })} /></Field>
        <div><Button size="sm" variant="secondary" loading={saving} disabled={!addr.line1 || !addr.city || !addr.state || addr.pincode.length !== 6} onClick={() => onSave({ [k]: addr })}>Save {label.toLowerCase()}</Button></div>
      </div>
    );
  }
  if (k === 'gst') {
    return (
      <div className="ml-8 mt-3 flex flex-wrap items-end gap-4">
        <Field label="GSTIN" className="w-64"><Input value={v} maxLength={15} disabled={unreg} onChange={(e) => setV(e.target.value.toUpperCase())} /></Field>
        <label className="flex items-center gap-2 pb-2.5 text-sm"><input type="checkbox" checked={unreg} onChange={(e) => setUnreg(e.target.checked)} />Individual without GST</label>
        <Button size="sm" variant="secondary" loading={saving} disabled={!unreg && v.length !== 15} onClick={() => onSave(unreg ? { gst_unregistered: true } : { gstin: v })}>Save GST</Button>
      </div>
    );
  }
  const numeric = k === 'freight';
  return (
    <div className="ml-8 mt-3 flex flex-wrap items-end gap-4">
      <Field label={label} className="w-72"><Input type={numeric ? 'number' : 'text'} min={0} value={v} onChange={(e) => setV(e.target.value)} /></Field>
      <Button size="sm" variant="secondary" loading={saving} disabled={v.trim() === ''} onClick={() => onSave({ [k]: numeric ? Number(v) : v.trim() })}>Save {label.toLowerCase()}</Button>
    </div>
  );
}

function ApprovalCard({ pi }: { pi: PiDetail }) {
  const pending = pi.approvals.filter((a) => a.decision === 'pending').sort((a, b) => a.step - b.step)[0];
  const line = pi.status === 'draft' ? 'Not sent for approval yet.'
    : pi.status === 'pending_approval' ? `Waiting for approval${pending ? ` — ${pending.required_role.replace(/_/g, ' ')}` : ''}.`
    : pi.status === 'cancelled' ? 'Cancelled.' : null;
  return (
    <Card>
      <CardHeader title="2  PI approval and issue" description="Step 29 — Accounts approve; Management too for large orders." />
      <CardBody>
        {line ? <p className="text-[15px]">{line}</p> : <p className="text-[15px]">Approved and issued on <DateText value={pi.issue_date} />, valid till <DateText value={pi.valid_till} />.</p>}
      </CardBody>
    </Card>
  );
}

const MODES = [['upi', 'UPI'], ['neft_rtgs', 'NEFT / RTGS'], ['cheque', 'Cheque'], ['cash', 'Cash'], ['card', 'Card'], ['other', 'Other']];

function PaymentCard({ pi, yes }: { pi: PiDetail; yes: boolean }) {
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState('neft_rtgs');
  const [ref, setRef] = useState('');
  const pay = useAction<Record<string, unknown>, unknown>({ path: `/pis/${pi.id}/payments`, invalidate: PI_REFRESH, successMessage: 'Payment recorded', onSuccess: () => { setAmount(''); setRef(''); } });
  const credit = useAction<{ basis: 'credit' }, unknown>({ path: `/pis/${pi.id}/credit-check`, invalidate: PI_REFRESH, successMessage: 'Credit approval requested' });
  const pos = useGet<CreditPosition>(pi.dealer_id && !pi.advance_ok ? `/credit-position/${pi.dealer_id}` : null);
  const pendingCredit = pi.credit_check?.basis === 'credit' && pi.credit_check.result === 'pending';
  return (
    <Card>
      <CardHeader title="3  Payment / credit verification" description="Step 30 — the advance, or the dealer's credit approval." />
      <CardBody className="space-y-6">
        {pi.status !== 'paid' && <div className="grid gap-5 md:grid-cols-4">
          <Field label="Advance received (₹)"><Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Mode"><Select value={mode} onChange={(e) => setMode(e.target.value)}>{MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
          <Field label="Reference" optional><Input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
          <div className="flex items-end"><Button variant="secondary" loading={pay.isPending} disabled={!(Number(amount) > 0)} onClick={() => pay.mutate({ kind: 'advance', amount: Number(amount), mode, reference: ref || undefined })}>Record payment</Button></div>
        </div>}
        <p className="text-sm text-muted">Received so far <Money value={pi.paid_amount} /> of <Money value={pi.required_advance} /> needed as advance ({pi.advance_pct}% of the total).</p>

        <div className={`rounded-xl border p-5 ${yes ? 'border-primary/40 bg-primary-soft' : 'border-border bg-surface-2'}`}>
          <p className="font-display text-xl">Advance received OR credit approved?</p>
          <p className="mt-2 text-[15px]" data-testid="decision">
            {yes ? <><b>YES</b> — create the sales order.</> : <><b>NO</b> — SO on hold, reminder will go to the customer.</>}
          </p>
          {pos.data && <p className="mt-2 text-sm text-muted">Dealer credit: limit <Money value={pos.data.credit_limit} /> · outstanding <Money value={pos.data.outstanding} /> · available <Money value={pos.data.available} />{pos.data.over_limit ? ' — over limit' : ''}</p>}
          {pendingCredit && <p className="mt-2 text-sm text-muted">Credit approval requested — waiting for Accounts or Management.</p>}
          {pi.credit_check?.basis === 'credit' && pi.credit_check.result === 'rejected' && <p className="mt-2 text-sm text-danger-text">Credit was not approved{pi.credit_check.notes ? `: ${pi.credit_check.notes}` : '.'}</p>}
          {!yes && pi.dealer_id && !pendingCredit && pi.status !== 'paid' && <div className="mt-4"><Button variant="secondary" size="sm" loading={credit.isPending} onClick={() => credit.mutate({ basis: 'credit' })}>Ask for credit approval</Button></div>}
        </div>
      </CardBody>
    </Card>
  );
}

function SalesOrderCard({ pi, yes }: { pi: PiDetail; yes: boolean }) {
  const nav = useNavigate();
  const [no, setNo] = useState('');
  const [date, setDate] = useState('');
  const create = useAction<Record<string, unknown>, SalesOrder>({ path: '/sales-orders', invalidate: PI_REFRESH, toastError: false, successMessage: 'Sales order created', onSuccess: (so) => nav(`/orders/so/${so.id}`) });
  return (
    <Card>
      <CardHeader title="Create sales order" description="Step 31 — customer PO / order confirmation." />
      <CardBody className="space-y-5">
        <div className="grid gap-5 md:grid-cols-3">
          <Field label="Customer PO number" required><Input value={no} onChange={(e) => setNo(e.target.value)} /></Field>
          <Field label="Customer PO date" required><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <div className="flex items-end"><Button loading={create.isPending} disabled={!no.trim() || !date} onClick={() => create.mutate({ pi_id: pi.id, customer_po_no: no.trim(), customer_po_date: date })}>{yes ? 'Create sales order' : 'Create sales order (on hold)'}</Button></div>
        </div>
        {!yes && <p className="text-sm text-muted">Without an advance or approved credit the order is created on hold until payment arrives.</p>}
        <Refusal error={create.error} />
      </CardBody>
    </Card>
  );
}
