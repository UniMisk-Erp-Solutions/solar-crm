/**
 * External-provider adapter interfaces. Every provider has a working Mock (providers/mock/*) selected by env var.
 * The send pipeline (services/messagingService) enforces consent / DND / WhatsApp-window rules BEFORE calling these.
 */
import type { DocumentBucket, TemplateCategory } from '@solar/shared';

export interface ProviderResult { ok: boolean; provider: string; ref: string | null; error?: string }

export interface InboundMessage { from: string; body: string; received_at: string; provider_ref: string | null; kind: 'text' | 'optout' | 'optin' | 'media' }

export interface WhatsAppProvider {
  readonly name: string;
  /** Approved template message (works outside the 24-hour window). */
  sendTemplate(input: { to: string; template_name: string; category: TemplateCategory; language: string; vars: Record<string, string> }): Promise<ProviderResult>;
  /** Free-form message — ONLY legal inside the 24-hour customer-service window. */
  sendSession(input: { to: string; body: string }): Promise<ProviderResult>;
  /** Parse a provider webhook payload into normalised inbound messages (STOP / UNSUBSCRIBE become kind 'optout'). */
  parseInbound(payload: unknown): InboundMessage[];
}

export interface SmsProvider {
  readonly name: string;
  /** DLT template id and sender header are mandatory in India. */
  send(input: { to: string; body: string; dlt_template_id: string; dlt_header: string }): Promise<ProviderResult>;
}

export interface EmailProvider {
  readonly name: string;
  send(input: { to: string; subject: string; text: string; html?: string; attachments?: { filename: string; content: Buffer; contentType: string }[] }): Promise<ProviderResult>;
}

export type DndResult = 'clear' | 'registered' | 'blocked';
export interface DndRegistry {
  readonly name: string;
  /** Scrub a mobile (E.164) against the preference register. */
  check(mobile: string): Promise<DndResult>;
}

export interface EInvoiceProvider {
  readonly name: string;
  generateIrn(input: { invoice_no: string; invoice_date: string; seller_gstin: string | null; buyer_gstin: string | null; total: number }): Promise<{ status: 'generated' | 'manual_pending' | 'failed'; irn: string | null; ack_no: string | null; ack_date: string | null; message?: string }>;
}
export interface EwayBillProvider {
  readonly name: string;
  generate(input: { invoice_no: string; vehicle_no: string | null; from_pincode: string | null; to_pincode: string | null; value: number }): Promise<{ status: 'generated' | 'manual_pending' | 'failed'; ewb_no: string | null; message?: string }>;
}

export interface PincodeLookup {
  /** Local table first; external adapter later. */
  lookup(pincode: string): Promise<{ city: string; district: string; state: string } | null>;
}

export interface SignedUrl { url: string; expires_at: string; method: 'GET' | 'PUT' }
export interface FileStorage {
  readonly name: string;
  upload(input: { bucket: DocumentBucket; path: string; content: Buffer; contentType: string }): Promise<void>;
  /** Short-lived signed URL (read or upload). Paths MUST start with `<org_id>/`. */
  signedUrl(input: { bucket: DocumentBucket; path: string; method: 'GET' | 'PUT'; expiresInSec: number }): Promise<SignedUrl>;
  download(input: { bucket: DocumentBucket; path: string }): Promise<Buffer | null>;
  remove(input: { bucket: DocumentBucket; path: string }): Promise<void>;
}

export interface Providers {
  whatsapp: WhatsAppProvider;
  sms: SmsProvider;
  email: EmailProvider;
  dnd: DndRegistry;
  einvoice: EInvoiceProvider;
  ewayBill: EwayBillProvider;
  pincode: PincodeLookup;
  storage: FileStorage;
}
