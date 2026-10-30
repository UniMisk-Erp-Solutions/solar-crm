import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, MapPin } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { CUSTOMER_TYPES, PINCODE_RE, TIMELINE_BUCKETS, normalizeMobile, toE164 } from '@solar/shared';
import { SunMark } from '@/components/layout/Logo';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Select } from '@/components/ui/form';
import { Callout } from '@/components/ui/surface';
import { ApiError, api, type One } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';

const TYPE_LABEL: Record<(typeof CUSTOMER_TYPES)[number], string> = { residential: 'My home', housing_society: 'Housing society', commercial: 'Shop or office', industrial: 'Factory', farmer: 'Farm', government: 'Government' };
const WHEN_LABEL: Record<(typeof TIMELINE_BUCKETS)[number], string> = {
  immediate: 'As soon as possible', within_30_days: 'Within a month', one_to_three_months: 'In 1 to 3 months', three_to_six_months: 'In 3 to 6 months', six_months_plus: 'Later, I am just exploring', unknown: 'Not sure yet',
};
const WHEN_EN: Record<string, string> = { ...WHEN_LABEL };

const schema = z.object({
  name: z.string().trim().min(2, 'Please enter your name').max(120),
  mobile: z.string().trim().refine((v) => normalizeMobile(v) !== null, 'Enter a 10-digit mobile number starting with 6, 7, 8 or 9'),
  pincode: z.string().trim().refine((v) => v === '' || PINCODE_RE.test(v), 'Enter your 6-digit pincode'),
  kw: z.string().trim().refine((v) => v === '' || (Number(v) > 0 && Number(v) <= 100000), 'Enter a number such as 3 or 10'),
  unsure: z.boolean(),
  customer_type: z.string(),
  when: z.string(),
  consent: z.boolean(),
});
type Values = z.infer<typeof schema>;
const EMPTY: Values = { name: '', mobile: '', pincode: '', kw: '', unsure: false, customer_type: '', when: '', consent: false };

interface Notice { notice_version: string; body: string; purposes: { value: string }[]; channels: { value: string }[] }
interface Geo { pincode: string; city: string; state: string }

/** The website enquiry card — no app shell, no routing detail, nothing about duplicates. */
export default function PublicLeadFormPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const apiKey = (params.get('key') ?? '').trim();
  const headers = useMemo(() => ({ 'X-Api-Key': apiKey }), [apiKey]);
  const [done, setDone] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const sourceRef = useRef(`web-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now())}`);

  const { register, handleSubmit, watch, setValue, setError, formState: { errors } } = useForm<Values>({ defaultValues: EMPTY, resolver: zodResolver(schema) as unknown as Resolver<Values> });
  const unsure = watch('unsure');
  const pin = useDebounced(watch('pincode').trim(), 400);

  const notice = useQuery<Notice, ApiError>({
    queryKey: ['public-consent-notice', apiKey], enabled: !!apiKey, retry: false, staleTime: 10 * 60_000,
    queryFn: async () => (await api.anon<One<Notice>>('GET', '/public/consent-notice?lang=en', undefined, headers)).data,
  });
  const keyRejected = notice.error?.status === 401 || notice.error?.status === 403;
  const geo = useQuery<Geo | null, ApiError>({
    queryKey: ['public-pincode', pin, apiKey], enabled: !!apiKey && PINCODE_RE.test(pin) && !keyRejected, retry: false, staleTime: 10 * 60_000,
    queryFn: async () => {
      try { return (await api.anon<One<Geo>>('GET', `/public/pincode/${pin}`, undefined, headers)).data; } catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; }
    },
  });
  const submit = useMutation<unknown, ApiError, Record<string, unknown>>({ mutationFn: (body) => api.anon('POST', '/public/leads', body, headers) });

  const onValid = handleSubmit((v) => {
    setFormError(null);
    const firstName = v.name.trim().split(/\s+/)[0] ?? v.name;
    const details = [v.when ? `Wants to install: ${WHEN_EN[v.when] ?? v.when}.` : null, v.unsure ? 'The customer is not sure about the size.' : null].filter(Boolean).join(' ');
    const body: Record<string, unknown> = {
      name: v.name, mobile: toE164(v.mobile) ?? v.mobile, language: 'en', source_ref: sourceRef.current,
      ...(v.pincode && { pincode: v.pincode }),
      ...(geo.data && geo.data.pincode === v.pincode && { city: geo.data.city, state: geo.data.state }),
      ...(v.customer_type && { customer_type: v.customer_type }),
      ...(!v.unsure && v.kw && { capacity_kw: Number(v.kw) }),
      ...(details && { requirement_text: details }),
      ...(v.consent && notice.data && { consent: { notice_version: notice.data.notice_version, purposes: notice.data.purposes.map((p) => p.value), channels: notice.data.channels.map((c) => c.value), capture_source: 'public_form' } }),
    };
    submit.mutate(body, {
      onSuccess: () => setDone(firstName),
      onError: (e) => {
        const fe = e.fieldErrors;
        if (fe['mobile']) { setError('mobile', { message: fe['mobile'] }); return; }
        if (fe['name']) { setError('name', { message: fe['name'] }); return; }
        if (e.status === 401 || e.status === 403) setFormError(t('apply.errKey', 'This form link is no longer valid. Please ask Future Solar for a new link.'));
        else if (e.status === 429) setFormError(t('apply.errRate', 'Too many requests just now. Please wait a minute and try again.'));
        else setFormError(t('apply.errGeneric', 'We could not send your request. Please check the details and try again.'));
      },
    });
  });

  const geoLine = geo.data && geo.data.pincode === pin ? [geo.data.city, geo.data.state].filter(Boolean).join(', ') : null;
  const brokenLink = !apiKey || keyRejected;

  return (
    <div className="min-h-screen bg-bg text-fg">
      <main className="mx-auto flex max-w-lg flex-col items-stretch px-4 py-10 sm:py-16">
        <div className="mb-8 flex items-center justify-center gap-2.5"><SunMark /><span className="display text-xl text-primary-text">Future Solar</span></div>
        {done ? (
          <section className="card space-y-4 p-8 text-center" aria-live="polite">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-success-soft text-success"><CheckCircle2 className="h-8 w-8" aria-hidden /></span>
            <h1 className="text-3xl">{t('apply.thanks', 'Thank you, {{name}}', { name: done })}</h1>
            <p className="text-base text-muted">{t('apply.call', 'We will call you within 30 minutes.')}</p>
          </section>
        ) : brokenLink ? (
          <Callout tone="warning" title={t('apply.noKey', 'This form link is not complete')}>{t('apply.noKeyHint', 'Please use the link Future Solar gave you, or call us to place your request.')}</Callout>
        ) : (
          <form onSubmit={(e) => void onValid(e)} noValidate className="card space-y-6 p-6 sm:p-8" aria-label={t('apply.title', 'Get a solar quote')}>
            <div className="space-y-2">
              <h1 className="text-3xl">{t('apply.title', 'Get a solar quote')}</h1>
              <p className="text-[15px] text-muted">{t('apply.intro', 'Tell us a little and we will call you back.')}</p>
            </div>
            {formError && <Callout tone="danger">{formError}</Callout>}
            <Field label={t('apply.name', 'Your name')} required error={errors.name?.message}><Input autoComplete="name" {...register('name')} /></Field>
            <Field label={t('apply.mobile', 'Mobile number')} required error={errors.mobile?.message}><Input type="tel" inputMode="tel" autoComplete="tel-national" {...register('mobile')} /></Field>
            <div className="space-y-1.5">
              <Field label={t('apply.pincode', 'Pincode')} error={errors.pincode?.message}><Input inputMode="numeric" maxLength={6} autoComplete="postal-code" {...register('pincode')} /></Field>
              {geoLine && <p role="status" className="flex items-center gap-1.5 text-sm text-success-text"><MapPin className="h-4 w-4" aria-hidden />{geoLine}</p>}
            </div>
            <div className="space-y-2">
              {!unsure && <Field label={t('apply.kw', 'Size you need (kW)')} error={errors.kw?.message} optional><Input inputMode="decimal" {...register('kw')} /></Field>}
              <Checkbox label={t('apply.unsure', 'I am not sure')} checked={unsure} onChange={(e) => { setValue('unsure', e.target.checked); if (e.target.checked) setValue('kw', ''); }} />
            </div>
            <Field label={t('apply.type', 'This is for')} optional>
              <Select placeholder={t('common.choose', 'Choose…')} {...register('customer_type')}>{CUSTOMER_TYPES.map((c) => <option key={c} value={c}>{TYPE_LABEL[c]}</option>)}</Select>
            </Field>
            <Field label={t('apply.when', 'When do you want to install?')} optional>
              <Select placeholder={t('common.choose', 'Choose…')} {...register('when')}>{TIMELINE_BUCKETS.map((b) => <option key={b} value={b}>{WHEN_LABEL[b]}</option>)}</Select>
            </Field>
            <div className="space-y-2 border-t border-border pt-5">
              <Checkbox label={t('apply.consent', 'I agree to be contacted about my enquiry.')} {...register('consent')} />
              {notice.data && <p className="text-xs text-muted">{notice.data.body}</p>}
            </div>
            <Button type="submit" size="lg" className="w-full" loading={submit.isPending}>{t('apply.submit', 'Request a call back')}</Button>
          </form>
        )}
      </main>
    </div>
  );
}
