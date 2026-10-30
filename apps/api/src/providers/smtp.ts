import nodemailer from 'nodemailer';
import type { Config } from '../config';
import type { EmailProvider } from './types';

/** Real e-mail via SMTP (nodemailer). Selected with EMAIL_PROVIDER=smtp plus SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS. */
export class SmtpEmail implements EmailProvider {
  readonly name = 'smtp';
  private transport;
  constructor(private config: Config) {
    this.transport = nodemailer.createTransport({
      host: config.SMTP_HOST, port: config.SMTP_PORT ?? 587, secure: (config.SMTP_PORT ?? 587) === 465,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
    });
  }
  async send(i: Parameters<EmailProvider['send']>[0]) {
    try {
      const info = await this.transport.sendMail({ from: this.config.SMTP_FROM, to: i.to, subject: i.subject, text: i.text, html: i.html, attachments: i.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })) });
      return { ok: true, provider: this.name, ref: info.messageId ?? null };
    } catch (e) {
      return { ok: false, provider: this.name, ref: null, error: (e as Error).message };
    }
  }
}
