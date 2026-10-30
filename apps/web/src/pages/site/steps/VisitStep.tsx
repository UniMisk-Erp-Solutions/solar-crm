import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Callout, Spinner } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';
import { DateText, DateTimeText } from '@/components/domain/values';
import { api, errorMessage, type One } from '@/lib/api';
import { invalidatePaths, useAction, useGet } from '@/lib/query';
import type { SurveyView, VisitLead } from '../types';

const ROOFS = [['rcc', 'RCC'], ['metal_sheet', 'Metal sheet'], ['asbestos', 'Asbestos'], ['tile', 'Tile'], ['ground_mount', 'Ground mount'], ['other', 'Other']] as const;
const SHADING = [['none', 'None'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] as const;

function where(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }), () => resolve(null), { timeout: 4000 });
  });
}

/** Step 14: schedule the visit, complete it with notes, add geo-tagged photos, and show the DISCOM feasibility dates above 10 kW. */
export function VisitStep({ lead, surveyId }: { lead: VisitLead; surveyId: string | null }) {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useGet<SurveyView>(surveyId ? `/surveys/${surveyId}` : null);
  const [when, setWhen] = useState('');
  const [shading, setShading] = useState('');
  const [roof, setRoof] = useState('');
  const [area, setArea] = useState('');
  const [notes, setNotes] = useState('');
  const [sub, setSub] = useState('');
  const [done, setDone] = useState('');
  const files = useRef<HTMLInputElement>(null);

  const refresh = ['/surveys', '/leads'];
  const schedule = useAction<{ lead_id: string; scheduled_at: string }>({ path: '/surveys', invalidate: refresh, successMessage: t('site.visit.scheduled', 'Visit scheduled') });
  const complete = useAction<Record<string, unknown>>({ method: 'patch', path: `/surveys/${surveyId}`, invalidate: refresh, successMessage: t('site.visit.completed', 'Visit completed') });
  const feas = useAction<Record<string, unknown>>({ method: 'patch', path: `/surveys/${surveyId}/feasibility`, invalidate: refresh, successMessage: t('site.visit.feasSaved', 'Dates saved') });
  const upload = useMutation({
    mutationFn: async (list: File[]) => {
      const form = new FormData();
      list.forEach((f) => form.append('photos', f));
      const pos = await where();
      if (pos) { form.append('lat', String(pos.lat)); form.append('lng', String(pos.lng)); }
      return api.upload<One<unknown>>(`/surveys/${surveyId}/photos`, form);
    },
    onSuccess: async () => { await invalidatePaths(qc, ['/surveys']); toast.success(t('site.visit.photosOk', 'Photos uploaded')); if (files.current) files.current.value = ''; },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (surveyId && q.isLoading) return <Spinner label={t('common.loading', 'Loading')} />;
  const s = q.data;
  const status = s?.status;
  const f = s?.feasibility;
  const needsDiscom = !!f && (f.required === true || (lead.capacity_kw ?? 0) > f.threshold_kw);

  return (
    <div className="space-y-5">
      {!surveyId && (
        <form className="flex flex-wrap items-end gap-4" onSubmit={(e) => { e.preventDefault(); if (when) schedule.mutate({ lead_id: lead.id, scheduled_at: new Date(when).toISOString() }); }}>
          <Field label={t('site.visit.when', 'Visit date and time')} className="min-w-64"><Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
          <Button type="submit" variant="secondary" loading={schedule.isPending} disabled={!when}>{t('site.visit.schedule', 'Schedule visit')}</Button>
        </form>
      )}

      {s && status === 'scheduled' && (
        <>
          <p className="text-[15px]">{t('site.visit.on', 'Visit scheduled for')} <strong><DateTimeText value={s.scheduled_at} /></strong></p>
          <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); complete.mutate({ status: 'completed', shading, roof_type: roof, roof_area_sqm: Number(area), notes: notes || undefined }); }}>
            <div className="grid gap-5 md:grid-cols-3">
              <Field label={t('site.visit.shading', 'Shading')} required><Select value={shading} onChange={(e) => setShading(e.target.value)} placeholder="Select">{SHADING.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
              <Field label={t('site.visit.roof', 'Roof type')} required><Select value={roof} onChange={(e) => setRoof(e.target.value)} placeholder="Select">{ROOFS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
              <Field label={t('site.visit.area', 'Roof area (sq m)')} required><Input type="number" min="1" value={area} onChange={(e) => setArea(e.target.value)} /></Field>
            </div>
            <Field label={t('site.visit.notes', 'Visit notes')}><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            <Button type="submit" variant="secondary" loading={complete.isPending} disabled={!shading || !roof || !(Number(area) > 0)}>{t('site.visit.complete', 'Complete visit')}</Button>
          </form>
        </>
      )}

      {s && status === 'completed' && (
        <p className="text-[15px]">{t('site.visit.doneOn', 'Visit completed on')} <strong><DateText value={s.surveyed_at} /></strong>{s.notes ? ` — ${s.notes}` : ''}</p>
      )}

      {s && status !== 'cancelled' && (
        <div className="space-y-3 border-t border-border pt-5">
          <p className="text-sm font-semibold">{t('site.visit.photos', 'Site photos')} <span className="font-normal text-muted">({s.photo_count})</span></p>
          <div className="flex flex-wrap items-center gap-3">
            <input ref={files} type="file" accept="image/jpeg,image/png,image/webp" multiple aria-label={t('site.visit.pickPhotos', 'Choose photos')} className="text-sm" />
            <Button variant="secondary" size="sm" loading={upload.isPending} onClick={() => { const list = Array.from(files.current?.files ?? []); if (list.length) upload.mutate(list); }}>{t('site.visit.upload', 'Upload photos')}</Button>
          </div>
          <p className="text-xs text-muted">{t('site.visit.geo', 'The place is read from the photo; if it has none, your current location is used.')}</p>
        </div>
      )}

      {s && needsDiscom && f && (
        <div className="space-y-3 border-t border-border pt-5">
          <p className="text-sm font-semibold">{t('site.visit.discom', 'DISCOM feasibility study')}</p>
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div><dt className="text-muted">{t('site.visit.submitted', 'Application submitted')}</dt><dd><DateText value={f.application_submitted_at} /></dd></div>
            <div><dt className="text-muted">{t('site.visit.complete2', 'Application complete')}</dt><dd><DateText value={f.application_complete_at} /></dd></div>
            <div><dt className="text-muted">{t('site.visit.due', 'Response due')}</dt><dd><DateText value={f.due_at} /></dd></div>
          </dl>
          {f.deemed_enabled && <Callout tone="info">{t('site.visit.deemed', 'Deemed feasible after {{days}} days if the DISCOM does not reply.', { days: f.days_allowed })}</Callout>}
          {!f.application_complete_at && (
            <form className="flex flex-wrap items-end gap-4" onSubmit={(e) => { e.preventDefault(); feas.mutate({ submitted_at: new Date(`${sub}T00:00:00`).toISOString(), ...(done ? { complete_at: new Date(`${done}T00:00:00`).toISOString() } : {}) }); }}>
              <Field label={t('site.visit.submittedOn', 'Submitted on')}><Input type="date" value={sub} onChange={(e) => setSub(e.target.value)} /></Field>
              <Field label={t('site.visit.completeOn', 'Complete on')} optional><Input type="date" value={done} onChange={(e) => setDone(e.target.value)} /></Field>
              <Button type="submit" variant="secondary" size="sm" loading={feas.isPending} disabled={!sub}>{t('site.visit.saveDates', 'Save dates')}</Button>
            </form>
          )}
        </div>
      )}
      {q.error && <Callout tone="danger">{errorMessage(q.error)}</Callout>}
    </div>
  );
}
