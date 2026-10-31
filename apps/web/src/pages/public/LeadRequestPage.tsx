import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { SunMark } from '@/components/layout/Logo';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/surface';
import { ApiError, api, errorMessage, type One } from '@/lib/api';

type State = 'open' | 'accepted' | 'declined' | 'taken' | 'expired';
interface RequestView {
  state: State; distributor_name: string; requested_at: string; due_at: string | null; answered_at: string | null;
  lead: { name: string; city: string | null; pincode: string | null; capacity_kw: number | null; customer_type: string | null; product_interest: string[] | null; temperature: string | null; requirement_text: string | null; mobile: string | null; email: string | null };
}

const CLOSED: Record<Exclude<State, 'open' | 'accepted'>, string> = {
  declined: 'You declined this request. Thank you for letting us know.',
  taken: 'Another distributor accepted this lead first, so the request is now closed.',
  expired: 'This request is closed. Ask Future Solar to send it again if you still want it.',
};

/** The page behind the buttons in a distributor's e-mail. No login: the link itself names the request. */
export default function LeadRequestPage() {
  const { token = '' } = useParams();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const key = ['lead-request', token];
  const [declining, setDeclining] = useState(params.get('do') === 'reject');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const view = useQuery<RequestView, ApiError>({
    queryKey: key, retry: false,
    queryFn: async () => (await api.anon<One<RequestView>>('GET', `/public/lead-requests/${encodeURIComponent(token)}`)).data,
  });
  const respond = useMutation({
    mutationFn: async (v: { action: 'accept' | 'reject'; reason?: string }) => (await api.anon<One<RequestView>>('POST', `/public/lead-requests/${encodeURIComponent(token)}/respond`, v)).data,
    onSuccess: (data) => { setError(null); qc.setQueryData(key, data); },
    onError: (e) => {
      const d = e instanceof ApiError && e.status === 409 ? (e.details as RequestView | undefined) : undefined;
      if (d?.state) qc.setQueryData(key, d);
      setError(errorMessage(e));
    },
  });

  const v = view.data;
  const l = v?.lead;
  const rows: [string, string][] = l ? [
    ['Customer', l.name], ['Place', [l.city, l.pincode].filter(Boolean).join(' ') || '—'], ['Size', l.capacity_kw ? `${l.capacity_kw} kW` : 'Not given'],
    ['Customer type', (l.customer_type ?? '—').replace(/_/g, ' ')], ['Interested in', l.product_interest?.length ? l.product_interest.join(', ') : 'Not specified'],
    ['Priority', (l.temperature ?? 'warm').toUpperCase()], ...(l.requirement_text ? [['Requirement', l.requirement_text] as [string, string]] : []),
  ] : [];

  return (
    <main className="min-h-screen bg-bg text-fg px-4 py-8">
      <div className="mx-auto max-w-lg">
        <div className="mb-5 flex items-center gap-2"><SunMark className="h-8 w-8" /><span className="text-lg font-semibold">Future Solar</span></div>
        {view.isLoading && <Spinner label="Loading the request" />}
        {view.isError && (
          <div role="alert" className="rounded-xl border border-line bg-surface p-5">
            <p className="font-semibold">This link cannot be opened</p>
            <p className="mt-1 text-sm text-muted">{view.error.message}</p>
          </div>
        )}
        {v && l && (
          <div className="rounded-xl border border-line bg-surface p-5 shadow-sm">
            <p className="text-sm text-muted">Hello {v.distributor_name}</p>
            <h1 className="mt-1 text-xl font-semibold">New solar lead for you</h1>
            <dl className="mt-4 divide-y divide-line text-sm">
              {rows.map(([k, val]) => (<div key={k} className="flex justify-between gap-4 py-2"><dt className="text-muted">{k}</dt><dd className="text-right font-medium">{val}</dd></div>))}
            </dl>
            {v.state === 'open' && v.due_at && <p className="mt-3 flex items-center gap-1.5 text-sm text-muted"><Clock className="h-4 w-4" />Please answer by {new Date(v.due_at).toLocaleString('en-IN')}. The first distributor to accept gets the lead.</p>}

            {v.state === 'open' && !declining && (
              <div className="mt-5 flex gap-3">
                <Button onClick={() => respond.mutate({ action: 'accept' })} disabled={respond.isPending}>{respond.isPending ? 'Saving…' : 'Confirm — accept this lead'}</Button>
                <Button variant="secondary" onClick={() => setDeclining(true)} disabled={respond.isPending}>Decline</Button>
              </div>
            )}
            {v.state === 'open' && declining && (
              <div className="mt-5 space-y-3">
                <label className="block text-sm font-medium" htmlFor="why">Why are you declining?</label>
                <textarea id="why" className="w-full rounded-lg border border-line p-2 text-sm" rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: outside our area, no capacity right now" />
                <div className="flex gap-3">
                  <Button variant="danger" onClick={() => respond.mutate({ action: 'reject', reason: reason.trim() })} disabled={respond.isPending || reason.trim().length < 3}>{respond.isPending ? 'Saving…' : 'Confirm — decline'}</Button>
                  <Button variant="secondary" onClick={() => setDeclining(false)} disabled={respond.isPending}>Back</Button>
                </div>
              </div>
            )}
            {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}

            {v.state === 'accepted' && (
              <div role="status" className="mt-5 rounded-lg bg-primary-soft p-4 text-sm text-primary-text">
                <p className="flex items-center gap-1.5 font-semibold"><CheckCircle2 className="h-4 w-4" />You accepted this lead. It is now yours.</p>
                <p className="mt-2">Call the customer: <strong>{l.mobile}</strong>{l.email ? <> · {l.email}</> : null}</p>
              </div>
            )}
            {v.state !== 'open' && v.state !== 'accepted' && (
              <p role="status" className="mt-5 flex items-start gap-1.5 rounded-lg bg-surface-2 p-4 text-sm"><XCircle className="mt-0.5 h-4 w-4 shrink-0" />{CLOSED[v.state]}</p>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
