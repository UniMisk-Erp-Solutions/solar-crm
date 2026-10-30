import { Check, Send } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LeadSuggestion, LeadSuggestions } from '@solar/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox, Input } from '@/components/ui/form';
import { Callout, ErrorState, Skeleton } from '@/components/ui/surface';
import { errorMessage } from '@/lib/api';
import { useAction, useGet } from '@/lib/query';

const NEAR: Record<string, string> = { 'same postal region': 'Same area', 'nearby region': 'Nearby', 'far region': 'Far away' };

/**
 * Steps 4–7: the system ranks the distributors for this lead's pincode, size and product and suggests the best ones.
 * A person then ticks whom to send the request to (one or several, perfect match or not); the first to accept gets the lead.
 */
export function DistributorPicker({ leadId, onSent, title }: { leadId: string; onSent?: () => void; title?: string }) {
  const { t } = useTranslation();
  const q = useGet<LeadSuggestions>(`/leads/${leadId}/suggestions`);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const send = useAction<{ distributor_ids: string[] }>({
    path: `/leads/${leadId}/requests`, invalidate: ['/leads', '/followups'],
    successMessage: t('leads.req.sent', 'Request sent. The first distributor to accept gets the lead.'),
    onSuccess: () => { setPicked(new Set()); onSent?.(); },
  });
  const all = useMemo(() => q.data?.candidates ?? [], [q.data]);
  const recommended = all.filter((c) => c.recommended);
  const others = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return all.filter((c) => !c.recommended && (!f || `${c.name} ${c.city ?? ''} ${c.home_pincode ?? ''}`.toLowerCase().includes(f)));
  }, [all, filter]);
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  if (q.isLoading) return <div className="space-y-3" role="status" aria-label="Loading"><Skeleton className="h-20" /><Skeleton className="h-40" /></div>;
  if (q.error) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  if (!all.length) return <Callout tone="warning">{t('leads.req.none', 'No distributors are set up yet.')}</Callout>;

  const row = (c: LeadSuggestion) => {
    const asked = c.request_status === 'pending';
    return (
      <li key={c.distributor_id} className="flex items-start gap-3 px-4 py-3">
        <Checkbox
          aria-label={`${t('leads.req.pick', 'Send the request to')} ${c.name}`} checked={picked.has(c.distributor_id)} disabled={asked} onChange={() => toggle(c.distributor_id)}
          label={<span className="font-semibold">{c.name.replace(/\s*\(Demo\)\s*$/, '')}</span>}
          hint={<>{[c.city, c.home_pincode].filter(Boolean).join(' · ')}{!c.eligible && c.reasons.length ? <span className="block text-warning-text">{c.reasons.join(' · ')}</span> : null}</>}
        />
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5 text-xs">
          {c.distance_hint && <Badge tone={c.distance_hint === 'same postal region' ? 'success' : 'neutral'}>{NEAR[c.distance_hint] ?? c.distance_hint}</Badge>}
          {c.eligible ? <Badge tone="primary">{t('leads.req.fit', 'Good match')}</Badge> : <Badge tone="warning">{t('leads.req.notPerfect', 'Not a perfect match')}</Badge>}
          {asked && <Badge tone="info">{t('leads.req.asked', 'Asked')}</Badge>}
          {c.request_status === 'rejected' && <Badge tone="danger">{t('leads.req.declined', 'Declined earlier')}</Badge>}
          <span className="tabular text-muted" title={t('leads.req.score', 'Distributor score')}>{c.score}</span>
        </div>
      </li>
    );
  };

  return (
    <section className="space-y-5" aria-label={title ?? t('leads.req.title', 'Choose distributors')}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="font-sans text-base font-bold">{title ?? t('leads.req.title', 'Choose whom to send the request to')}</h3>
          <p className="mt-0.5 text-sm text-muted">
            {q.data?.territory_name ? `${q.data.territory_name} · ` : ''}{t('leads.req.sub', 'Best matches first. You can also pick a distributor that is not a perfect match. The first to accept gets the lead.')}
          </p>
        </div>
        {recommended.length > 0 && (
          <Button size="sm" variant="secondary" leftIcon={<Check className="h-4 w-4" aria-hidden />} onClick={() => setPicked(new Set(recommended.filter((c) => c.request_status !== 'pending').map((c) => c.distributor_id)))}>
            {t('leads.req.selectBest', 'Select the best matches')}
          </Button>
        )}
      </div>

      {recommended.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.08em] text-primary-text">{t('leads.req.recommended', 'Recommended for this pincode')}</p>
          <ul className="divide-y divide-border rounded-xl border border-primary/40 bg-primary-soft/40" aria-label={t('leads.req.recommended', 'Recommended for this pincode')}>{recommended.map(row)}</ul>
        </div>
      )}

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-muted">{recommended.length ? t('leads.req.others', 'Other distributors') : t('leads.req.all', 'All distributors')} · {others.length}</p>
          <Input className="w-full sm:w-64" aria-label={t('leads.req.search', 'Search distributors')} placeholder={t('leads.req.searchPh', 'Search name, city or pincode')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-xl border border-border" aria-label={t('leads.req.others', 'Other distributors')}>
          {others.map(row)}
          {others.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted">{t('leads.req.noMatch', 'No distributor matches that search.')}</li>}
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button leftIcon={<Send className="h-4 w-4" aria-hidden />} disabled={picked.size === 0} loading={send.isPending} onClick={() => send.mutate({ distributor_ids: [...picked] })}>
          {picked.size > 1 ? t('leads.req.sendMany', 'Send request to {{n}} distributors', { n: picked.size }) : t('leads.req.sendOne', 'Send request')}
        </Button>
        {picked.size === 0 && <span className="text-sm text-muted">{t('leads.req.tick', 'Tick one or more distributors first.')}</span>}
      </div>
    </section>
  );
}
