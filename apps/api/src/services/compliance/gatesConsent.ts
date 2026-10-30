/** Privacy gates: G1 (consent / DND / 90-day opt-out suppression for the quote's lead) and G14 (Aadhaar numbers and documents). */
import { detectAadhaar, looksLikeAadhaarFilename, type ConsentChannel, type Finding } from '@solar/shared';
import type { OutboundBlockCode, OutboundCheck } from '../contracts';
import { DESIGN_RULE, decide, finding, info } from './ruleBook';
import type { GateFn } from './types';

/** reasons that mean "we may not contact this person about the quote" (hard) as opposed to "the DND scrub needs refreshing" (soft). */
const SOFT_CODES: ReadonlySet<OutboundBlockCode> = new Set(['DND_STALE', 'DND_UNCHECKED', 'WHATSAPP_WINDOW_CLOSED', 'NO_TEMPLATE']);
const QUOTE_CHANNELS: ConsentChannel[] = ['email', 'whatsapp'];

/* ───────────── G1 ───────────── */
export const g1: GateFn = async ({ ctx, rules, input }) => {
  if (input.mode === 'dispatch') return [];
  if (!input.leadId) return [info('G1', 'No lead is linked to this quote, so consent was not checked.')];
  const switchRule = await rules.get('trai.optout_reconsent_block_days', input.today);
  const gov = switchRule ?? DESIGN_RULE;
  const checks: { channel: ConsentChannel; check: OutboundCheck }[] = [];
  for (const channel of QUOTE_CHANNELS) {
    checks.push({ channel, check: await ctx.svc.consent.checkOutbound(input.leadId, { channel, purpose: 'service' }) });
  }
  const allowed = checks.filter((c) => c.check.allowed);
  const reasons = checks.flatMap((c) => c.check.reasons.map((r) => ({ ...r, channel: c.channel })));
  const unique = [...new Map(reasons.map((r) => [`${r.code}`, r])).values()];
  const text = unique.map((r) => r.message).join(' ');

  if (!allowed.length) {
    const hard = unique.some((r) => !SOFT_CODES.has(r.code));
    return [finding('G1', [switchRule], decide([gov], hard ? 'hard_stop' : 'warning'),
      `The customer cannot be contacted about this quotation: ${text || 'no consent record covers quotation / service messages.'} Capture consent (or wait for the suppression period to end) before sending.`, ['lead_id'])];
  }
  const dnd = unique.filter((r) => r.code === 'DND_STALE' || r.code === 'DND_UNCHECKED');
  if (dnd.length) {
    return [finding('G1', [switchRule], decide([gov], 'warning'),
      `Consent is in place for ${allowed.map((a) => a.channel).join(' / ')}, but the DND scrub is ${dnd.some((r) => r.code === 'DND_UNCHECKED') ? 'missing' : 'stale'}. Re-run the DND check.`, ['lead_id'])];
  }
  return [];
};

/* ───────────── G14 ───────────── */
export const g14: GateFn = async ({ rules, input }) => {
  const switchRule = await rules.get('compliance.aadhaar_block', input.today);
  const d = decide([switchRule ?? DESIGN_RULE], 'hard_stop');
  const out: Finding[] = [];
  const textFields: string[] = [];
  for (const t of input.texts) if (detectAadhaar(t.text).length) textFields.push(t.field);
  if (textFields.length) {
    out.push(finding('G14', [switchRule], d,
      `An Aadhaar number was found in ${[...new Set(textFields)].join(', ')}. Aadhaar numbers must never be stored — remove it (the last four digits may be entered separately).`, [...new Set(textFields)]));
  }
  const fileFields = input.fileNames.filter((f) => looksLikeAadhaarFilename(f.name));
  if (fileFields.length) {
    out.push(finding('G14', [switchRule], d,
      `The attached file name looks like an Aadhaar document (${fileFields.map((f) => f.name).join(', ')}). Aadhaar numbers and images must not be stored — remove the file.`, fileFields.map((f) => f.field)));
  }
  return out;
};
