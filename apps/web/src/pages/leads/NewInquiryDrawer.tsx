import { zodResolver } from '@hookform/resolvers/zod';
import { Check, CircleAlert, Globe, Megaphone, MessageCircle, Phone, TriangleAlert, Users, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm, type Resolver } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { CUSTOMER_TYPES, EMAIL_RE, PINCODE_RE, TIMELINE_BUCKETS, formatDateTime, formatDuration, normalizeMobile, toE164, type LeadDetail, type LeadListItem } from '@solar/shared';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/ui/button';
import { Checkbox, Field, FormGrid, Input, Select } from '@/components/ui/form';
import { Drawer } from '@/components/ui/overlay';
import { Callout } from '@/components/ui/surface';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useDebounced } from '@/lib/hooks';
import { useAction, useGet, useList } from '@/lib/query';
import { AcceptanceTracker } from './AcceptanceTracker';
import { AssignControl } from './AssignControl';
import { CUSTOMER_TYPE_LABEL, DEFAULT_PRODUCTS, PRODUCT_CHOICES, SOURCE_CHOICES, TIMELINE_LABEL } from './leadUi';

const SOURCE_ICON: Record<string, typeof Globe> = { website: Globe, call_centre: Phone, whatsapp: MessageCircle, campaign: Megaphone, referral: Users };
const NOTICE_VERSION = 'default-v1';

const schema = z.object({
  source: z.string().min(1),
  name: z.string().trim().min(2, 'Please enter the name').max(120),
  mobile: z.string().trim().refine((v) => normalizeMobile(v) !== null, 'Enter a 10-digit mobile number starting with 6, 7, 8 or 9'),
  email: z.string().trim().refine((v) => v === '' || EMAIL_RE.test(v), 'Enter a valid e-mail address, or leave it empty'),
  consent: z.boolean(),
  pincode: z.string().trim().refine((v) => v === '' || PINCODE_RE.test(v), 'Enter a 6-digit pincode'),
  city: z.string().trim().max(100),
  state: z.string().trim().max(100),
  kw: z.string().trim().refine((v) => v === '' || (Number(v) > 0 && Number(v) <= 100000), 'Enter the size in kW, such as 5'),
  customer_type: z.string(),
  products: z.array(z.string()),
  urgency: z.string(),
});
type Values = z.infer<typeof schema>;
const EMPTY: Values = { source: 'call_centre', name: '', mobile: '', email: '', consent: false, pincode: '', city: '', state: '', kw: '', customer_type: '', products: [], urgency: '' };

interface CreateResult { lead: LeadListItem; created: boolean; duplicate_of: string | null; assigned: boolean }
interface Geo { pincode: string; city: string; district: string; state: string }

function Block({ n, title, bullets, children }: { n: string; title: string; bullets: string; children: React.ReactNode }) {
  return (
    <section className="space-y-5" aria-label={title}>
      <header className="flex items-start gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-fg text-sm font-bold text-white">{n}</span>
        <div><h3 className="font-sans text-base font-bold leading-tight">{title}</h3><p className="mt-0.5 text-xs text-muted">{bullets}</p></div>
      </header>
      <div className="pl-10">{children}</div>
    </section>
  );
}

function Check1({ ok, warn, label, detail }: { ok: boolean | null; warn?: boolean; label: string; detail?: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3 text-sm">
      <span className={cn('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full', ok === null ? 'border border-border-strong text-subtle' : warn ? 'bg-warning text-white' : ok ? 'bg-success text-white' : 'bg-danger text-white')}>
        {ok === null ? null : warn ? <TriangleAlert className="h-3 w-3" aria-hidden /> : ok ? <Check className="h-3 w-3" aria-hidden /> : <X className="h-3 w-3" aria-hidden />}
      </span>
      <span><span className="font-semibold">{label}</span>{detail && <span className="block text-xs text-muted">{detail}</span>}</span>
    </li>
  );
}

/** Steps 1–3 are one form (they happen in a single sitting); on save the system does steps 4–7 and the drawer shows exactly what it decided. */
export function NewInquiryDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [result, setResult] = useState<CreateResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const { register, control, handleSubmit, watch, setError, setValue, getValues, reset, formState: { errors } } = useForm<Values>({ defaultValues: EMPTY, resolver: zodResolver(schema) as unknown as Resolver<Values> });

  /* step 2 — live checks while typing */
  const mobile = watch('mobile');
  const email = watch('email').trim();
  const mobile10 = normalizeMobile(mobile);
  const mobileKey = useDebounced(mobile10 ?? '', 400);
  const dupes = useList<LeadListItem>(mobileKey ? '/leads' : null, { q: mobileKey, limit: 3 }, { retry: false });
  const customers = useList<{ id: string; legal_name: string }>(mobileKey ? '/customers' : null, { q: mobileKey, limit: 3 }, { retry: false });

  /* step 3 — pincode fills city and state; customer type suggests the product */
  const pin = useDebounced(watch('pincode').trim(), 350);
  const geo = useGet<Geo>(PINCODE_RE.test(pin) ? `/lookups/pincode/${pin}` : null, undefined, { retry: false });
  useEffect(() => { if (geo.data) { if (!getValues('city')) setValue('city', geo.data.city); if (!getValues('state')) setValue('state', geo.data.state); } }, [geo.data, getValues, setValue]);
  const customerType = watch('customer_type');
  useEffect(() => { if (customerType && getValues('products').length === 0) setValue('products', DEFAULT_PRODUCTS[customerType] ?? []); }, [customerType, getValues, setValue]);

  const create = useAction<Record<string, unknown>, CreateResult>({ path: '/leads', invalidate: ['/leads', '/followups'], toastError: false });
  useEffect(() => { if (!open) { setResult(null); setFormError(null); reset(EMPTY); } }, [open, reset]);

  const submit = handleSubmit((v) => {
    setFormError(null);
    const body: Record<string, unknown> = {
      name: v.name, mobile: toE164(v.mobile) ?? v.mobile, source: v.source,
      ...(v.email && { email: v.email }),
      ...(v.pincode && { pincode: v.pincode }), ...(v.city && { city: v.city }), ...(v.state && { state: v.state }),
      ...(v.kw && { capacity_kw: Number(v.kw) }),
      ...(v.customer_type && { customer_type: v.customer_type }),
      ...(v.products.length > 0 && { product_interest: v.products }),
      ...(v.urgency && { timeline_bucket: v.urgency }),
      ...(v.consent && { consent: { notice_version: NOTICE_VERSION, purposes: ['service', 'promotional', 'quotation'], channels: ['call', 'sms', 'whatsapp'], proof_ref: 'Admin entry', capture_source: 'staff_entry' } }),
    };
    create.mutate(body, {
      onSuccess: (r) => setResult(r),
      onError: (e: ApiError) => {
        const fe = e.fieldErrors;
        let shown = false;
        for (const k of ['name', 'mobile', 'email', 'pincode'] as const) if (fe[k]) { setError(k, { message: fe[k] }); shown = true; }
        if (fe['capacity_kw']) { setError('kw', { message: fe['capacity_kw'] }); shown = true; }
        if (!shown) setFormError(e.message);
      },
    });
  });

  return (
    <Drawer
      open={open} onClose={onClose} width="xl"
      title={result ? 'Inquiry saved' : 'New inquiry'}
      description={result ? 'Steps 4–7: what the system decided' : 'Steps 1–3: capture the inquiry'}
      footer={result ? (
        <><Button variant="ghost" onClick={() => { setResult(null); reset(EMPTY); }}>Add another</Button><LinkButton to={`/leads/${result.lead.id}`}>Open this inquiry</LinkButton></>
      ) : (
        <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => void submit()} loading={create.isPending}>Save and match a distributor</Button></>
      )}
    >
      {result ? <MatchResult leadId={result.lead.id} /> : (
        <form onSubmit={(e) => void submit(e)} noValidate className="space-y-12">
          {formError && <Callout tone="danger">{formError}</Callout>}

          <Block n="1" title="Inquiry captured" bullets="Website · Call · WhatsApp · Campaign · Referral">
            <fieldset className="space-y-6">
              <legend className="sr-only">Where did the inquiry come from?</legend>
              <Controller control={control} name="source" render={({ field }) => (
                <div role="radiogroup" aria-label="Inquiry source" className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
                  {SOURCE_CHOICES.map((s) => {
                    const Icon = SOURCE_ICON[s.value] ?? Globe;
                    const on = field.value === s.value;
                    return (
                      <button key={s.value} type="button" role="radio" aria-checked={on} onClick={() => field.onChange(s.value)}
                        className={cn('flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-sm font-semibold transition', on ? 'border-fg bg-fg text-white' : 'border-border-strong bg-surface hover:border-primary/60')}>
                        <Icon className="h-5 w-5" aria-hidden />{s.label}
                      </button>
                    );
                  })}
                </div>
              )} />
              <FormGrid cols={2}>
                <Field label="Name" required error={errors.name?.message}><Input autoComplete="off" {...register('name')} /></Field>
                <Field label="Mobile" required error={errors.mobile?.message}><Input inputMode="tel" autoComplete="off" placeholder="98765 43210" {...register('mobile')} /></Field>
                <Field label="E-mail" optional error={errors.email?.message}><Input type="email" autoComplete="off" {...register('email')} /></Field>
              </FormGrid>
              <Checkbox label="The customer agreed to be contacted by call, SMS and WhatsApp" hint="Needed before any reminder or offer can be sent to them." {...register('consent')} />
            </fieldset>
          </Block>

          <Block n="2" title="Validate & de-duplicate" bullets="Mobile / e-mail valid · check duplicate · check existing customer">
            <ul className="space-y-3.5" aria-live="polite">
              <Check1 ok={mobile ? mobile10 !== null : null} label="Mobile valid" detail={mobile && mobile10 === null ? 'A 10-digit number starting with 6, 7, 8 or 9' : undefined} />
              <Check1 ok={email ? EMAIL_RE.test(email) : null} label="E-mail valid" detail={email && !EMAIL_RE.test(email) ? 'This does not look like an e-mail address' : email ? undefined : 'Optional'} />
              <Check1
                ok={mobileKey ? (dupes.data ? dupes.data.total === 0 : null) : null} warn={!!dupes.data && dupes.data.total > 0} label="No duplicate inquiry"
                detail={dupes.data && dupes.data.total > 0 ? <>This number is already an inquiry: {dupes.data.data.map((d) => <Link key={d.id} to={`/leads/${d.id}`} className="link mr-2">{d.name}</Link>)}</> : undefined}
              />
              <Check1
                ok={mobileKey ? (customers.data ? customers.data.total === 0 : null) : null} warn={!!customers.data && customers.data.total > 0} label="Not an existing customer"
                detail={customers.data && customers.data.total > 0 ? `Existing customer: ${customers.data.data.map((c) => c.legal_name).join(', ')}` : undefined}
              />
            </ul>
          </Block>

          <Block n="3" title="Capture details" bullets="Pincode · city · state · MW scale · customer type · product interest">
            <div className="space-y-6">
              <FormGrid cols={3}>
                <Field label="Pincode" error={errors.pincode?.message} hint={geo.isError && PINCODE_RE.test(pin) ? 'Not found — type the city and state' : undefined}><Input inputMode="numeric" maxLength={6} autoComplete="off" {...register('pincode')} /></Field>
                <Field label="City"><Input autoComplete="off" {...register('city')} /></Field>
                <Field label="State"><Input autoComplete="off" {...register('state')} /></Field>
                <Field label="MW scale (in kW)" error={errors.kw?.message} hint="For example 5 for a 5 kW rooftop"><Input inputMode="decimal" autoComplete="off" {...register('kw')} /></Field>
                <Field label="Customer type"><Select placeholder="Choose…" {...register('customer_type')}>{CUSTOMER_TYPES.map((c) => <option key={c} value={c}>{CUSTOMER_TYPE_LABEL[c]}</option>)}</Select></Field>
                <Field label="How soon do they want it?" hint="Sets Hot / Warm / Cold — and so how fast the distributor must accept">
                  <Select placeholder="Not asked yet (Warm)" {...register('urgency')}>{TIMELINE_BUCKETS.filter((b) => b !== 'unknown').map((b) => <option key={b} value={b}>{TIMELINE_LABEL[b]}</option>)}</Select>
                </Field>
              </FormGrid>
              <Controller control={control} name="products" render={({ field }) => (
                <div>
                  <p className="mb-2 text-sm font-semibold">Product interest</p>
                  <div role="group" aria-label="Product interest" className="flex flex-wrap gap-2">
                    {PRODUCT_CHOICES.map((p) => {
                      const on = field.value.includes(p.value);
                      return (
                        <button key={p.value} type="button" aria-pressed={on} onClick={() => field.onChange(on ? field.value.filter((x) => x !== p.value) : [...field.value, p.value])}
                          className={cn('rounded-full border px-3.5 py-1.5 text-sm font-semibold transition', on ? 'border-primary bg-primary text-primary-fg' : 'border-border-strong bg-surface text-muted hover:border-primary/60 hover:text-fg')}>
                          {p.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-2 text-xs text-muted">The distributor must be able to supply everything you pick.</p>
                </div>
              )} />
            </div>
          </Block>
        </form>
      )}
    </Drawer>
  );
}

interface Candidate { distributor_id: string; name: string; eligible: boolean; reasons: string[]; score: number }

/** Step 4 and what follows, drawn from the routing record the backend stored: the four criteria per distributor, then the decision. */
function MatchResult({ leadId }: { leadId: string }) {
  const q = useGet<LeadDetail>(`/leads/${leadId}`);
  const view = useMemo(() => {
    const d = q.data;
    if (!d) return null;
    const a = [...d.assignments].sort((x, y) => (x.assigned_at < y.assigned_at ? 1 : -1))[0];
    const snap = (a?.score_snapshot ?? {}) as { candidates?: Candidate[]; geo?: { territory_name?: string | null; city?: string | null }; chosen?: string | null };
    return { d, candidates: snap.candidates ?? [], territory: snap.geo?.territory_name ?? null, chosen: snap.chosen ?? null };
  }, [q.data]);
  if (q.isLoading || !view) return <div className="space-y-3" role="status" aria-label="Loading"><div className="skeleton h-24" /><div className="skeleton h-40" /></div>;
  const { d, candidates, territory } = view;
  const lead = d.lead;

  if (lead.status === 'duplicate') {
    return (
      <Callout tone="warning" title="2 · This looks like an inquiry we already have">
        It was saved but not assigned, so the customer is not contacted twice. <Link className="underline" to={`/leads/${lead.id}`}>Open it</Link> to merge it or release it.
      </Callout>
    );
  }
  const reasonOf = (c: Candidate, test: (r: string) => boolean) => c.reasons.find(test);
  const ok = (c: Candidate, test: (r: string) => boolean) => !c.reasons.some(test);
  const isTerritory = (r: string) => /serve|territory|registration/i.test(r);
  const isCapacity = (r: string) => /outside the/i.test(r);
  const isProduct = (r: string) => /capability/i.test(r);
  const eligible = lead.status === 'assigned';
  const clock = d.clocks.find((c) => c.clock_type === 'lead_acceptance');

  return (
    <div className="space-y-10">
      <section aria-label="Territory and capability match" className="space-y-4">
        <header className="flex items-start gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-fg text-sm font-bold text-white">4</span>
          <div><h3 className="font-sans text-base font-bold leading-tight">Territory & capability match</h3><p className="mt-0.5 text-xs text-muted">{territory ? `${lead.city ?? 'This place'} is in the ${territory} territory` : 'This pincode is not in any territory yet'}</p></div>
        </header>
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead><tr className="border-b border-border text-[11px] uppercase tracking-[0.08em] text-muted">
              <th className="px-4 py-3 font-bold">Distributor</th><th className="px-3 py-3 font-bold">Territory</th><th className="px-3 py-3 font-bold">MW capacity</th><th className="px-3 py-3 font-bold">Product capability</th><th className="px-3 py-3 text-right font-bold">Score</th>
            </tr></thead>
            <tbody>
              {candidates.map((c) => (
                <tr key={c.distributor_id} className={cn('border-b border-border last:border-0', c.distributor_id === view.chosen && 'bg-primary-soft/60')}>
                  <td className="px-4 py-3.5 font-semibold">{c.name.replace(/\s*\(Demo\)\s*$/, '')}{c.distributor_id === view.chosen && <Badge tone="primary" className="ml-2">Chosen</Badge>}</td>
                  {[isTerritory, isCapacity, isProduct].map((t, i) => (
                    <td key={i} className="px-3 py-3.5" title={reasonOf(c, t)}>{ok(c, t) ? <Check className="h-4 w-4 text-success" aria-label="Matches" /> : <span className="inline-flex items-center gap-1 text-xs text-danger-text"><X className="h-4 w-4" aria-hidden />{reasonOf(c, t)}</span>}</td>
                  ))}
                  <td className="tabular px-3 py-3.5 text-right font-semibold">{c.score}</td>
                </tr>
              ))}
              {candidates.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-muted">No distributors are set up yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {eligible ? (
        <section aria-label="Assigned" className="space-y-5">
          <p className="flex items-center gap-2 text-sm font-semibold text-success-text"><Check className="h-4 w-4" aria-hidden />Distributor available &amp; eligible — YES</p>
          <div className="card p-5">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">5 · Auto-assigned</p>
            <p className="display mt-1 text-2xl">{lead.distributor_name?.replace(/\s*\(Demo\)\s*$/, '')}</p>
            <p className="mt-1 text-sm text-muted">Owner: {lead.owner_name ?? '—'}</p>
          </div>
          <div className="card p-5">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">7 · Lead acceptance by distributor</p>
            <p className="mt-2 text-[15px]">
              <Badge tone={lead.temperature === 'hot' ? 'danger' : lead.temperature === 'cold' ? 'info' : 'warning'}>{(lead.temperature ?? 'warm').toUpperCase()}</Badge>{' '}
              must accept within <b className="font-semibold">{clock ? formatDuration(new Date(clock.due_at).getTime() - new Date(clock.started_at).getTime()) : '—'}</b>
              {clock && <> — by <b className="font-semibold">{formatDateTime(clock.due_at)}</b></>}.
            </p>
            <div className="mt-5"><AcceptanceTracker detail={d} /></div>
          </div>
        </section>
      ) : (
        <section aria-label="Escalated to DSM" className="space-y-5">
          <p className="flex items-center gap-2 text-sm font-semibold text-danger-text"><CircleAlert className="h-4 w-4" aria-hidden />Distributor available &amp; eligible — NO</p>
          <div className="card p-5">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">6 · Escalate to DSM / reassign territory</p>
            <p className="mt-2 text-[15px] text-muted">The DSM has been alerted. You can assign a distributor now:</p>
            <div className="mt-4"><AssignControl leadId={lead.id} /></div>
          </div>
        </section>
      )}
    </div>
  );
}
