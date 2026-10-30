import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Card, CardBody, CardHeader } from '@/components/ui/surface';
import { DateTimeText } from '@/components/domain/values';
import { useAction } from '@/lib/query';
import { commercialApprovers, type QuoteDetail } from './types';

/** Step 22: margin and floor price in one line, and whether special pricing needs approval (and from whom). */
export function PriceReviewCard({ quote }: { quote: QuoteDetail }) {
  const { t } = useTranslation();
  const floor = quote.floor_check;
  const below = floor ? floor.lines.filter((l) => l.below_floor).length : 0;
  const approvers = commercialApprovers(quote);
  const needs = approvers.length > 0 || quote.discount_pct > 0 || below > 0 || (floor ? !floor.ok : false);

  const margin = quote.margin_pct == null ? t('quote.price.noMargin', 'Margin not available') : `${t('quote.price.margin', 'Margin')} ${quote.margin_pct}%`;
  const floorText = !floor ? '' : floor.ok ? t('quote.price.floorOk', 'above the floor price') : below > 0 ? t('quote.price.floorBelow', 'below the floor price on {{n}} line(s)', { n: below }) : t('quote.price.marginLow', 'below the minimum margin');

  return (
    <Card>
      <CardHeader title={<><span className="code mr-2 text-primary-text">2</span>{t('quote.price.title', 'Price review')}</>} />
      <CardBody className="space-y-4">
        <p className="text-[15px]">{margin}{floorText && <> · {floorText}</>}</p>
        <div>
          <p className="text-sm font-semibold">{t('quote.price.special', 'Special pricing / discount needed?')}</p>
          {needs ? (
            <p className="mt-1 text-[15px]">
              {t('quote.price.yes', 'Yes')}
              {approvers.length > 0
                ? <> — {t('quote.price.approvers', 'approval needed from')} <strong>{approvers.join(' → ')}</strong>.</>
                : <> — {t('quote.price.routed', 'the system will route it to the right approvers when you send it for approval.')}</>}
            </p>
          ) : (
            <p className="mt-1 text-[15px]">{t('quote.price.no', 'No — no special approval is needed.')}</p>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

const KINDS = [['call', 'Call'], ['whatsapp', 'WhatsApp'], ['meeting', 'Meeting']] as const;

/** Step 25: log the customer discussion and the next follow-up; shows the automatic reminder cadence. */
export function DiscussionCard({ quote }: { quote: QuoteDetail }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState('call');
  const [notes, setNotes] = useState('');
  const [next, setNext] = useState('');
  const open = ['sent', 'negotiation', 'accepted'].includes(quote.status);
  const days = quote.followups?.length ? [...new Set(quote.followups.map((f) => f.day))].sort((a, b) => a - b) : [1, 3, 5, 7];
  const log = useAction<Record<string, unknown>>({
    path: `/quotes/${quote.id}/discussions`, invalidate: ['/quotes'], successMessage: t('quote.talk.saved', 'Discussion logged'),
    onSuccess: () => { setNotes(''); setNext(''); },
  });
  return (
    <Card>
      <CardHeader title={<><span className="code mr-2 text-primary-text">3</span>{t('quote.talk.title', 'Customer discussion')}</>} />
      <CardBody className="space-y-5">
        <p className="text-sm text-muted">{t('quote.talk.reminders', 'Reminders')}: {days.map((d) => `Day ${d}`).join(' · ')}, {t('quote.talk.then', 'then escalation')}</p>
        {!open ? (
          <p className="text-sm text-muted">{t('quote.talk.later', 'You can log calls, WhatsApp messages and meetings once the quotation has been sent.')}</p>
        ) : (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); log.mutate({ kind, notes: notes.trim() || undefined, next_followup_at: next ? new Date(next).toISOString() : undefined }); }}>
            <div className="grid gap-5 md:grid-cols-3">
              <Field label={t('quote.talk.kind', 'How did you talk?')}><Select value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
              <Field label={t('quote.talk.next', 'Next follow-up')} optional className="md:col-span-2"><Input type="datetime-local" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
            </div>
            <Field label={t('quote.talk.notes', 'Notes')}><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            <Button type="submit" variant="secondary" loading={log.isPending} disabled={!notes.trim()}>{t('quote.talk.log', 'Log discussion')}</Button>
          </form>
        )}
        {quote.discussions.length > 0 && (
          <ul className="divide-y divide-border text-sm">
            {quote.discussions.slice(0, 5).map((d) => (
              <li key={d.id} className="flex flex-wrap gap-x-3 gap-y-1 py-2"><span className="font-semibold capitalize">{d.kind}</span><DateTimeText value={d.logged_at} className="text-muted" />{d.notes && <span>{d.notes}</span>}</li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
