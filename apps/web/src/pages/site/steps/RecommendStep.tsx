import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatINR, type BrandUsp, type Sku, type SkuPrice } from '@solar/shared';
import { Button } from '@/components/ui/button';
import { Callout, ErrorState, Spinner } from '@/components/ui/surface';
import { errorMessage } from '@/lib/api';
import { useAction, useGet } from '@/lib/query';
import type { VisitLead } from '../types';

export type Recommended = Sku & { usp: BrandUsp | null; warranty_years: number | null; price?: Pick<SkuPrice, 'base_price'> | null };

const CATEGORY_ORDER = ['module', 'inverter', 'structure', 'battery', 'cable', 'other'];
const CATEGORY_LABEL: Record<string, string> = { module: 'Solar modules', inverter: 'Inverters', structure: 'Mounting structures', battery: 'Batteries', cable: 'Cables', other: 'Balance of system' };
const PER_CATEGORY = 4;

export const USP_LINES: [keyof BrandUsp, string][] = [
  ['quality', 'Quality'], ['warranty', 'Warranty'], ['certifications', 'Certifications'], ['service_support', 'Service support'], ['delivery_reliability', 'Delivery reliability'],
];

/** The five brand USP lines of a product. */
export function UspLines({ usp }: { usp: BrandUsp | null | undefined }) {
  const { t } = useTranslation();
  if (!usp) return <p className="text-sm text-muted">{t('site.usp.none', 'No brand details on file.')}</p>;
  return (
    <dl className="space-y-1 text-[13px]">
      {USP_LINES.map(([k, label]) => (
        <div key={k} className="flex gap-2"><dt className="w-36 shrink-0 font-semibold text-muted">{label}</dt><dd className="min-w-0">{usp[k]}</dd></div>
      ))}
    </dl>
  );
}

/** Step 16: the system's recommended products, each with its five brand USP lines and a Shortlist toggle (kept on screen only). */
export function RecommendStep({ lead }: { lead: VisitLead }) {
  const { t } = useTranslation();
  const ready = !!lead.segment && !!lead.capacity_kw;
  const q = useGet<Recommended[]>(ready ? '/skus/recommend' : null, { segment: lead.segment ?? undefined, kw: lead.capacity_kw ?? undefined, compliant_only: true });
  const saved = useGet<{ sku_ids: string[]; saved_at: string | null }>(`/leads/${lead.id}/shortlist`);
  const [short, setShort] = useState<Set<string>>(new Set());
  const [openCats, setOpenCats] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setShort((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const savedIds = saved.data?.sku_ids;
  // start from what was saved earlier, so the choice can be edited and saved again
  useEffect(() => { if (savedIds) setShort(new Set(savedIds)); }, [savedIds]);
  const save = useAction<{ sku_ids: string[] }, { sku_ids: string[]; saved_at: string | null }>({
    method: 'put', path: `/leads/${lead.id}/shortlist`, invalidate: [`/leads/${lead.id}/shortlist`, '/leads'],
    successMessage: (o) => (o.sku_ids.length ? t('site.rec.saved', 'Shortlist saved') : t('site.rec.cleared', 'Shortlist cleared')),
  });
  const same = savedIds !== undefined && savedIds.length === short.size && savedIds.every((id) => short.has(id));

  if (!ready) return <Callout tone="neutral">{t('site.rec.need', 'Add the segment and size on the lead to see recommended products.')}</Callout>;
  if (q.isLoading) return <Spinner label={t('common.loading', 'Loading')} />;
  if (q.error) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  if (!q.data?.length) return <Callout tone="neutral">{t('site.rec.none', 'No products to recommend for this job yet.')}</Callout>;
  const cats = CATEGORY_ORDER.map((c) => ({ c, items: q.data!.filter((p) => p.category === c) })).filter((g) => g.items.length);
  const card = (p: Recommended) => {
    const on = short.has(p.id);
    return (
      <article key={p.id} className="space-y-3 rounded-lg border border-border p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h4 className="font-sans text-[15px] font-bold">{p.make} {p.model}</h4>
            <p className="text-xs text-muted">{p.variant}{p.warranty_years ? ` · ${p.warranty_years} yr warranty` : ''}{p.price?.base_price ? ` · ${formatINR(p.price.base_price)} / ${p.uom}` : ''}</p>
          </div>
          <Button size="xs" variant={on ? 'soft' : 'secondary'} aria-pressed={on} onClick={() => toggle(p.id)}>{on ? t('site.rec.shortlisted', 'Shortlisted') : t('site.rec.shortlist', 'Shortlist')}</Button>
        </div>
        <UspLines usp={p.usp} />
      </article>
    );
  };
  const picked = q.data.filter((p) => short.has(p.id));
  return (
    <div className="space-y-6">
      <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 shadow-sm" role="region" aria-label={t('site.rec.mine', 'Your shortlist')}>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            {short.size ? t('site.rec.count', '{{n}} product(s) chosen', { n: short.size }) : t('site.rec.nonePicked', 'Pick the products you want to offer, then save.')}
            {same && short.size > 0 && <span className="ml-2 font-normal text-muted">{t('site.rec.savedTag', 'Saved')}</span>}
          </p>
          {picked.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-2">
              {picked.map((p) => (
                <li key={p.id} className="flex items-center gap-1 rounded-full bg-primary-soft px-3 py-1 text-xs font-medium text-primary-text">
                  {p.make} {p.model}
                  <button type="button" aria-label={`Remove ${p.make} ${p.model}`} className="ml-1 text-primary-text/70 hover:text-primary-text" onClick={() => toggle(p.id)}>×</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex gap-2">
          {short.size > 0 && <Button variant="ghost" size="sm" onClick={() => setShort(new Set())}>{t('site.rec.clear', 'Clear')}</Button>}
          <Button size="sm" loading={save.isPending} disabled={same || (savedIds?.length === 0 && short.size === 0)} onClick={() => save.mutate({ sku_ids: [...short] })}>{t('site.rec.save', 'Save shortlist')}</Button>
        </div>
      </div>
      {cats.map(({ c, items }) => {
        const all = openCats.has(c);
        const shown = all ? items : items.slice(0, PER_CATEGORY);
        return (
          <section key={c} aria-label={CATEGORY_LABEL[c] ?? c}>
            <h3 className="mb-3 font-sans text-sm font-bold">{CATEGORY_LABEL[c] ?? c} <span className="font-normal text-muted">· {items.length}</span></h3>
            <div className="grid gap-4 md:grid-cols-2">{shown.map(card)}</div>
            {items.length > PER_CATEGORY && (
              <Button className="mt-3" size="sm" variant="ghost" onClick={() => setOpenCats((p) => { const n = new Set(p); if (n.has(c)) n.delete(c); else n.add(c); return n; })}>
                {all ? t('site.rec.less', 'Show fewer') : t('site.rec.all', 'Show all {{n}}', { n: items.length })}
              </Button>
            )}
          </section>
        );
      })}
    </div>
  );
}
