import { randomUUID } from 'node:crypto';
import { hashMobile } from '@solar/shared';
import type { Db } from '../db/types';
import type { Logger } from '../lib/logger';
import type { DndRegistry, DndResult, EInvoiceProvider, EmailProvider, EwayBillProvider, InboundMessage, PincodeLookup, SmsProvider, WhatsAppProvider } from './types';

/**
 * Working mocks: they succeed, return clearly-fake references and log what a real provider would have sent.
 * The consent-aware pipeline (services/messagingService) writes the message_log row; mocks only transport.
 */
const OPTOUT = /^\s*(stop|unsubscribe|opt[\s-]?out|cancel)\s*$/i;

export class MockWhatsApp implements WhatsAppProvider {
  readonly name = 'mock-whatsapp';
  constructor(private log: Logger) {}
  async sendTemplate(i: Parameters<WhatsAppProvider['sendTemplate']>[0]) {
    this.log.info({ to: 'redacted', template: i.template_name, category: i.category }, '[mock] WhatsApp template sent');
    return { ok: true, provider: this.name, ref: `MOCK-WA-${randomUUID().slice(0, 8)}` };
  }
  async sendSession(i: Parameters<WhatsAppProvider['sendSession']>[0]) {
    this.log.info({ to: 'redacted', chars: i.body.length }, '[mock] WhatsApp session message sent');
    return { ok: true, provider: this.name, ref: `MOCK-WA-${randomUUID().slice(0, 8)}` };
  }
  parseInbound(payload: unknown): InboundMessage[] {
    // accepts { from, body, id? } or { messages: [{ from, text: { body }, id }] } (Meta Cloud API shape)
    const p = payload as { from?: string; body?: string; id?: string; messages?: { from?: string; id?: string; text?: { body?: string } }[]; entry?: { changes?: { value?: { messages?: { from?: string; id?: string; text?: { body?: string } }[] } }[] }[] };
    const raw: { from?: string; id?: string; body?: string }[] = [];
    if (p?.from) raw.push({ from: p.from, body: p.body, id: p.id });
    for (const m of p?.messages ?? []) raw.push({ from: m.from, body: m.text?.body, id: m.id });
    for (const e of p?.entry ?? []) for (const c of e.changes ?? []) for (const m of c.value?.messages ?? []) raw.push({ from: m.from, body: m.text?.body, id: m.id });
    return raw.filter((m) => m.from).map((m) => ({
      from: m.from!.startsWith('+') ? m.from! : `+${m.from!}`, body: m.body ?? '', received_at: new Date().toISOString(), provider_ref: m.id ?? null,
      kind: OPTOUT.test(m.body ?? '') ? 'optout' : /^\s*(start|yes|subscribe)\s*$/i.test(m.body ?? '') ? 'optin' : 'text',
    }));
  }
}

export class MockSms implements SmsProvider {
  readonly name = 'mock-sms';
  constructor(private log: Logger) {}
  async send(i: Parameters<SmsProvider['send']>[0]) {
    if (!i.dlt_template_id || !i.dlt_header) return { ok: false, provider: this.name, ref: null, error: 'DLT template id and header are mandatory' };
    this.log.info({ to: 'redacted', dlt: i.dlt_template_id, header: i.dlt_header }, '[mock] SMS sent');
    return { ok: true, provider: this.name, ref: `MOCK-SMS-${randomUUID().slice(0, 8)}` };
  }
}

export class MockEmail implements EmailProvider {
  readonly name = 'mock-email';
  constructor(private log: Logger) {}
  async send(i: Parameters<EmailProvider['send']>[0]) {
    this.log.info({ to: 'redacted', subject: i.subject, attachments: i.attachments?.length ?? 0 }, '[mock] e-mail sent (console only)');
    return { ok: true, provider: this.name, ref: `MOCK-MAIL-${randomUUID().slice(0, 8)}` };
  }
}

/** Mock DND register: a mobile is 'registered' when the local dnd_register table says so (hashed); everything else is clear. */
export class MockDnd implements DndRegistry {
  readonly name = 'mock-dnd';
  constructor(private db: Db) {}
  async check(mobile: string): Promise<DndResult> {
    const row = await this.db.table('dnd_register').one({ mobile_hash: hashMobile(mobile) });
    if (!row) return 'clear';
    return row.status === 'clear' ? 'clear' : row.status === 'blocked' ? 'blocked' : 'registered';
  }
}

export class MockEInvoice implements EInvoiceProvider {
  readonly name = 'mock-einvoice';
  async generateIrn(i: Parameters<EInvoiceProvider['generateIrn']>[0]) {
    return { status: 'manual_pending' as const, irn: `MOCK-IRN-NOT-REAL-${i.invoice_no}`, ack_no: null, ack_date: null, message: 'Mock provider — enter the real IRN manually after filing on the e-invoice portal.' };
  }
}
export class MockEwayBill implements EwayBillProvider {
  readonly name = 'mock-ewaybill';
  async generate(i: Parameters<EwayBillProvider['generate']>[0]) {
    return { status: 'manual_pending' as const, ewb_no: `MOCK-EWB-NOT-REAL-${i.invoice_no}`, message: 'Mock provider — generate the e-way bill on the portal and record the number manually.' };
  }
}

/** Local pincode table first (any org); an external geocoder can be chained here later. */
export class LocalPincodeLookup implements PincodeLookup {
  constructor(private db: Db) {}
  async lookup(pincode: string) {
    const row = await this.db.table('pincodes').one({ pincode });
    return row ? { city: row.city, district: row.district, state: row.state } : null;
  }
}
