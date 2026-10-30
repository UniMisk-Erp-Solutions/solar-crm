import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LeadListItem } from '@solar/shared';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/form';
import { useAction, useList } from '@/lib/query';

interface DistributorRow { id: string; legal_name: string; trade_name: string | null }

/** Pick a distributor and hand the lead over (POST /leads/:id/reassign). */
export function AssignControl({ leadId, onDone }: { leadId: string; onDone?: (lead: LeadListItem) => void }) {
  const { t } = useTranslation();
  const [pick, setPick] = useState('');
  const list = useList<DistributorRow>('/distributors', { limit: 200, status: 'active' });
  const assign = useAction<{ distributor_id: string; reason: string }, LeadListItem>({
    path: `/leads/${leadId}/reassign`, invalidate: ['/leads', '/followups'], successMessage: t('leads.assign.done', 'Inquiry assigned'),
    onSuccess: (lead) => onDone?.(lead),
  });
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select aria-label={t('leads.assign.pick', 'Distributor')} placeholder={t('leads.assign.choose', 'Choose a distributor…')} value={pick} onChange={(e) => setPick(e.target.value)} className="max-w-xs">
        {(list.data?.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.trade_name || d.legal_name}</option>)}
      </Select>
      <Button size="sm" disabled={!pick} loading={assign.isPending} onClick={() => assign.mutate({ distributor_id: pick, reason: 'Assigned by admin' })}>{t('leads.assign.button', 'Assign')}</Button>
    </div>
  );
}
