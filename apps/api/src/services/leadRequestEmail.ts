/**
 * The e-mail a distributor gets when a lead is sent to them: the lead in brief, the time they have, and two buttons (accept / decline) that open a
 * small page in the web app. Nothing changes until they press the confirm button on that page (mail scanners open links, so a link alone never decides).
 */
import { formatDateTime, type Distributor, type Lead } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { signRequestToken } from '../lib/actionToken';
import { logLeadEvent } from './leadServiceStore';

export interface MailTarget { assignmentId: string; distributor: Distributor }
export interface MailSummary { sent: string[]; failed: { name: string; error: string }[]; skipped: { name: string; why: string }[] }

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
const TOKEN_GRACE_MS = 3 * 86_400_000;

export function requestLink(appUrl: string, token: string, action?: 'accept' | 'reject'): string {
  return `${appUrl.replace(/\/+$/, '')}/lead-request/${token}${action ? `?do=${action}` : ''}`;
}

export function buildRequestMail(lead: Lead, distributorName: string, due: Date, acceptUrl: string, declineUrl: string): { subject: string; text: string; html: string } {
  const where = [lead.city, lead.pincode].filter(Boolean).join(' ');
  const size = lead.capacity_kw ? `${lead.capacity_kw} kW` : 'size not given';
  const heat = (lead.temperature ?? 'warm').toUpperCase();
  const product = lead.product_interest?.length ? lead.product_interest.join(', ') : 'not specified';
  const respondBy = formatDateTime(due.toISOString());
  const rows: [string, string][] = [
    ['Customer', lead.name], ['Place', where || '—'], ['Size', size], ['Customer type', (lead.customer_type ?? '—').replace(/_/g, ' ')], ['Interested in', product],
    ['Priority', heat], ['Please answer by', respondBy],
  ];
  const text = [
    `Hello ${distributorName},`, '', 'A new solar lead has been sent to you. The first distributor to accept gets it.', '',
    ...rows.map(([k, v]) => `${k}: ${v}`), '', `Accept: ${acceptUrl}`, `Decline: ${declineUrl}`, '', 'Future Solar',
  ].join('\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1d2415">
<h2 style="margin:0 0 4px;font-size:20px">New solar lead for you</h2>
<p style="margin:0 0 16px;color:#5d6652">Hello ${esc(distributorName)}, the first distributor to accept gets this lead.</p>
<table style="border-collapse:collapse;width:100%;font-size:14px">${rows.map(([k, v]) => `<tr><td style="padding:8px 10px;border-bottom:1px solid #e4e8da;color:#5d6652;width:38%">${esc(k)}</td><td style="padding:8px 10px;border-bottom:1px solid #e4e8da;font-weight:600">${esc(v)}</td></tr>`).join('')}</table>
<p style="margin:22px 0 8px"><a href="${esc(acceptUrl)}" style="background:#4d6a2a;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;display:inline-block;margin-right:8px">Review and accept</a>
<a href="${esc(declineUrl)}" style="background:#eef0e8;color:#1d2415;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;display:inline-block">Decline</a></p>
<p style="font-size:12px;color:#7b846f">Nothing is decided until you press the confirm button on the next page. Future Solar</p></div>`;
  return { subject: `New ${heat.toLowerCase()} solar lead · ${where || 'Gujarat'} · ${size} — please respond`, text, html };
}

/** Sends the request mail to every chosen distributor that has an address. A failed or skipped mail never stops the request itself; it is logged on the lead. */
export async function emailRequests(ctx: AppContext, lead: Lead, targets: MailTarget[], due: Date, appUrl: string | null): Promise<MailSummary> {
  const out: MailSummary = { sent: [], failed: [], skipped: [] };
  const base = appUrl || process.env['APP_URL'] || null;
  const expires = new Date(due.getTime() + TOKEN_GRACE_MS);
  await Promise.all(targets.map(async ({ assignmentId, distributor }) => {
    const name = distributor.legal_name;
    if (!distributor.email) { out.skipped.push({ name, why: 'no e-mail address on file' }); return; }
    if (!base) { out.skipped.push({ name, why: 'the web address for the link is not known (set APP_URL)' }); return; }
    const token = signRequestToken(ctx.org_id, assignmentId, expires);
    const mail = buildRequestMail(lead, name, due, requestLink(base, token, 'accept'), requestLink(base, token, 'reject'));
    const res = await ctx.providers.email.send({ to: distributor.email, subject: mail.subject, text: mail.text, html: mail.html });
    if (res.ok) out.sent.push(name); else out.failed.push({ name, error: res.error ?? 'the e-mail service refused it' });
  }));
  const parts = [
    out.sent.length ? `e-mailed ${out.sent.join(', ')}` : '', out.failed.length ? `could not e-mail ${out.failed.map((f) => `${f.name} (${f.error})`).join(', ')}` : '',
    out.skipped.length ? `not e-mailed: ${out.skipped.map((s) => `${s.name} (${s.why})`).join(', ')}` : '',
  ].filter(Boolean);
  await logLeadEvent(ctx, lead.id, 'request_email', `Request ${parts.join('; ')}`, { sent: out.sent.length, failed: out.failed.length, skipped: out.skipped.length });
  return out;
}
