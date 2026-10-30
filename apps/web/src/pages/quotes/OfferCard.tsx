import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BrandUsp, Sku } from '@solar/shared';
import { formatINR } from '@solar/shared';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/form';
import { Card, CardBody, CardHeader } from '@/components/ui/surface';
import { Money } from '@/components/domain/values';
import { api, errorMessage, type One } from '@/lib/api';
import { invalidatePaths, useGet } from '@/lib/query';
import { useToast } from '@/components/ui/toast';
import type { QuoteDetail } from './types';

type Recommended = Sku & { usp: BrandUsp | null };
interface Draft { key: string; sku_id: string | null; description: string; hsn: string | null; qty: string; unit_price: string; discount_pct: string; line_total: number | null; gst_rate?: number | null; tax_ok?: boolean; gst_set?: boolean }
const GST_RATES = [0, 5, 12, 18, 28];

const USP: [keyof BrandUsp, string][] = [['quality', 'Quality'], ['warranty', 'Warranty'], ['certifications', 'Certifications'], ['service_support', 'Service support'], ['delivery_reliability', 'Delivery reliability']];

const fromQuote = (q: QuoteDetail): Draft[] => q.lines.map((l) => ({
  key: l.id, sku_id: l.sku_id, description: l.sku ? `${l.sku.make} ${l.sku.model}` : l.description, hsn: l.hsn, qty: String(l.qty), unit_price: String(l.unit_price), discount_pct: String(l.discount_pct), line_total: l.line_total, gst_rate: l.gst_rate, tax_ok: l.tax_position_approved,
}));
const payload = (d: Draft) => ({
  ...(d.sku_id ? { sku_id: d.sku_id } : { description: d.description, hsn: d.hsn ?? undefined }),
  qty: Number(d.qty) || 1, ...(d.unit_price !== '' ? { unit_price: Number(d.unit_price) } : {}), discount_pct: Number(d.discount_pct) || 0,
});

/** Step 21: the offer. Recommended products with their brand USP, one-click add, quantity / price / discount, validity, payment terms, totals and the subsidy line. */
export function OfferCard({ quote, onDirty, canTax = false }: { quote: QuoteDetail; onDirty: (dirty: boolean) => void; canTax?: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const editable = quote.editable;
  const rec = useGet<Recommended[]>(editable ? '/skus/recommend' : null, { segment: quote.segment, kw: quote.kw, compliant_only: true });
  const shortlist = useGet<{ sku_ids: string[] }>(editable && quote.lead_id ? `/leads/${quote.lead_id}/shortlist` : null);
  const chosen = useMemo(() => new Set(shortlist.data?.sku_ids ?? []), [shortlist.data]);
  const [lines, setLines] = useState<Draft[]>(() => fromQuote(quote));
  const [validity, setValidity] = useState(quote.validity_date);
  const [terms, setTerms] = useState(quote.payment_terms ?? '');

  useEffect(() => { setLines(fromQuote(quote)); setValidity(quote.validity_date); setTerms(quote.payment_terms ?? ''); }, [quote]);

  const dirty = useMemo(
    () => JSON.stringify(lines.map(payload)) !== JSON.stringify(fromQuote(quote).map(payload)) || validity !== quote.validity_date || terms !== (quote.payment_terms ?? '') || lines.some((l) => l.gst_set),
    [lines, validity, terms, quote],
  );
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);

  const save = useMutation({
    mutationFn: async (next: Draft[]) => {
      const res = await api.put<One<{ lines: { id: string }[] }>>(`/quotes/${quote.id}/lines`, { lines: next.map(payload), validity_date: validity });
      if (terms !== (quote.payment_terms ?? '')) await api.patch<One<unknown>>(`/quotes/${quote.id}`, { payment_terms: terms });
      // GST rates chosen in the table are tax decisions: record them against the saved lines (same order as the table)
      const picked = next.map((d, i) => ({ d, i })).filter(({ d }) => d.gst_set && d.gst_rate != null);
      if (picked.length) {
        if (picked.some(({ d }) => !d.hsn)) throw new Error(t('quote.offer.needHsn', 'A product has no HSN code. Add the HSN in the catalogue first.'));
        const saved = res.data.lines;
        await api.post<One<unknown>>(`/quotes/${quote.id}/tax-position`, { lines: picked.map(({ d, i }) => ({ line_id: saved[i]!.id, approved: true, gst_rate: d.gst_rate, hsn: d.hsn })) });
      }
      return api.post<One<unknown>>(`/quotes/${quote.id}/evaluate`, {});
    },
    onSuccess: async () => { await invalidatePaths(qc, ['/quotes']); toast.success(t('quote.offer.saved', 'Offer saved')); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  // Live figures: the same arithmetic the server uses (gross = qty x unit price; net = gross less the line discount; GST on the net),
  // so the amounts and totals move as you type and match what is stored once you save.
  const live = useMemo(() => {
    const saved = new Map(quote.lines.map((l) => [l.id, l]));
    const rows = lines.map((l) => {
      const s = saved.get(l.key);
      const unit = l.unit_price !== '' && Number.isFinite(Number(l.unit_price)) ? Number(l.unit_price) : (s?.unit_price ?? null);
      const qty = Number(l.qty) > 0 ? Number(l.qty) : 1;
      const disc = Math.min(100, Math.max(0, Number(l.discount_pct) || 0));
      if (unit === null) return { gross: null as number | null, net: null as number | null, tax: 0 };
      const gross = qty * unit;
      const net = gross * (1 - disc / 100);
      const rate = l.gst_rate ?? s?.gst_rate ?? null;
      return { gross, net, tax: rate !== null ? net * (rate / 100) : 0 };
    });
    const known = rows.filter((r) => r.gross !== null);
    const subtotal = known.reduce((a, r) => a + r.gross!, 0);
    const net = known.reduce((a, r) => a + r.net!, 0);
    const tax = known.reduce((a, r) => a + r.tax, 0);
    const complete = known.length === rows.length;
    return { rows, subtotal, discount: subtotal - net, tax, total: net + tax + (quote.freight ?? 0), complete };
  }, [lines, quote.lines, quote.freight]);

  const add = (p: Recommended) => {
    const next = [...lines, { key: `new-${p.id}-${lines.length}`, sku_id: p.id, description: `${p.make} ${p.model}`, hsn: p.hsn, qty: '1', unit_price: '', discount_pct: '0', line_total: null }];
    setLines(next);
    save.mutate(next);
  };
  const edit = (key: string, patch: Partial<Draft>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const have = new Set(lines.map((l) => l.sku_id));
  const picks = (rec.data ?? []).filter((p) => !have.has(p.id)).sort((a, b) => Number(chosen.has(b.id)) - Number(chosen.has(a.id)));
  const chosenPicks = picks.filter((p) => chosen.has(p.id));
  const addChosen = () => {
    const next = [...lines, ...chosenPicks.map((p, i) => ({ key: `new-${p.id}-${lines.length + i}`, sku_id: p.id, description: `${p.make} ${p.model}`, hsn: p.hsn, qty: '1', unit_price: '', discount_pct: '0', line_total: null }))];
    setLines(next);
    save.mutate(next);
  };

  return (
    <Card>
      <CardHeader title={<><span className="code mr-2 text-primary-text">1</span>{t('quote.offer.title', 'Offer')}</>} description={t('quote.offer.sub', 'Products, price and terms for the customer')} />
      <CardBody className="space-y-6">
        {editable && picks.length > 0 && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-sans text-sm font-bold">{t('quote.offer.rec', 'Recommended for this job')}</h3>
              {chosenPicks.length > 0 && <Button size="sm" loading={save.isPending} onClick={addChosen}>{t('quote.offer.addChosen', 'Add the {{n}} shortlisted product(s)', { n: chosenPicks.length })}</Button>}
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {picks.map((p) => (
                <article key={p.id} className="space-y-3 rounded-lg border border-border p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0"><p className="text-[15px] font-bold">{p.make} {p.model}{chosen.has(p.id) && <span className="ml-2 rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary-text">{t('quote.offer.shortlisted', 'Shortlisted')}</span>}</p><p className="text-xs capitalize text-muted">{p.category.replace(/_/g, ' ')}</p></div>
                    <Button size="xs" variant="secondary" leftIcon={<Plus className="h-3.5 w-3.5" aria-hidden />} loading={save.isPending} onClick={() => add(p)} aria-label={`${t('quote.offer.add', 'Add')} ${p.make} ${p.model}`}>{t('quote.offer.add', 'Add')}</Button>
                  </div>
                  {p.usp && (
                    <dl className="space-y-1 text-[13px]">{USP.map(([k, label]) => <div key={k} className="flex gap-2"><dt className="w-32 shrink-0 font-semibold text-muted">{label}</dt><dd>{p.usp![k]}</dd></div>)}</dl>
                  )}
                </article>
              ))}
            </div>
          </div>
        )}

        {lines.length === 0 ? (
          <p className="text-sm text-muted">{t('quote.offer.empty', 'No products yet. Add one from the recommendations.')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead><tr className="border-b border-border text-[11px] font-bold uppercase tracking-[0.08em] text-muted">
                <th scope="col" className="py-2 pr-3">{t('quote.offer.product', 'Product')}</th><th scope="col" className="px-2 py-2">{t('quote.offer.qty', 'Qty')}</th><th scope="col" className="px-2 py-2">{t('quote.offer.price', 'Unit price (₹)')}</th>
                <th scope="col" className="px-2 py-2">{t('quote.offer.disc', 'Discount %')}</th><th scope="col" className="px-2 py-2">{t('quote.offer.gstPct', 'GST %')}</th><th scope="col" className="px-2 py-2 text-right">{t('quote.offer.line', 'Amount')}</th><th scope="col" className="w-10"><span className="sr-only">{t('quote.offer.remove', 'Remove')}</span></th>
              </tr></thead>
              <tbody>
                {lines.map((l, idx) => (
                  <tr key={l.key} className="border-b border-border last:border-0">
                    <td className="min-w-40 py-3 pr-3 font-semibold">{l.description}</td>
                    <td className="px-2 py-2"><Input aria-label={`${t('quote.offer.qty', 'Qty')} ${l.description}`} type="number" min="1" className="w-20" disabled={!editable} value={l.qty} onChange={(e) => edit(l.key, { qty: e.target.value })} /></td>
                    <td className="px-2 py-2"><Input aria-label={`${t('quote.offer.price', 'Unit price (₹)')} ${l.description}`} type="number" min="0" className="w-32" disabled={!editable} value={l.unit_price} placeholder="Auto" onChange={(e) => edit(l.key, { unit_price: e.target.value })} /></td>
                    <td className="px-2 py-2"><Input aria-label={`${t('quote.offer.disc', 'Discount %')} ${l.description}`} type="number" min="0" max="100" className="w-24" disabled={!editable} value={l.discount_pct} onChange={(e) => edit(l.key, { discount_pct: e.target.value })} /></td>
                    <td className="px-2 py-2">
                      {editable && canTax ? (
                        <Select aria-label={`${t('quote.offer.gstPct', 'GST %')} ${l.description}`} className="w-24" value={l.gst_rate != null && l.tax_ok ? String(l.gst_rate) : ''} placeholder="Set"
                          onChange={(e) => e.target.value !== '' && edit(l.key, { gst_rate: Number(e.target.value), tax_ok: true, gst_set: true })}>
                          {GST_RATES.map((r) => <option key={r} value={r}>{r}%</option>)}
                        </Select>
                      ) : (
                        <span className={l.tax_ok ? 'tabular' : 'text-muted'}>{l.gst_rate != null ? `${l.gst_rate}%` : '—'}</span>
                      )}
                    </td>
                    <td className="tabular px-2 py-2 text-right">{live.rows[idx]?.net != null ? formatINR(live.rows[idx]!.net!) : (l.line_total != null ? formatINR(l.line_total) : '—')}</td>
                    <td className="py-2 text-right">{editable && <Button size="icon" variant="ghost" aria-label={`${t('quote.offer.remove', 'Remove')} ${l.description}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Trash2 className="h-4 w-4" aria-hidden /></Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="grid gap-5 md:grid-cols-2">
          <Field label={t('quote.offer.valid', 'Valid until')}><Input type="date" disabled={!editable} value={validity} onChange={(e) => setValidity(e.target.value)} /></Field>
          <Field label={t('quote.offer.terms', 'Payment terms')} optional><Input disabled={!editable} value={terms} onChange={(e) => setTerms(e.target.value)} /></Field>
        </div>

        <dl className="ml-auto max-w-sm space-y-1.5 text-sm">
          <div className="flex justify-between"><dt className="text-muted">{t('quote.offer.subtotal', 'Subtotal')}</dt><dd><Money value={live.complete ? live.subtotal : quote.subtotal} /></dd></div>
          {(live.complete ? live.discount : quote.discount_amount) > 0.004 && <div className="flex justify-between"><dt className="text-muted">{t('quote.offer.discount', 'Discount')}</dt><dd>− <Money value={live.complete ? live.discount : quote.discount_amount} /></dd></div>}
          <div className="flex justify-between"><dt className="text-muted">{t('quote.offer.gst', 'GST')}</dt><dd><Money value={live.complete ? live.tax : quote.tax_total} /></dd></div>
          <div className="flex justify-between border-t border-border pt-2 text-base font-bold"><dt>{t('quote.offer.total', 'Total')}</dt><dd><Money value={live.complete ? live.total : quote.total} /></dd></div>
        </dl>
        {quote.cfa_entitlement > 0 && (
          <p className="rounded-lg bg-primary-soft px-4 py-3 text-sm text-primary-text">
            {t('quote.offer.subsidy', 'Government subsidy (CFA)')} <strong>{formatINR(quote.cfa_entitlement)}</strong>, {t('quote.offer.youPay', 'you pay')} <strong>{formatINR(quote.consumer_share)}</strong>
          </p>
        )}

        {editable && (
          <div className="flex items-center gap-3">
            <Button variant="secondary" loading={save.isPending} disabled={!dirty || lines.length === 0} onClick={() => save.mutate(lines)}>{t('quote.offer.save', 'Save offer')}</Button>
            {dirty && <span className="text-sm text-muted">{t('quote.offer.unsaved', 'You have unsaved changes.')}</span>}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
