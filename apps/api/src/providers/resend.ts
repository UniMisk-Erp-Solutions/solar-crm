import type { EmailProvider, ProviderResult } from './types';

/**
 * E-mail through the Resend HTTPS API (EMAIL_PROVIDER=resend, RESEND_API_KEY, EMAIL_FROM).
 * SMTP is not an option inside a Supabase Edge Function (outgoing SMTP ports are blocked), so this talks plain HTTPS.
 * With the shared sender onboarding@resend.dev Resend delivers only to the address the Resend account was created with; verify a domain to send to anyone.
 */
export class ResendEmail implements EmailProvider {
  readonly name = 'resend';
  constructor(private apiKey: string, private from: string, private fetchFn: typeof fetch = fetch) {}

  async send(i: Parameters<EmailProvider['send']>[0]): Promise<ProviderResult> {
    try {
      const res = await this.fetchFn('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: this.from, to: [i.to], subject: i.subject, text: i.text, ...(i.html ? { html: i.html } : {}),
          ...(i.attachments?.length ? { attachments: i.attachments.map((a) => ({ filename: a.filename, content: a.content.toString('base64') })) } : {}),
        }),
      });
      const out = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
      if (!res.ok) return { ok: false, provider: this.name, ref: null, error: out.message ?? `Resend answered ${res.status}` };
      return { ok: true, provider: this.name, ref: out.id ?? null };
    } catch (e) {
      return { ok: false, provider: this.name, ref: null, error: (e as Error).message };
    }
  }
}
