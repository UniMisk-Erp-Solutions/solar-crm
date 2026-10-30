import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FileText, Trash2, Upload } from 'lucide-react';
import type { FormFieldDef } from '@solar/shared';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Callout, ErrorState, Spinner } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { invalidatePaths, useAction, useGet, useList } from '@/lib/query';

interface RequirementView {
  lead_id: string; segment: string | null; config: { fields: FormFieldDef[] } | null; data: Record<string, unknown>; completed: boolean; message: string | null;
}
type Values = Record<string, string>;

const SEGMENTS: [string, string][] = [['pmsg_residential', 'Residential (PM Surya Ghar)'], ['rwa_ghs', 'Housing society (RWA / GHS)'], ['ci_net_metered', 'Commercial / industrial — net metered'], ['ci_captive', 'Commercial / industrial — captive'], ['open_access', 'Open access'], ['pm_kusum', 'Farmer (PM-KUSUM)'], ['government_bid', 'Government bid']];

/** The step-15 chart asks for exactly these: Site, MW, Load type, Timeline, Specs — and Documents (uploads, below). Nothing else. */
const CHART: { key: string; alt?: string; title: string; required: boolean }[] = [
  { key: 'site_note', title: 'Site', required: true },
  { key: 'capacity_kw', title: 'MW', required: true },
  { key: 'load_type', title: 'Load type', required: true },
  { key: 'timeline_bucket', title: 'Timeline', required: true },
  { key: 'specs', alt: 'specs_notes', title: 'Specs', required: false },
];

const DOC_TYPES: [string, string][] = [['electricity_bill', 'Electricity bill'], ['site_photo', 'Site photo'], ['layout', 'Layout / drawing'], ['sanction_letter', 'Sanction letter'], ['other', 'Other']];
const label = (s: string): string => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

interface DocRow { id: string; doc_type: string; file_name: string; size_bytes: number | null; created_at: string }

/** Step 15 (Requirement Capture Form): Site · MW · Load type · Timeline · Specs · Documents. */
export function RequirementStep({ leadId }: { leadId: string }) {
  const { t } = useTranslation();
  const q = useGet<RequirementView>(`/leads/${leadId}/requirement`);
  const [vals, setVals] = useState<Values>({});
  const save = useAction<{ data: Record<string, unknown>; complete: boolean; chart_only: boolean }>({ method: 'put', path: `/leads/${leadId}/requirement`, invalidate: ['/leads'], successMessage: t('site.req.saved', 'Requirement saved') });
  const setSegment = useAction<{ segment: string }>({ method: 'patch', path: `/leads/${leadId}`, invalidate: ['/leads'], successMessage: t('site.req.segmentSaved', 'Segment saved'), onSuccess: () => void q.refetch() });

  useEffect(() => {
    if (!q.data) return;
    const init: Values = {};
    for (const [k, v] of Object.entries(q.data.data ?? {})) init[k] = v == null ? '' : String(v);
    setVals(init);
  }, [q.data]);

  if (q.isLoading) return <Spinner label={t('common.loading', 'Loading')} />;
  if (q.error) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  if (!q.data?.config) {
    return (
      <div className="space-y-4">
        <Callout tone="neutral">{t('site.req.noSegment', 'Choose what kind of customer this is, and the requirement form opens.')}</Callout>
        <Field label={t('site.req.segment', 'Customer segment')} htmlFor="req-segment">
          <Select id="req-segment" value="" disabled={setSegment.isPending} onChange={(e) => e.target.value && setSegment.mutate({ segment: e.target.value })} placeholder="Select">{SEGMENTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </Field>
      </div>
    );
  }

  const all = q.data.config.fields;
  const fields = CHART
    .map((c) => ({ c, f: all.find((x) => x.key === c.key) ?? (c.alt ? all.find((x) => x.key === c.alt) : undefined) }))
    .filter((x): x is { c: (typeof CHART)[number]; f: FormFieldDef } => !!x.f);
  const set = (k: string, v: string) => setVals((p) => ({ ...p, [k]: v }));
  const kw = Number(vals['capacity_kw']);
  const filled = (k: string) => (vals[k] ?? '').trim() !== '';

  const render = ({ c, f }: { c: (typeof CHART)[number]; f: FormFieldDef }) => {
    const v = vals[f.key] ?? '';
    const id = `req-${f.key}`;
    const hint = f.key === 'capacity_kw'
      ? (kw > 0 ? `${(kw / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 })} MW` : 'Plant size in kW (1,000 kW = 1 MW)')
      : undefined;
    const wide = f.type === 'textarea' || c.key === 'site_note' ? 'md:col-span-2' : undefined;
    return (
      <Field key={f.key} label={c.title} htmlFor={id} required={c.required} hint={hint} className={wide}>
        {f.type === 'select' ? (
          <Select id={id} value={v} onChange={(e) => set(f.key, e.target.value)} placeholder="Select">{(f.options ?? []).map((o) => <option key={o} value={o}>{label(o)}</option>)}</Select>
        ) : f.type === 'textarea' ? (
          <Textarea id={id} rows={3} value={v} onChange={(e) => set(f.key, e.target.value)} placeholder="Technical requirements, brands, preferences" />
        ) : f.type === 'number' ? (
          <Input id={id} type="number" min={0} step="any" value={v} onChange={(e) => set(f.key, e.target.value)} placeholder="kW" />
        ) : (
          <Input id={id} type="text" value={v} onChange={(e) => set(f.key, e.target.value)} placeholder="Address, and roof or land" />
        )}
      </Field>
    );
  };

  return (
    <div className="space-y-8">
      <form className="space-y-6" onSubmit={(e) => {
        e.preventDefault();
        const data: Record<string, unknown> = {};
        for (const { f } of fields) if (filled(f.key)) data[f.key] = vals[f.key];
        const complete = fields.filter(({ c }) => c.required).every(({ f }) => filled(f.key));
        save.mutate({ data, complete, chart_only: true });
      }}>
        <div className="grid gap-5 md:grid-cols-2">{fields.map(render)}</div>
        <div><Button type="submit" variant="secondary" loading={save.isPending}>{t('site.req.save', 'Save requirement')}</Button></div>
      </form>
      <DocumentsPanel leadId={leadId} />
    </div>
  );
}

/** Documents / images for the requirement: bill, site photos, layouts. Stored privately; Aadhaar must never be uploaded. */
function DocumentsPanel({ leadId }: { leadId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState('electricity_bill');
  const [busy, setBusy] = useState(false);
  const list = useList<DocRow>('/documents', { entity_type: 'lead', entity_id: leadId, limit: 50 });
  const refresh = () => invalidatePaths(qc, ['/documents']);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append('entity_type', 'lead'); form.append('entity_id', leadId); form.append('doc_type', docType); form.append('file', file);
        await api.upload('/documents', form);
      }
      toast.success(t('site.req.uploaded', 'Uploaded'));
      await refresh();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  const open = async (id: string) => { try { const r = await api.get<{ data: { url: string } }>(`/documents/${id}/url`); window.open(r.data.url, '_blank', 'noopener'); } catch (e) { toast.error(errorMessage(e)); } };
  const remove = async (id: string) => { try { await api.del(`/documents/${id}`); await refresh(); } catch (e) { toast.error(errorMessage(e)); } };

  return (
    <section aria-labelledby="req-h-docs">
      <div className="mb-3 flex items-baseline gap-3">
        <h3 id="req-h-docs" className="font-sans text-base font-bold">{t('site.req.sec.docs', 'Documents')}</h3>
        <span className="text-sm text-muted">{t('site.req.docsHint', 'Bill, site photos, layouts — PDF, JPG, PNG or WebP')}</span>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('site.req.docType', 'What is it?')} htmlFor="req-doc-type" className="w-56">
          <Select id="req-doc-type" value={docType} onChange={(e) => setDocType(e.target.value)}>{DOC_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </Field>
        <input ref={input} type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf" className="sr-only" aria-label={t('site.req.chooseFiles', 'Choose files to upload')} onChange={(e) => void upload(e.target.files)} />
        <Button type="button" variant="secondary" loading={busy} leftIcon={<Upload className="h-4 w-4" />} onClick={() => input.current?.click()}>{t('site.req.upload', 'Upload files')}</Button>
      </div>
      <p className="mt-2 text-xs text-subtle">{t('site.req.noAadhaar', 'Do not upload Aadhaar cards or Aadhaar numbers.')}</p>
      {list.isError && <p className="mt-3 text-sm text-danger-text">{errorMessage(list.error)}</p>}
      {!!list.data?.data.length && (
        <ul className="mt-4 divide-y divide-line rounded-lg border border-line">
          {list.data.data.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <FileText className="h-4 w-4 shrink-0 text-muted" aria-hidden />
              <button type="button" className="min-w-0 flex-1 truncate text-left font-medium hover:underline" onClick={() => void open(d.id)}>{d.file_name}</button>
              <span className="text-muted">{label(d.doc_type)}</span>
              <button type="button" aria-label={`Delete ${d.file_name}`} className="text-muted hover:text-danger-text" onClick={() => void remove(d.id)}><Trash2 className="h-4 w-4" /></button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
