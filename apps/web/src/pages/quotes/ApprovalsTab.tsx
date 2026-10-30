import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ROLE_LABEL, type Approval } from '@solar/shared';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/form';
import { Modal } from '@/components/ui/overlay';
import { FilterPills } from '@/components/ui/filters';
import { EmptyState, ErrorState, SkeletonCards } from '@/components/ui/surface';
import { DateTimeText } from '@/components/domain/values';
import { Money } from '@/components/domain/values';
import { api, errorMessage, type One } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { invalidatePaths, useList } from '@/lib/query';

interface ChainStep { step: number; required_role: string; decision: string }
export type ApprovalRow = Approval & {
  actionable: boolean;
  entity: { entity_type: string; entity_id: string; title: string; subtitle: string | null; value: number | null; link: string | null } | null;
  chain: ChainStep[];
};
interface Group { entityId: string; entity: NonNullable<ApprovalRow['entity']>; lanes: Map<string, ApprovalRow[]> }

const SHORT: Record<string, string> = { dsm: 'DSM', regional_head: 'Regional Head', management: 'Management', sales_manager: 'Sales Manager', accounts: 'Accounts', compliance_officer: 'Compliance' };
const roleName = (r: string) => SHORT[r] ?? (ROLE_LABEL as Record<string, string>)[r] ?? r;

/** One dot per approver in the chain: filled when approved, outlined olive for whoever is up now, red when rejected. */
function Dots({ label, steps, current }: { label?: string; steps: ChainStep[]; current: number | null }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" aria-label={label}>
      {label && <li className="mr-1 text-xs font-bold uppercase tracking-wide text-muted">{label}</li>}
      {steps.map((s, i) => {
        const state = s.decision === 'approved' ? 'done' : s.decision === 'rejected' ? 'no' : s.step === current ? 'now' : 'wait';
        return (
          <li key={`${s.step}-${i}`} className="flex items-center gap-1.5" aria-current={state === 'now' ? 'step' : undefined}>
            <span aria-hidden className={cn('h-3 w-3 rounded-full border-2', state === 'done' && 'border-primary bg-primary', state === 'now' && 'border-primary bg-surface ring-2 ring-primary/30', state === 'no' && 'border-danger bg-danger', state === 'wait' && 'border-border-strong bg-surface')} />
            <span className={cn(state === 'now' ? 'font-semibold text-fg' : 'text-muted')}>{roleName(s.required_role)}</span>
            {i < steps.length - 1 && <span aria-hidden className="ml-1 text-subtle">→</span>}
          </li>
        );
      })}
    </ol>
  );
}

const chainOf = (rows: ApprovalRow[]): ChainStep[] => {
  const withChain = rows.find((r) => r.chain?.length);
  if (withChain) return withChain.chain;
  return [...rows].sort((a, b) => a.step - b.step).map((r) => ({ step: r.step, required_role: r.required_role, decision: r.decision }));
};

function PendingApprovals() {
  const { t } = useTranslation();
  const list = useList<ApprovalRow>('/approvals', { entity_type: 'quotation', decision: 'pending', limit: 100 });
  const [rejecting, setRejecting] = useState<ApprovalRow | null>(null);
  const [comment, setComment] = useState('');
  const toast = useToast();
  const qc = useQueryClient();
  const closeReject = useCallback(() => setRejecting(null), []);
  const decide = useMutation({
    mutationFn: ({ id, ...body }: { id: string; decision: 'approved' | 'rejected'; comment?: string }) => api.post<One<unknown>>(`/approvals/${id}/decide`, body),
    onSuccess: async () => { await invalidatePaths(qc, ['/approvals', '/quotes']); toast.success(t('approvals.done', 'Decision saved')); setRejecting(null); setComment(''); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const groups = useMemo<Group[]>(() => {
    const m = new Map<string, Group>();
    for (const r of list.data?.data ?? []) {
      if (!r.entity) continue;
      const g = m.get(r.entity_id) ?? { entityId: r.entity_id, entity: r.entity, lanes: new Map<string, ApprovalRow[]>() };
      g.lanes.set(r.lane, [...(g.lanes.get(r.lane) ?? []), r]);
      m.set(r.entity_id, g);
    }
    return [...m.values()];
  }, [list.data]);

  if (list.isLoading) return <SkeletonCards count={2} />;
  if (list.error) return <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} />;
  if (groups.length === 0) return <EmptyState title={t('approvals.empty', 'Nothing waiting for approval.')} />;

  return (
    <div className="space-y-6">
      {groups.map((g) => {
        const mainLane = g.lanes.has('commercial') ? 'commercial' : [...g.lanes.keys()][0]!;
        const main = g.lanes.get(mainLane)!;
        const target = main.find((r) => r.actionable) ?? [...main].sort((a, b) => a.step - b.step)[0]!;
        const extra = [...g.lanes.entries()].filter(([lane]) => lane !== mainLane);
        return (
          <article key={g.entityId} className="card space-y-5 p-6" aria-label={g.entity.title}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <Link to={g.entity.link ?? `/quotes/${g.entityId}`} className="code text-base font-semibold hover:underline">{g.entity.title}</Link>
                {g.entity.subtitle && <p className="text-sm text-muted">{g.entity.subtitle}</p>}
              </div>
              <p className="display text-2xl"><Money value={g.entity.value} /></p>
            </div>
            <div className="space-y-2">
              <Dots steps={chainOf(main)} current={target.step} />
              {extra.map(([lane, rows]) => <Dots key={lane} label={lane === 'compliance' ? 'Compliance' : lane === 'credit' ? 'Credit' : lane} steps={chainOf(rows)} current={rows.find((r) => r.actionable)?.step ?? null} />)}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button loading={decide.isPending && decide.variables?.id === target.id} disabled={!target.actionable} onClick={() => decide.mutate({ id: target.id, decision: 'approved' })}>{t('approvals.approve', 'Approve')}</Button>
              <Button variant="secondary" disabled={!target.actionable} onClick={() => setRejecting(target)}>{t('approvals.reject', 'Reject')}</Button>
              {!target.actionable && <span className="text-sm text-muted">{t('approvals.notYet', 'Waiting for an earlier approver.')}</span>}
            </div>
          </article>
        );
      })}

      <Modal open={!!rejecting} onClose={closeReject} title={t('approvals.rejectTitle', 'Reject this quotation')} size="sm"
        footer={<><Button variant="ghost" onClick={closeReject}>{t('common.cancel', 'Cancel')}</Button>
          <Button variant="danger" loading={decide.isPending} disabled={comment.trim().length < 3} onClick={() => rejecting && decide.mutate({ id: rejecting.id, decision: 'rejected', comment: comment.trim() })}>{t('approvals.confirmReject', 'Reject')}</Button></>}>
        <Field label={t('approvals.comment', 'Comment')} required hint={t('approvals.commentHint', 'Tell the team why, in a few words.')}><Textarea value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      </Modal>
    </div>
  );
}

/** Decided approvals stay visible: who decided, when, and the comment, so nothing disappears once it is done. */
function DecidedApprovals({ decision }: { decision: 'approved' | 'rejected' }) {
  const { t } = useTranslation();
  const list = useList<ApprovalRow>('/approvals', { entity_type: 'quotation', decision, scope: 'all', limit: 100 });
  if (list.isLoading) return <SkeletonCards count={2} />;
  if (list.error) return <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} />;
  const rows = list.data?.data ?? [];
  if (!rows.length) return <EmptyState title={decision === 'approved' ? t('approvals.noneApproved', 'Nothing approved yet.') : t('approvals.noneRejected', 'Nothing rejected.')} />;
  return (
    <ul className="card divide-y divide-border">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-x-6 gap-y-1 px-6 py-4 text-sm">
          <div className="min-w-0 flex-1">
            {r.entity ? <Link to={r.entity.link ?? '/quotes/' + r.entity.entity_id} className="code font-semibold hover:underline">{r.entity.title}</Link> : <span className="code">{r.entity_id}</span>}
            {r.entity?.subtitle && <span className="ml-2 text-muted">{r.entity.subtitle}</span>}
            {r.comment && <p className="mt-1 text-muted">{r.comment}</p>}
          </div>
          <span className="text-muted">{roleName(r.required_role)}</span>
          <span className="text-muted">{r.decided_at ? <DateTimeText value={r.decided_at} /> : ''}</span>
          {r.entity?.value != null && <span className="tabular font-semibold"><Money value={r.entity.value} /></span>}
        </li>
      ))}
    </ul>
  );
}

export default function ApprovalsTab() {
  const { t } = useTranslation();
  const [pill, setPill] = useState<'pending' | 'approved' | 'rejected'>('pending');
  return (
    <div className="space-y-6">
      <FilterPills label={t('approvals.filter', 'Approval status')} value={pill} onChange={(v) => setPill(v as typeof pill)}
        options={[{ value: 'pending', label: 'Waiting' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }]} />
      {pill === 'pending' ? <PendingApprovals /> : <DecidedApprovals decision={pill} />}
    </div>
  );
}
