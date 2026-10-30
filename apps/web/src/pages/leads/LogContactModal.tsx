import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CONTACT_OUTCOME_LABEL, type ContactOutcome } from '@solar/shared';
import { Button } from '@/components/ui/button';
import { Field, Select, Textarea } from '@/components/ui/form';
import { Modal } from '@/components/ui/overlay';
import { useAction } from '@/lib/query';

const CHANNELS = [{ value: 'call', label: 'Call' }, { value: 'whatsapp', label: 'WhatsApp' }, { value: 'visit', label: 'Visit' }];
const OUTCOMES: ContactOutcome[] = ['connected_interested', 'connected_not_now', 'connected_not_interested', 'no_answer', 'busy_call_back', 'wrong_number', 'message_delivered', 'message_replied', 'visit_done', 'visit_rescheduled'];

/** Log a contact (call / WhatsApp / visit + outcome) — PDF step 8 and every follow-up after it. */
export function LogContactModal({ leadId, leadName, open, onClose, title }: { leadId: string; leadName?: string; open: boolean; onClose: () => void; title?: string }) {
  const { t } = useTranslation();
  const [channel, setChannel] = useState('call');
  const [outcome, setOutcome] = useState('connected_interested');
  const [notes, setNotes] = useState('');
  const save = useAction<Record<string, unknown>>({
    path: `/leads/${leadId}/contacts`, invalidate: ['/leads', '/followups'], successMessage: t('leads.contact.saved', 'Contact logged'),
    onSuccess: () => { setNotes(''); onClose(); },
  });
  return (
    <Modal
      open={open} onClose={onClose} size="sm" title={title ?? t('leads.contact.title', 'Log a contact')} description={leadName}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button><Button loading={save.isPending} onClick={() => save.mutate({ channel, outcome, ...(notes.trim() && { notes: notes.trim() }) })}>{t('leads.contact.save', 'Save contact')}</Button></>}
    >
      <div className="space-y-5">
        <Field label={t('leads.contact.how', 'How did you reach them?')}>
          <Select value={channel} onChange={(e) => setChannel(e.target.value)}>{CHANNELS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</Select>
        </Field>
        <Field label={t('leads.contact.outcome', 'What happened?')}>
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value)}>{OUTCOMES.map((o) => <option key={o} value={o}>{CONTACT_OUTCOME_LABEL[o]}</option>)}</Select>
        </Field>
        <Field label={t('leads.contact.notes', 'Note')} optional><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
