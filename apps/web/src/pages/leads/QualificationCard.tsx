import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CONTACT_OUTCOME_LABEL, TIMELINE_BUCKETS, type LeadDetail } from '@solar/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Card, CardBody, CardHeader } from '@/components/ui/surface';
import { TemperatureBadge } from '@/components/domain/status';
import { DateTimeText } from '@/components/domain/values';
import { useAction } from '@/lib/query';
import { LogContactModal } from './LogContactModal';
import { DECISION_LABEL, TEMPERATURE_MEANING, TIMELINE_LABEL } from './leadUi';

const COMPONENTS: { key: string; label: string }[] = [
  { key: 'requirement_clarity', label: 'Requirement' }, { key: 'mw_size', label: 'Size' }, { key: 'timeline', label: 'Timeline' }, { key: 'budget', label: 'Budget' }, { key: 'decision_maker', label: 'Decision maker' },
];
interface ScoreComponent { key: string; label: string; weight: number; points: number }
interface QualResult { score: { score: number; components: ScoreComponent[] } | null; temperature: string | null; qualified: boolean; gaps: string[] }

/** Temperature chip and quality score with one bar per component (steps 10–11). */
export function ScoreResult({ temperature, score, components }: { temperature: string | null | undefined; score: number | null | undefined; components: ScoreComponent[] | undefined }) {
  const { t } = useTranslation();
  const shown = COMPONENTS.map((c) => ({ ...c, comp: components?.find((x) => x.key === c.key) })).filter((c) => c.comp);
  return (
    <div className="space-y-4 rounded-lg bg-primary-soft/60 p-4" aria-label={t('leads.q.result', 'Result')}>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[15px]">
        <span className="font-semibold">{t('leads.q.temperature', 'Temperature')}</span>
        {temperature ? <><TemperatureBadge value={temperature} /><span className="text-muted">{TEMPERATURE_MEANING[temperature]?.split(' — ')[1]}</span></> : <span className="text-muted">—</span>}
        <span className="mx-1 text-border-strong" aria-hidden>|</span>
        <span className="font-semibold">{t('leads.q.score', 'Quality score')}</span>
        <span className="tabular display text-xl">{score ?? '—'}</span>
      </p>
      {shown.length > 0 && (
        <ul className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
          {shown.map(({ key, label, comp }) => {
            const pct = comp && comp.weight > 0 ? Math.max(0, Math.min(100, Math.round((comp.points / comp.weight) * 100))) : 0;
            return (
              <li key={key} className="text-sm">
                <div className="flex justify-between"><span>{t(`leads.q.c.${key}`, label)}</span><span className="tabular text-muted">{comp!.points}/{comp!.weight}</span></div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface" role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} /></div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function QualificationCard({ detail }: { detail: LeadDetail }) {
  const { t } = useTranslation();
  const { lead, contact_logs: logs, score } = detail;
  const first = logs.length ? logs[logs.length - 1]! : null; // contact logs arrive newest first
  const [logOpen, setLogOpen] = useState(false);
  const [f, setF] = useState({
    requirement_text: lead.requirement_text ?? '', timeline_bucket: lead.timeline_bucket ?? '', budget_inr: lead.budget_inr != null ? String(lead.budget_inr) : '',
    decision_maker: lead.decision_maker ?? '', capacity_kw: lead.capacity_kw != null ? String(lead.capacity_kw) : '',
  });
  const [result, setResult] = useState<QualResult | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const save = useAction<Record<string, unknown>, QualResult>({
    path: `/leads/${lead.id}/qualification`, invalidate: ['/leads', '/followups'], successMessage: t('leads.q.saved', 'Qualification saved'), toastError: false,
    onSuccess: (r) => { setResult(r); setErrs({}); },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  const submit = () => {
    const e: Record<string, string> = {};
    if (!f.requirement_text.trim()) e['requirement_text'] = 'Describe what the customer wants';
    if (!f.timeline_bucket) e['timeline_bucket'] = 'Choose a timeline';
    if (!f.decision_maker) e['decision_maker'] = 'Choose who decides';
    setErrs(e);
    if (Object.keys(e).length) return;
    save.mutate({
      requirement_text: f.requirement_text.trim(), timeline_bucket: f.timeline_bucket, decision_maker: f.decision_maker,
      ...(f.budget_inr && { budget_inr: Number(f.budget_inr) }), ...(f.capacity_kw && { capacity_kw: Number(f.capacity_kw) }),
    }, { onError: (err) => setErrs({ form: err.message, ...err.fieldErrors }) });
  };
  const live = result ?? null;

  return (
    <Card>
      <CardHeader title={t('leads.q.title', '1) Contact and qualification')} description={t('leads.q.sub', 'Steps 8 to 11')} />
      <CardBody className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold">{t('leads.q.initial', 'Initial contact')}</h3>
            {first ? (
              <p className="mt-1 text-sm text-muted">
                {first.channel === 'whatsapp' ? 'WhatsApp' : first.channel === 'visit' ? 'Visit' : 'Call'} — {CONTACT_OUTCOME_LABEL[first.outcome]} · <DateTimeText value={first.occurred_at} />
              </p>
            ) : <p className="mt-1 text-sm text-muted">{t('leads.q.noContact', 'No contact logged yet.')}</p>}
          </div>
          <Button variant="secondary" size="sm" onClick={() => setLogOpen(true)}>{first ? t('fu.log', 'Log a contact') : t('leads.q.logFirst', 'Log initial contact')}</Button>
        </div>

        <div className="space-y-5 border-t border-border pt-5">
          <h3 className="text-sm font-bold">{t('leads.q.call', 'Qualification call')}</h3>
          {errs['form'] && <p role="alert" className="text-sm text-danger-text">{errs['form']}</p>}
          <Field label={t('leads.q.req', 'Requirement')} required error={errs['requirement_text']}><Textarea rows={2} value={f.requirement_text} onChange={set('requirement_text')} /></Field>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label={t('leads.q.timeline', 'Timeline')} required error={errs['timeline_bucket']}>
              <Select placeholder={t('common.choose', 'Choose…')} value={f.timeline_bucket} onChange={set('timeline_bucket')}>{TIMELINE_BUCKETS.map((b) => <option key={b} value={b}>{TIMELINE_LABEL[b]}</option>)}</Select>
            </Field>
            <Field label={t('leads.q.decision', 'Decision maker')} required error={errs['decision_maker']}>
              <Select placeholder={t('common.choose', 'Choose…')} value={f.decision_maker} onChange={set('decision_maker')}>{Object.entries(DECISION_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
            </Field>
            <Field label={t('leads.q.budget', 'Budget (₹)')} optional error={errs['budget_inr']}><Input inputMode="numeric" value={f.budget_inr} onChange={set('budget_inr')} /></Field>
            <Field label={t('leads.q.kw', 'Size (kW)')} optional error={errs['capacity_kw']}><Input inputMode="decimal" value={f.capacity_kw} onChange={set('capacity_kw')} /></Field>
          </div>
          <Button loading={save.isPending} onClick={submit}>{t('leads.q.save', 'Save qualification')}</Button>
        </div>

        {(live || score) && (
          <div className="space-y-2">
            <ScoreResult temperature={live?.temperature ?? lead.temperature} score={live?.score?.score ?? score?.score ?? lead.quality_score} components={live?.score?.components ?? score?.components} />
            {live && live.gaps.length > 0 && <p className="text-sm text-muted">{t('leads.q.gaps', 'Still needed to qualify:')} {live.gaps.join(', ')}</p>}
            {live?.qualified && <Badge tone="success">{t('leads.q.qualified', 'Qualified')}</Badge>}
          </div>
        )}
      </CardBody>
      {logOpen && <LogContactModal open leadId={lead.id} leadName={lead.name} title={first ? undefined : t('leads.q.logFirst', 'Log initial contact')} onClose={() => setLogOpen(false)} />}
    </Card>
  );
}
