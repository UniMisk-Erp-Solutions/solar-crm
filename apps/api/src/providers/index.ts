import type { Config } from '../config';
import { SupabaseDb } from '../db/supabase';
import type { Db } from '../db/types';
import type { Logger } from '../lib/logger';
import { LocalPincodeLookup, MockDnd, MockEInvoice, MockEmail, MockEwayBill, MockSms, MockWhatsApp } from './mock';
import { ResendEmail } from './resend';
import { SmtpEmail } from './smtp';
import { MemoryStorage, SupabaseStorage } from './storage';
import type { Providers } from './types';

export * from './types';

/** Select providers from env. Only mocks exist for WhatsApp/SMS/DND/e-invoice/e-way bill today — real adapters implement the same interfaces. */
export function buildProviders(config: Config, db: Db, log: Logger): Providers {
  return {
    whatsapp: new MockWhatsApp(log),
    sms: new MockSms(log),
    email: config.EMAIL_PROVIDER === 'resend' && config.RESEND_API_KEY ? new ResendEmail(config.RESEND_API_KEY, config.EMAIL_FROM)
      : config.EMAIL_PROVIDER === 'smtp' && config.SMTP_HOST ? new SmtpEmail(config) : new MockEmail(log),
    dnd: new MockDnd(db),
    einvoice: new MockEInvoice(),
    ewayBill: new MockEwayBill(),
    pincode: new LocalPincodeLookup(db),
    storage: config.dataMode === 'supabase' && db instanceof SupabaseDb ? new SupabaseStorage(db.client) : new MemoryStorage(config.PUBLIC_API_URL),
  };
}
