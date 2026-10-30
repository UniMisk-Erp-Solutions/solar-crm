import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Callout, Card, CardBody, CardHeader, ErrorState, KeyValue, Page, PageHeader, SkeletonRows } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { invalidatePaths, useGet } from '@/lib/query';
import { useQueryClient } from '@tanstack/react-query';

interface SlaSetting { key: string; value: unknown }

/** The PDF's SLA boxes. `key` is the /admin/sla key (rule `sla.<key>`). */
const FIELDS: { key: string; group: string; label: string; unit: string; fallback: number | number[] }[] = [
  { key: 'lead_acceptance_minutes.hot', group: 'Lead acceptance', label: 'Hot lead — accept within', unit: 'minutes (chart: 15–30 min)', fallback: 30 },
  { key: 'lead_acceptance_minutes.warm', group: 'Lead acceptance', label: 'Warm lead — accept within', unit: 'minutes (chart: 2 hrs = 120)', fallback: 120 },
  { key: 'lead_acceptance_reassign_minutes.hot', group: 'Lead acceptance', label: 'Hot lead — auto-reassign after the DSM alert', unit: 'minutes', fallback: 15 },
  { key: 'lead_acceptance_reassign_minutes.warm', group: 'Lead acceptance', label: 'Warm lead — auto-reassign after the DSM alert', unit: 'minutes', fallback: 60 },
  { key: 'lead_acceptance_reassign_minutes.cold', group: 'Lead acceptance', label: 'Cold lead — auto-reassign after the DSM alert', unit: 'minutes', fallback: 120 },
  { key: 'followup_days.hot', group: 'Follow-up', label: 'Hot lead — follow up every', unit: 'day (chart: same day / daily)', fallback: 1 },
  { key: 'followup_days.warm', group: 'Follow-up', label: 'Warm lead — follow up every', unit: 'days (chart: 2–5 days)', fallback: 3 },
  { key: 'followup_days.cold', group: 'Follow-up', label: 'Cold lead — follow up every', unit: 'days (chart: weekly)', fallback: 7 },
  { key: 'quote_followup_days', group: 'Quote follow-up', label: 'Remind on days', unit: 'days after sending, then escalation (chart: 1, 3, 5, 7)', fallback: [1, 3, 5, 7] },
];

const asText = (v: unknown, fb: number | number[]) => (Array.isArray(v) ? v : v ?? fb) as number | number[];
const show = (v: number | number[]) => (Array.isArray(v) ? v.join(', ') : String(v));

export default function SettingsPage() {
  return (
    <Page>
      <PageHeader title="Settings" subtitle="Reminder times and your account." />
      <div className="space-y-8">
        <SlaCard />
        <AccountCard />
      </div>
    </Page>
  );
}

function SlaCard() {
  const q = useGet<SlaSetting[]>('/admin/sla');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const qc = useQueryClient();

  if (q.error) return <Card><ErrorState message={q.error.message} onRetry={() => void q.refetch()} /></Card>;
  if (q.isLoading || !q.data) return <Card><CardBody><SkeletonRows rows={5} /></CardBody></Card>;
  const current = (key: string, fb: number | number[]) => show(asText(q.data.find((s) => s.key === key)?.value, fb));
  const dirty = FIELDS.filter((f) => edits[f.key] !== undefined && edits[f.key]!.trim() !== current(f.key, f.fallback));

  async function save() {
    setSaving(true); setError(null);
    try {
      for (const f of dirty) {
        const raw = edits[f.key]!.trim();
        const value = Array.isArray(f.fallback) ? raw.split(/[,\s]+/).filter(Boolean).map(Number) : Number(raw);
        const bad = Array.isArray(value) ? value.length === 0 || value.some((n) => !Number.isFinite(n) || n <= 0) : !Number.isFinite(value) || value < 0;
        if (bad) throw new Error(`"${f.label}" needs ${Array.isArray(f.fallback) ? 'a list of day numbers, e.g. 1, 3, 5, 7' : 'a number'}.`);
        await api.put('/admin/sla', { key: f.key, value, source_name: 'Set by admin in Settings', source_ref: 'Settings page' });
      }
      await invalidatePaths(qc, ['/admin/sla']);
      setEdits({});
      toast.success('Times saved');
    } catch (e) { setError(errorMessage(e)); } finally { setSaving(false); }
  }

  let lastGroup = '';
  return (
    <Card>
      <CardHeader title="Reminder and SLA times" description="How quickly leads must be accepted and followed up. A change takes effect from today." />
      <CardBody className="space-y-6">
        {FIELDS.map((f) => {
          const head = f.group !== lastGroup ? f.group : null;
          lastGroup = f.group;
          return (
            <div key={f.key} className="space-y-3">
              {head && <h3 className="font-sans text-sm font-bold uppercase tracking-wide text-muted">{head}</h3>}
              <Field label={f.label} hint={f.unit} className="max-w-md">
                <Input value={edits[f.key] ?? current(f.key, f.fallback)} onChange={(e) => setEdits((s) => ({ ...s, [f.key]: e.target.value }))} />
              </Field>
              {f.key === 'lead_acceptance_minutes.warm' && <p className="text-sm text-muted">Cold lead — accepted by the end of the same working day (fixed).</p>}
            </div>
          );
        })}
        {error && <Callout tone="danger">{error}</Callout>}
        <Button loading={saving} disabled={dirty.length === 0} onClick={() => void save()}>Save changes</Button>
      </CardBody>
    </Card>
  );
}

function AccountCard() {
  const { me, signOut } = useAuth();
  const nav = useNavigate();
  return (
    <Card>
      <CardHeader title="Account" />
      <CardBody className="space-y-5">
        <KeyValue items={[{ label: 'Name', value: me?.profile.full_name }, { label: 'E-mail', value: me?.profile.email }]} />
        <Button variant="secondary" onClick={() => void signOut().then(() => nav('/login'))}>Sign out</Button>
      </CardBody>
    </Card>
  );
}
