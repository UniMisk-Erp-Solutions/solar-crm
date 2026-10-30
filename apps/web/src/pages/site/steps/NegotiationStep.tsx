import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NegotiationLog } from '@solar/shared';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/form';
import { Callout, ErrorState } from '@/components/ui/surface';
import { DateText, Money } from '@/components/domain/values';
import { errorMessage } from '@/lib/api';
import { useAction, useGet } from '@/lib/query';

interface Negotiations { rows: NegotiationLog[]; summary: { rounds: number; latest_quoted_rate_per_kw: number | null; latest_counter_per_kw: number | null; gap_per_kw: number | null } }

/** Steps 17–18: technical discussion notes and the rate per kW offered by us and countered by the customer. */
export function NegotiationStep({ leadId }: { leadId: string }) {
  const { t } = useTranslation();
  const q = useGet<Negotiations>(`/leads/${leadId}/negotiations`);
  const [notes, setNotes] = useState('');
  const [offer, setOffer] = useState('');
  const [counter, setCounter] = useState('');
  const add = useAction<Record<string, unknown>>({
    path: `/leads/${leadId}/negotiations`, invalidate: [`/leads/${leadId}/negotiations`], successMessage: t('site.neg.saved', 'Saved'),
    onSuccess: () => { setNotes(''); setOffer(''); setCounter(''); },
  });
  const can = !!notes.trim() || Number(offer) > 0 || Number(counter) > 0;
  const s = q.data?.summary;

  return (
    <div className="space-y-5">
      <form className="space-y-5" onSubmit={(e) => {
        e.preventDefault();
        add.mutate({ notes: notes.trim() || undefined, quoted_rate_per_kw: Number(offer) > 0 ? Number(offer) : undefined, customer_counter_per_kw: Number(counter) > 0 ? Number(counter) : undefined });
      }}>
        <Field label={t('site.neg.notes', 'Discussion notes')}><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <div className="grid gap-5 md:grid-cols-2">
          <Field label={t('site.neg.offered', 'Rate offered (₹ per kW)')}><Input type="number" min="0" value={offer} onChange={(e) => setOffer(e.target.value)} /></Field>
          <Field label={t('site.neg.countered', 'Customer counter (₹ per kW)')}><Input type="number" min="0" value={counter} onChange={(e) => setCounter(e.target.value)} /></Field>
        </div>
        <Button type="submit" variant="secondary" loading={add.isPending} disabled={!can}>{t('site.neg.add', 'Save this round')}</Button>
      </form>
      {q.error && <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />}
      {s && s.rounds > 0 && (
        <Callout tone="neutral">
          {t('site.neg.summary', 'Round {{n}}', { n: s.rounds })}
          {s.latest_quoted_rate_per_kw != null && <> · {t('site.neg.lastOffer', 'offered')} <Money value={s.latest_quoted_rate_per_kw} />/kW</>}
          {s.latest_counter_per_kw != null && <> · {t('site.neg.lastCounter', 'customer asks')} <Money value={s.latest_counter_per_kw} />/kW</>}
        </Callout>
      )}
      {q.data && q.data.rows.length > 0 && (
        <ul className="divide-y divide-border text-sm">
          {q.data.rows.slice(0, 5).map((r) => (
            <li key={r.id} className="flex flex-wrap gap-x-4 gap-y-1 py-2">
              <DateText value={r.logged_at} className="text-muted" />
              {r.quoted_rate_per_kw != null && <span>{t('site.neg.offered2', 'Offered')} <Money value={r.quoted_rate_per_kw} /></span>}
              {r.customer_counter_per_kw != null && <span>{t('site.neg.countered2', 'Countered')} <Money value={r.customer_counter_per_kw} /></span>}
              {r.notes && <span className="text-muted">{r.notes}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
