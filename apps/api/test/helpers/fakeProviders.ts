import type { DndResult, InboundMessage, Providers, SignedUrl } from '../../src/providers/types';

export interface FakeProviders extends Providers {
  calls: {
    whatsappTemplate: { to: string; template_name: string }[]; whatsappSession: { to: string; body: string }[];
    sms: { to: string; dlt_template_id: string; dlt_header: string }[]; email: { to: string; subject: string; text: string; html?: string }[];
  };
  dndOverrides: Map<string, DndResult>;
  files: Map<string, Buffer>;
}

/** Providers for tests — nothing leaves the process. Inspect `.calls` to assert what would have been sent. */
export function fakeProviders(): FakeProviders {
  const calls: FakeProviders['calls'] = { whatsappTemplate: [], whatsappSession: [], sms: [], email: [] };
  const dndOverrides = new Map<string, DndResult>();
  const files = new Map<string, Buffer>();
  let n = 0;
  const ref = (p: string) => `${p}-${++n}`;
  return {
    calls, dndOverrides, files,
    whatsapp: {
      name: 'fake-whatsapp',
      sendTemplate: async (i) => { calls.whatsappTemplate.push({ to: i.to, template_name: i.template_name }); return { ok: true, provider: 'fake-whatsapp', ref: ref('wat') }; },
      sendSession: async (i) => { calls.whatsappSession.push({ to: i.to, body: i.body }); return { ok: true, provider: 'fake-whatsapp', ref: ref('was') }; },
      parseInbound: (payload): InboundMessage[] => {
        const p = payload as { from?: string; body?: string };
        if (!p?.from) return [];
        const kind = /^\s*(stop|unsubscribe|opt.?out)\s*$/i.test(p.body ?? '') ? 'optout' : 'text';
        return [{ from: p.from, body: p.body ?? '', received_at: new Date().toISOString(), provider_ref: ref('in'), kind }];
      },
    },
    sms: { name: 'fake-sms', send: async (i) => { calls.sms.push({ to: i.to, dlt_template_id: i.dlt_template_id, dlt_header: i.dlt_header }); return { ok: true, provider: 'fake-sms', ref: ref('sms') }; } },
    email: { name: 'fake-email', send: async (i) => { calls.email.push({ to: i.to, subject: i.subject, text: i.text, html: i.html }); return { ok: true, provider: 'fake-email', ref: ref('em') }; } },
    dnd: { name: 'fake-dnd', check: async (m) => dndOverrides.get(m) ?? 'clear' },
    einvoice: { name: 'fake-einvoice', generateIrn: async () => ({ status: 'manual_pending', irn: 'FAKE-IRN-NOT-REAL', ack_no: null, ack_date: null, message: 'Mock provider' }) },
    ewayBill: { name: 'fake-ewb', generate: async () => ({ status: 'manual_pending', ewb_no: 'FAKE-EWB-NOT-REAL', message: 'Mock provider' }) },
    pincode: {
      lookup: async (p) => ({ '380001': { city: 'Ahmedabad', district: 'Ahmedabad', state: 'Gujarat' }, '395003': { city: 'Surat', district: 'Surat', state: 'Gujarat' }, '390001': { city: 'Vadodara', district: 'Vadodara', state: 'Gujarat' } } as Record<string, { city: string; district: string; state: string }>)[p] ?? null,
    },
    storage: {
      name: 'fake-storage',
      upload: async ({ bucket, path, content }) => { files.set(`${bucket}/${path}`, content); },
      signedUrl: async ({ bucket, path, method, expiresInSec }): Promise<SignedUrl> => ({ url: `https://fake.storage/${bucket}/${path}?sig=test`, expires_at: new Date(Date.now() + expiresInSec * 1000).toISOString(), method }),
      download: async ({ bucket, path }) => files.get(`${bucket}/${path}`) ?? null,
      remove: async ({ bucket, path }) => { files.delete(`${bucket}/${path}`); },
    },
  };
}
