import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Select, Textarea } from '@/components/ui/form';
import { Modal } from '@/components/ui/overlay';
import { useAction } from '@/lib/query';

const NOTICE_VERSION = 'default-v1';
const HOW: [string, string][] = [['phone_call', 'On a phone call'], ['in_person', 'In person / site visit'], ['whatsapp', 'On WhatsApp'], ['signed_form', 'Signed form'], ['email', 'By e-mail']];
const CHANNELS: [string, string][] = [['call', 'Call'], ['sms', 'SMS'], ['whatsapp', 'WhatsApp'], ['email', 'E-mail']];

/**
 * Records, on behalf of the customer, that they agreed to be contacted (the consent ledger row the send pipeline checks before any quotation,
 * reminder or offer goes out). The person recording it states how the customer agreed; nothing is sent by this.
 */
export function RecordConsentModal({ leadId, open, onClose, onDone }: { leadId: string; open: boolean; onClose: () => void; onDone?: () => void }) {
  const { t } = useTranslation();
  const [agreed, setAgreed] = useState(false);
  const [how, setHow] = useState('phone_call');
  const [channels, setChannels] = useState<Set<string>>(new Set(['call', 'sms', 'whatsapp']));
  const [note, setNote] = useState('');
  const add = useAction<Record<string, unknown>>({
    path: `/leads/${leadId}/consents`, invalidate: ['/leads', '/quotes'], successMessage: t('consent.saved', 'Consent recorded'),
    onSuccess: () => { onClose(); setAgreed(false); setNote(''); onDone?.(); },
  });
  const toggle = (c: string) => setChannels((p) => { const n = new Set(p); if (n.has(c)) n.delete(c); else n.add(c); return n; });
  const label = HOW.find(([v]) => v === how)?.[1] ?? how;
  const ok = agreed && channels.size > 0;

  return (
    <Modal
      open={open} onClose={onClose} size="md" title={t('consent.title', 'Record customer consent')} description={t('consent.sub', 'Only record this after the customer has clearly agreed.')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button><Button disabled={!ok} loading={add.isPending} onClick={() => add.mutate({
        notice_version: NOTICE_VERSION, purposes: ['service', 'quotation', 'promotional'], channels: [...channels], capture_source: 'staff_entry',
        proof_ref: `${label}${note.trim() ? ` — ${note.trim()}` : ''}`.slice(0, 200),
      })}>{t('consent.save', 'Record consent')}</Button></>}
    >
      <div className="space-y-5">
        <Checkbox label={t('consent.agreed', 'The customer agreed to be contacted about this quotation and our offers')} checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <Field label={t('consent.how', 'How did they agree?')} htmlFor="consent-how">
          <Select id="consent-how" value={how} onChange={(e) => setHow(e.target.value)}>{HOW.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </Field>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-semibold">{t('consent.channels', 'They may be contacted by')}</legend>
          <div className="flex flex-wrap gap-4">{CHANNELS.map(([v, l]) => <Checkbox key={v} label={l} checked={channels.has(v)} onChange={() => toggle(v)} />)}</div>
        </fieldset>
        <Field label={t('consent.note', 'Note (optional)')} htmlFor="consent-note"><Textarea id="consent-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. agreed on call at 4 pm" /></Field>
      </div>
    </Modal>
  );
}
