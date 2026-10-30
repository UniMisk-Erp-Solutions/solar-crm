import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LeadDetail } from '@solar/shared';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/form';
import { Card, CardBody, CardHeader } from '@/components/ui/surface';
import { DateTimeText } from '@/components/domain/values';
import { cn } from '@/lib/cn';
import { useAction, useList } from '@/lib/query';
import { toIso, toLocalInput } from './leadUi';

const CADENCE: { temp: string; label: string }[] = [
  { temp: 'hot', label: 'Hot — same day or daily' }, { temp: 'warm', label: 'Warm — every 2 to 5 days' }, { temp: 'cold', label: 'Cold — weekly' },
];
interface UserRow { id: string; full_name: string }

/** The four fields every lead must always have (step 12), and the next reminder the follow-up engine has planned (step 13). */
export function NextActionCard({ detail }: { detail: LeadDetail }) {
  const { t } = useTranslation();
  const { lead, followups } = detail;
  const users = useList<UserRow>('/admin/users', { active: true, limit: 200 }, { retry: false });
  const [f, setF] = useState({ last_action: lead.last_action ?? '', next_action: lead.next_action ?? '', next_followup_at: toLocalInput(lead.next_followup_at), owner_id: lead.owner_id ?? '' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const save = useAction<Record<string, unknown>>({ method: 'patch', path: `/leads/${lead.id}`, invalidate: ['/leads', '/followups'], successMessage: t('leads.next.saved', 'Saved'), toastError: false });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  const nextReminder = followups.filter((x) => x.status === 'open').sort((a, b) => a.due_at.localeCompare(b.due_at))[0];
  const owners = users.data?.data ?? [];
  const ownerOptions = lead.owner_id && !owners.some((u) => u.id === lead.owner_id) ? [{ id: lead.owner_id, full_name: lead.owner_name ?? 'Current owner' }, ...owners] : owners;

  const submit = () => {
    const e: Record<string, string> = {};
    if (!f.last_action.trim()) e['last_action'] = 'Last action is required';
    if (!f.next_action.trim()) e['next_action'] = 'Next action is required on every lead';
    if (!f.next_followup_at) e['next_followup_at'] = 'Next follow-up date is required';
    if (!f.owner_id) e['owner_id'] = 'Owner is required';
    setErrs(e);
    if (Object.keys(e).length) return;
    const body: Record<string, unknown> = { last_action: f.last_action.trim(), next_action: f.next_action.trim(), owner_id: f.owner_id };
    if (f.next_followup_at !== toLocalInput(lead.next_followup_at)) body['next_followup_at'] = toIso(f.next_followup_at);
    save.mutate(body, { onError: (err) => setErrs({ form: err.message, ...err.fieldErrors }) });
  };

  return (
    <Card>
      <CardHeader title={t('leads.next.title', '2) Next action')} description={t('leads.next.sub', 'Steps 12 and 13 — every lead always has these four.')} />
      <CardBody className="space-y-5">
        {errs['form'] && <p role="alert" className="text-sm text-danger-text">{errs['form']}</p>}
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={t('leads.next.last', 'Last action')} required error={errs['last_action']}><Input value={f.last_action} onChange={set('last_action')} /></Field>
          <Field label={t('leads.next.next', 'Next action')} required error={errs['next_action']}><Input value={f.next_action} onChange={set('next_action')} /></Field>
          <Field label={t('leads.next.date', 'Next follow-up date')} required error={errs['next_followup_at']}><Input type="datetime-local" value={f.next_followup_at} onChange={set('next_followup_at')} /></Field>
          <Field label={t('leads.next.owner', 'Owner')} required error={errs['owner_id']}>
            <Select placeholder={t('common.choose', 'Choose…')} value={f.owner_id} onChange={set('owner_id')}>{ownerOptions.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</Select>
          </Field>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">
            {nextReminder ? <>{t('leads.next.reminder', 'Next reminder')}: <DateTimeText value={nextReminder.due_at} className="font-semibold text-fg" /></> : t('leads.next.noReminder', 'No reminder planned yet.')}
          </p>
          <Button loading={save.isPending} onClick={submit}>{t('leads.next.save', 'Save')}</Button>
        </div>
        <ul className="flex flex-wrap gap-2 border-t border-border pt-4" aria-label={t('leads.next.cadence', 'Follow-up rhythm by temperature')}>
          {CADENCE.map((c) => (
            <li key={c.temp} className={cn('rounded-full border px-3 py-1 text-xs font-semibold', lead.temperature === c.temp ? 'border-primary bg-primary-soft text-primary-text' : 'border-border text-muted')}>{c.label}</li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
