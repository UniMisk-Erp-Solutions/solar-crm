import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AppRole, SalesOrderDetail } from '@solar/shared';
import { StatusBadge } from '@/components/domain/status';
import { DateText, Money } from '@/components/domain/values';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/form';
import { Modal } from '@/components/ui/overlay';
import { Callout, Card, CardBody, CardHeader, ErrorState, KeyValue, Page, SkeletonRows } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, type One } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { invalidatePaths, useAction, useGet } from '@/lib/query';
import { NextStep, PricedLines, Refusal } from './parts';

const REFRESH = ['/sales-orders', '/pis'];

export default function SoDetailPage() {
  const { id = '' } = useParams();
  const q = useGet<SalesOrderDetail>(id ? `/sales-orders/${id}` : null);
  if (q.isLoading) return <Page><SkeletonRows /></Page>;
  if (q.error || !q.data) return <Page><ErrorState message={q.error?.message} onRetry={() => void q.refetch()} /></Page>;
  return <SoView so={q.data} />;
}

function SoView({ so }: { so: SalesOrderDetail }) {
  const release = useAction<{ note?: string }, SalesOrderDetail>({ path: `/sales-orders/${so.id}/release-hold`, invalidate: REFRESH, successMessage: 'Hold released', toastError: false });
  const handover = useAction<{ note?: string }, SalesOrderDetail>({ path: `/sales-orders/${so.id}/handover`, invalidate: REFRESH, successMessage: 'Handed over to dispatch planning', toastError: false });
  const { hasRole } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  // A sales order is only approved here (no reject): sign off every pending step this person may decide, in order. An admin holds every role.
  const mine = so.status === 'pending_approval' ? so.approvals.filter((a) => a.decision === 'pending' && hasRole(a.required_role as AppRole)).sort((a, b) => a.step - b.step) : [];
  const approve = useMutation({
    mutationFn: async () => { for (const a of mine) await api.post<One<unknown>>('/approvals/' + a.id + '/decide', { decision: 'approved' }); },
    onSuccess: async () => { await invalidatePaths(qc, [...REFRESH, '/approvals']); toast.success('Sales order approved'); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const [cancelling, setCancelling] = useState(false);
  const [why, setWhy] = useState('');
  const closeCancelling = useCallback(() => setCancelling(false), []);
  const cancel = useMutation({
    mutationFn: (note: string) => api.post<One<unknown>>('/sales-orders/' + so.id + '/cancel', { note }),
    onSuccess: async () => { await invalidatePaths(qc, REFRESH); toast.success('Sales order cancelled'); setCancelling(false); setWhy(''); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const cancellable = ['on_hold', 'pending_approval', 'approved', 'dispatch_planning', 'draft'].includes(so.status);
  const pending = so.approvals.filter((a) => a.decision === 'pending').sort((a, b) => a.step - b.step)[0];
  const withDispatch = ['dispatch_planning', 'partially_dispatched', 'dispatched'].includes(so.status);

  let text = so.status === 'cancelled' ? 'This sales order was cancelled.' : 'This sales order is closed.';
  let action: React.ReactNode = null;
  if (so.status === 'on_hold') {
    text = 'Waiting for the advance or credit approval. Release the hold once it arrives.';
    action = <Button loading={release.isPending} onClick={() => release.mutate({})}>Release hold</Button>;
  } else if (so.status === 'pending_approval') {
    text = mine.length ? 'This sales order is waiting for your approval. Approve it to hand it over to dispatch planning.' : `Waiting for approval${pending ? ` — ${pending.required_role.replace(/_/g, ' ')}` : ''}.`;
    action = mine.length ? <Button loading={approve.isPending} onClick={() => approve.mutate()}>Approve</Button> : null;
  }
  else if (so.status === 'approved') {
    text = 'Hand the order over to dispatch planning.';
    action = <Button loading={handover.isPending} onClick={() => handover.mutate({})}>Hand over to dispatch planning</Button>;
  } else if (withDispatch) text = 'With dispatch planning. The sales flow ends here.';

  const circulated = so.circulated_at
    ? ['Dispatch', 'Accounts', so.dealer_name ? `Dealer — ${so.dealer_name}` : null, 'Distributor'].filter(Boolean).join(', ')
    : null;

  return (
    <Page>
      <Link to="/orders?tab=orders" className="text-sm text-muted hover:text-fg hover:underline">Back to Order</Link>
      <header className="mb-6 mt-2 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[34px] leading-[1.15]"><span className="code">{so.so_no}</span></h1>
          <p className="mt-2 text-[15px] text-muted">{so.customer_name ?? so.dealer_name ?? 'Customer'} · <Money value={so.total} /></p>
        </div>
        <div className="flex items-center gap-3">
          {cancellable && <Button variant="secondary" onClick={() => setCancelling(true)}>Cancel order</Button>}
          <StatusBadge kind="so_status" value={so.status} />
        </div>
      </header>
      <NextStep text={text} action={action} />
      <div className="space-y-8">
        <Refusal error={release.error ?? handover.error} />
        {so.status === 'on_hold' && (
          <Callout tone="warning" title="On hold" actions={<Button size="sm" variant="secondary" loading={release.isPending} onClick={() => release.mutate({})}>Release hold</Button>}>
            {so.hold_reason ?? 'Payment or credit approval is still awaited.'} A reminder goes to the customer until it arrives.
          </Callout>
        )}
        <Card>
          <CardHeader title="Order" description="Step 31 — customer PO / order confirmation." />
          <CardBody className="space-y-5">
            <KeyValue items={[
              { label: 'Customer PO number', value: so.customer_po_no },
              { label: 'Customer PO date', value: <DateText value={so.customer_po_date} /> },
              { label: 'Proforma invoice', value: so.pi_no ? <Link className="code underline" to={`/orders/pi/${so.pi_id}`}>{so.pi_no}</Link> : null },
            ]} cols={3} />
            <PricedLines lines={so.lines} freight={so.pi?.freight ?? 0} total={so.total} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="32–33  SO approval and circulation" />
          <CardBody className="space-y-2 text-[15px]">
            <p>{so.status === 'on_hold' ? 'Approval starts once the hold is released.' : so.status === 'pending_approval' ? `Waiting for approval${pending ? ` — ${pending.required_role.replace(/_/g, ' ')}` : ''}.` : so.status === 'cancelled' ? 'The order was not approved.' : 'Approved.'}</p>
            <p className="text-muted">{circulated ? `Circulated to: ${circulated}` : 'Not circulated yet — this happens once the order is approved.'}</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="34  Hand over to dispatch planning" />
          <CardBody className="space-y-4">
            {withDispatch
              ? <p className="text-[15px]">Handed over on <DateText value={so.dispatch_handover_at} />. Dispatch planning takes it from here.</p>
              : <>
                  <Button variant="secondary" disabled={so.status !== 'approved'} loading={handover.isPending} onClick={() => handover.mutate({})}>Hand over to dispatch planning</Button>
                  {so.status !== 'approved' && <p className="text-sm text-muted">Available once the order is approved.</p>}
                </>}
          </CardBody>
        </Card>
      </div>
      <Modal open={cancelling} onClose={closeCancelling} size="sm" title="Cancel this sales order" description="Use this if the order is called off. Open dispatches are cancelled too; a shipped order cannot be cancelled."
        footer={<><Button variant="ghost" onClick={closeCancelling}>Keep it</Button><Button variant="danger" loading={cancel.isPending} disabled={why.trim().length < 3} onClick={() => cancel.mutate(why.trim())}>Cancel the order</Button></>}>
        <Field label="Why is it cancelled?" required><Textarea value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
      </Modal>
    </Page>
  );
}
