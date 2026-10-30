import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/form';
import { Drawer, Modal } from '@/components/ui/overlay';
import { Callout } from '@/components/ui/surface';
import { StatusBadge } from '@/components/domain/status';
import { useAction, useGet } from '@/lib/query';
import type { OpportunityDetail, OpportunityRow } from './types';

/** Step 20: update the opportunity (the five fields of the flow) and, as the next step, create the quotation. */
export default function OpportunityDrawer({ opp, onClose }: { opp: OpportunityRow; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const detail = useGet<OpportunityDetail>(`/opportunities/${opp.id}`);
  const closed = opp.stage === 'won' || opp.stage === 'lost';
  const [prob, setProb] = useState(String(opp.probability ?? ''));
  const [kw, setKw] = useState(String(opp.kw ?? ''));
  const [rev, setRev] = useState(String(opp.expected_value ?? ''));
  const [close, setClose] = useState(opp.expected_close_date ?? '');
  const [comp, setComp] = useState(opp.competitor ?? '');

  const save = useAction<Record<string, unknown>>({ method: 'patch', path: `/opportunities/${opp.id}`, invalidate: ['/opportunities'], successMessage: t('site.opp.saved', 'Opportunity updated') });
  const create = useAction<{ opportunity_id: string }, { id: string }>({ path: '/quotes', invalidate: ['/quotes', '/opportunities'], onSuccess: (q) => navigate(`/quotes/${q.id}`) });

  const [losing, setLosing] = useState(false);
  const [why, setWhy] = useState('');
  const closeLosing = useCallback(() => setLosing(false), []);
  const lose = useAction<{ reason: string; competitor?: string }>({ path: `/opportunities/${opp.id}/lose`, invalidate: ['/opportunities', '/quotes'], successMessage: t('site.opp.lostDone', 'Marked as lost'), onSuccess: () => { setLosing(false); setWhy(''); onClose(); } });
  const reopen = useAction<Record<string, never>>({ path: `/opportunities/${opp.id}/reopen`, invalidate: ['/opportunities'], successMessage: t('site.opp.reopened', 'Opportunity reopened'), onSuccess: onClose });

  const quotes = detail.data?.quotes ?? [];
  const latest = quotes.filter((q) => q.status !== 'revised').sort((a, b) => b.version - a.version)[0] ?? null;
  const revisedByHand = rev !== String(opp.expected_value ?? '');
  const kwChanged = kw !== String(opp.kw ?? '');
  const p = Number(prob);
  const valid = prob !== '' && p >= 0 && p <= 100 && Number(kw) > 0 && rev !== '' && Number(rev) >= 0;

  const submit = () => save.mutate({
    probability: p, kw: Number(kw), ...(kwChanged && !revisedByHand ? {} : { expected_value: Number(rev) }),
    expected_close_date: close || undefined, competitor: comp.trim() || undefined,
  });

  return (
    <Drawer open onClose={onClose} title={t('site.opp.update', 'Update opportunity')} description={<span className="flex items-center gap-2">{opp.name}<StatusBadge kind="opportunity_stage" value={opp.stage} /></span>}
      footer={closed ? (
        <>
          {latest && <LinkButton variant="secondary" to={`/quotes/${latest.id}`}>{t('site.opp.openQuote', 'Open quotation')}</LinkButton>}
          <Button loading={reopen.isPending} onClick={() => reopen.mutate({})}>{t('site.opp.reopen', 'Reopen opportunity')}</Button>
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={() => setLosing(true)}>{t('site.opp.lose', 'Mark lost')}</Button>
          <Button variant="secondary" loading={save.isPending} disabled={!valid} onClick={submit}>{t('site.opp.save', 'Save changes')}</Button>
          {latest
            ? <LinkButton to={`/quotes/${latest.id}`}>{t('site.opp.openQuote', 'Open quotation')}</LinkButton>
            : <Button loading={create.isPending} onClick={() => create.mutate({ opportunity_id: opp.id })}>{t('site.opp.createQuote', 'Create quotation')}</Button>}
        </>
      )}>
      {closed ? (
        <div className="space-y-4">
          <Callout tone="neutral">{opp.stage === 'won' ? t('site.opp.closedWon', 'This opportunity was won.') : t('site.opp.closedLost', 'This opportunity was lost.')} {t('site.opp.closedHint', 'Reopen it to change the details.')}</Callout>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <div><dt className="text-muted">{t('site.opp.f.prob', 'Probability %')}</dt><dd className="font-semibold">{opp.probability ?? '—'}</dd></div>
            <div><dt className="text-muted">{t('site.opp.f.kw', 'Expected size (kW)')}</dt><dd className="font-semibold">{opp.kw ?? '—'}</dd></div>
            <div><dt className="text-muted">{t('site.opp.f.rev', 'Revenue (₹)')}</dt><dd className="font-semibold">{opp.expected_value ?? '—'}</dd></div>
            <div><dt className="text-muted">{t('site.opp.f.comp', 'Competitor')}</dt><dd className="font-semibold">{opp.competitor ?? '—'}</dd></div>
          </dl>
        </div>
      ) : (
        <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); if (valid) submit(); }}>
          <Field label={t('site.opp.f.prob', 'Probability %')} required><Input type="number" min="0" max="100" value={prob} onChange={(e) => setProb(e.target.value)} /></Field>
          <Field label={t('site.opp.f.kw', 'Expected size (kW)')} required><Input type="number" min="0" step="any" value={kw} onChange={(e) => setKw(e.target.value)} /></Field>
          <Field label={t('site.opp.f.rev', 'Revenue (₹)')} required><Input type="number" min="0" value={rev} onChange={(e) => setRev(e.target.value)} /></Field>
          <Field label={t('site.opp.f.close', 'Expected closing date')}><Input type="date" value={close} onChange={(e) => setClose(e.target.value)} /></Field>
          <Field label={t('site.opp.f.comp', 'Competitor')} optional><Input value={comp} onChange={(e) => setComp(e.target.value)} /></Field>
          {latest && <p className="text-sm text-muted">{t('site.opp.hasQuote', 'Quotation')} <Link className="code text-primary-text underline" to={`/quotes/${latest.id}`}>{latest.quote_no}</Link> {t('site.opp.exists', 'already exists.')}</p>}
        </form>
      )}
      <Modal open={losing} onClose={closeLosing} size="sm" title={t('site.opp.loseTitle', 'Mark this opportunity as lost')}
        footer={<><Button variant="ghost" onClick={closeLosing}>{t('common.cancel', 'Cancel')}</Button><Button variant="danger" loading={lose.isPending} disabled={why.trim().length < 3} onClick={() => lose.mutate({ reason: why.trim() })}>{t('site.opp.lose', 'Mark lost')}</Button></>}>
        <Field label={t('site.opp.loseWhy', 'Why was it lost?')} required><Textarea value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
      </Modal>
    </Drawer>
  );
}
