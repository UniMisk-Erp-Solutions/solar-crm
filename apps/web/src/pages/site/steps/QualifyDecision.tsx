import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button, LinkButton } from '@/components/ui/button';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/form';
import { Card, CardBody, CardHeader } from '@/components/ui/surface';
import { useAction, useGet } from '@/lib/query';
import type { ConvertCheck, VisitLead } from '../types';

const CONFIRMS = [
  ['requirement_confirmed', 'Requirement confirmed'],
  ['timeline_confirmed', 'Timeline confirmed'],
  ['commercial_potential_confirmed', 'Commercial potential confirmed'],
] as const;
type Confirm = (typeof CONFIRMS)[number][0];

const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); };

/** The PDF decision "Qualified project / real opportunity?": YES converts to an opportunity (step 19), NO moves the lead to nurture / recycle. */
export function QualifyDecision({ lead, onDone }: { lead: VisitLead; onDone: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const check = useGet<ConvertCheck>(`/leads/${lead.id}/convert-check`);
  const [ticks, setTicks] = useState<Record<Confirm, boolean>>({ requirement_confirmed: false, timeline_confirmed: false, commercial_potential_confirmed: false });
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');

  const convert = useAction<Record<string, boolean>>({
    path: `/leads/${lead.id}/convert`, invalidate: ['/leads', '/opportunities', '/surveys'], successMessage: t('site.decide.converted', 'Converted to opportunity'),
    onSuccess: () => { onDone(); navigate('/site?tab=opportunities'); },
  });
  const nurture = useAction<{ reason: string; nurture_until: string }>({
    path: `/leads/${lead.id}/nurture`, invalidate: ['/leads'], successMessage: t('site.decide.nurtured', 'Moved to nurture'), onSuccess: onDone,
  });

  const c = check.data;
  const reasons: string[] = [];
  if (c) {
    if (c.opportunity_id) reasons.push(t('site.decide.already', 'This lead is already an opportunity.'));
    else if (!c.status_ok) reasons.push(t('site.decide.status', 'The lead is not at a stage where it can be converted.'));
    for (const p of c.prerequisites) if (!p.ok) reasons.push(p.hint || p.label);
  }
  for (const [k, label] of CONFIRMS) if (!ticks[k]) reasons.push(t('site.decide.tick', 'Tick “{{label}}”.', { label }));
  const blocked = !c || reasons.length > 0;
  const converted = lead.status === 'opportunity' || lead.status === 'won' || !!c?.opportunity_id;

  // already decided: show the outcome instead of asking again (the steps above stay editable)
  if (converted) {
    return (
      <Card>
        <CardHeader title={t('site.decide.doneTitle', 'Qualified project: converted')} description={t('site.decide.doneSub', 'This lead is already an opportunity, so there is nothing left to decide here.')} />
        <CardBody className="flex flex-wrap items-center justify-between gap-4">
          <p className="text-sm text-muted">{t('site.decide.doneHint', 'You can still correct the visit, requirement, products and rate above. Continue the deal from the opportunity.')}</p>
          <LinkButton to="/site?tab=opportunities">{t('site.decide.openOpp', 'Open the opportunity')}</LinkButton>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title={t('site.decide.title', 'Qualified project / real opportunity?')} description={t('site.decide.rule', 'Do not convert unless requirement, timeline and commercial potential are confirmed.')} />
      <CardBody className="space-y-6">
        <fieldset className="space-y-3">
          <legend className="sr-only">{t('site.decide.confirms', 'Confirmations')}</legend>
          {CONFIRMS.map(([k, label]) => (
            <Checkbox key={k} label={t(`site.decide.${k}`, label)} checked={ticks[k]} onChange={(e) => setTicks((p) => ({ ...p, [k]: e.target.checked }))} />
          ))}
        </fieldset>

        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-3 rounded-lg border border-border p-5">
            <h3 className="font-sans text-base font-bold">{t('site.decide.yes', 'YES')}</h3>
            <Button loading={convert.isPending} disabled={blocked} onClick={() => convert.mutate({ requirement_confirmed: ticks.requirement_confirmed, timeline_confirmed: ticks.timeline_confirmed, commercial_potential_confirmed: ticks.commercial_potential_confirmed })}>
              {t('site.decide.convert', 'Convert to opportunity')}
            </Button>
            {blocked && reasons.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted" aria-label={t('site.decide.why', 'Why you cannot convert yet')}>
                {reasons.map((r) => <li key={r}>{r}</li>)}
              </ul>
            )}
          </div>

          <form className="space-y-3 rounded-lg border border-border p-5" onSubmit={(e) => { e.preventDefault(); nurture.mutate({ reason: reason.trim(), nurture_until: until }); }}>
            <h3 className="font-sans text-base font-bold">{t('site.decide.no', 'NO')}</h3>
            <Field label={t('site.decide.reason', 'Reason')}><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <Field label={t('site.decide.reengage', 'Re-engagement date')}><Input type="date" min={tomorrow()} value={until} onChange={(e) => setUntil(e.target.value)} /></Field>
            <Button type="submit" variant="secondary" loading={nurture.isPending} disabled={reason.trim().length < 3 || !until}>{t('site.decide.nurture', 'Nurture / recycle')}</Button>
          </form>
        </div>
      </CardBody>
    </Card>
  );
}
