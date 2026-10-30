import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { Opportunity } from '@solar/shared';
import { formatINR } from '@solar/shared';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/form';
import { Modal } from '@/components/ui/overlay';
import { Callout } from '@/components/ui/surface';
import { useAction, useList } from '@/lib/query';

/** New quotation: pick an opportunity, create the quote, open it. */
export default function NewQuoteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [oppId, setOppId] = useState('');
  const opps = useList<Opportunity>(open ? '/opportunities' : null, { stage: 'qualified,quotation,negotiation,pi_stage', limit: 200 });
  const create = useAction<{ opportunity_id: string }, { id: string }>({ path: '/quotes', invalidate: ['/quotes', '/opportunities'], onSuccess: (q) => { onClose(); navigate(`/quotes/${q.id}`); } });
  const rows = opps.data?.data ?? [];
  return (
    <Modal open={open} onClose={onClose} title={t('quotes.new.title', 'New quotation')} description={t('quotes.new.desc', 'Choose the opportunity this quotation is for.')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button><Button loading={create.isPending} disabled={!oppId} onClick={() => create.mutate({ opportunity_id: oppId })}>{t('quotes.new.create', 'Create quotation')}</Button></>}>
      {!opps.isLoading && rows.length === 0 ? (
        <Callout tone="neutral">{t('quotes.new.none', 'There is no open opportunity yet. Convert a qualified lead under Site & Opportunity first.')}</Callout>
      ) : (
        <Field label={t('quotes.new.opp', 'Opportunity')} required>
          <Select value={oppId} onChange={(e) => setOppId(e.target.value)} placeholder={t('quotes.new.pick', 'Select an opportunity')}>
            {rows.map((o) => <option key={o.id} value={o.id}>{o.name} · {o.kw} kW · {formatINR(o.expected_value)}</option>)}
          </Select>
        </Field>
      )}
    </Modal>
  );
}
