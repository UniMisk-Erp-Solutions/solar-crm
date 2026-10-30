import { entityPath, type BlockedReasonRow, type ConsentDashboard, type Lead, type LeadConsent, type MessageLog } from '@solar/shared';
import { KpiBuilder, type Family, type KpiDetail } from './common';
import { inPeriod, type KpiScope } from './scope';
import { groupBy, ms, ratioPct } from './stats';

/** Human labels for the consent pipeline's block codes (see OutboundBlockCode in services/contracts.ts). */
export const BLOCK_REASON_LABEL: Record<string, string> = {
  NO_CONSENT: 'No consent on record', PURPOSE_NOT_CONSENTED: 'Purpose not consented', CHANNEL_NOT_CONSENTED: 'Channel not consented', WITHDRAWN: 'Consent withdrawn',
  SUPPRESSED_90_DAY: '90-day opt-out suppression', DND_REGISTERED: 'Number on DND register', DND_UNCHECKED: 'DND check missing', DND_STALE: 'DND check older than allowed',
  WHATSAPP_WINDOW_CLOSED: 'WhatsApp 24-hour window closed', NO_TEMPLATE: 'No approved template', NO_CONTACT: 'No contact detail',
};
const DND_CODES = new Set(['DND_REGISTERED', 'DND_UNCHECKED', 'DND_STALE']);

/** Extracts block codes from a message_log.block_reason; falls back to the (shortened) text when no known code is present. */
export function blockCodes(reason: string | null | undefined): string[] {
  const text = (reason ?? '').trim();
  if (!text) return ['UNSPECIFIED'];
  const found = new Set((text.match(/[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+/g) ?? []).filter((c) => c in BLOCK_REASON_LABEL));
  return found.size ? [...found] : [text.slice(0, 60)];
}

/** Does this lead have a valid consent before its first outbound message? (see KPI definition consent_coverage_pct) */
export function hasValidConsent(consents: LeadConsent[], firstOutboundMs: number | null): boolean {
  return consents.some((c) => {
    const granted = ms(c.granted_at);
    const withdrawn = ms(c.withdrawn_at);
    if (firstOutboundMs === null) return withdrawn === null;
    return granted !== null && granted <= firstOutboundMs && (withdrawn === null || withdrawn > firstOutboundMs);
  });
}

export async function computeConsent(scope: KpiScope): Promise<Family<Pick<ConsentDashboard, 'coverage' | 'blocked_reasons' | 'uncovered_leads'>>> {
  const { ctx, filters: f } = scope;
  const kb = await KpiBuilder.create(ctx, 'consent');
  const leadMap = await scope.leadMap();
  const cohort: Lead[] = (await scope.rows('leads', { created_at: { gte: f.fromIso, lte: f.toIso }, deleted_at: null })).filter((l) => l.status !== 'duplicate' && l.status !== 'merged');
  const cohortIds = new Set(cohort.map((l) => l.id));

  const sinceMinus = new Date(f.fromMs - 86_400_000).toISOString();
  const [consentsAll, messages] = await Promise.all([
    ctx.db.table('lead_consents').all({ created_at: { gte: sinceMinus } }),
    ctx.db.table('message_log').all({ created_at: { gte: f.fromIso } }),
  ]);
  const consentsBy = groupBy(consentsAll.filter((c) => cohortIds.has(c.lead_id)), (c) => c.lead_id);
  const firstOut = new Map<string, number>();
  for (const m of messages) {
    if (m.direction !== 'outbound' || !m.lead_id || !cohortIds.has(m.lead_id) || (m.status !== 'sent' && m.status !== 'queued')) continue;
    const t = ms(m.created_at);
    if (t !== null && t < (firstOut.get(m.lead_id) ?? Infinity)) firstOut.set(m.lead_id, t);
  }
  const covered = cohort.filter((l) => hasValidConsent(consentsBy.get(l.id) ?? [], firstOut.get(l.id) ?? null));
  const coveredIds = new Set(covered.map((l) => l.id));
  const uncovered = cohort.filter((l) => !coveredIds.has(l.id));

  // withdrawals in the period and live suppressions — consents of leads this user can see
  const withdrawnConsents = (await ctx.db.table('lead_consents').all({ withdrawn_at: { gte: f.fromIso, lte: f.toIso } })).filter((c) => leadMap.has(c.lead_id));
  const suppressed = (await ctx.db.table('lead_consents').all({ optout_suppress_until: { gt: f.now.toISOString() } })).filter((c) => leadMap.has(c.lead_id));
  const suppressedLeads = new Set(suppressed.map((c) => c.lead_id));
  const byChannel = groupBy(withdrawnConsents, (c) => c.withdrawal_channel ?? 'unspecified');

  // blocked messages in the period for visible leads
  const blockedMsgs: MessageLog[] = messages.filter((m) => m.status === 'blocked' && m.lead_id && leadMap.has(m.lead_id) && inPeriod(m.created_at, f));
  const reasonCount = new Map<string, number>();
  let dndBlocked = 0;
  for (const m of blockedMsgs) {
    const codes = blockCodes(m.block_reason);
    for (const c of codes) reasonCount.set(c, (reasonCount.get(c) ?? 0) + 1);
    if (codes.some((c) => DND_CODES.has(c))) dndBlocked++;
  }
  const blocked_reasons: BlockedReasonRow[] = [...reasonCount].sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, label: BLOCK_REASON_LABEL[code] ?? (code === 'UNSPECIFIED' ? 'No reason recorded' : code), count }));
  const dndLeads = [...leadMap.values()].filter((l) => l.dnd_status === 'registered' || l.dnd_status === 'blocked').length;
  const dndByCode = blocked_reasons.filter((r) => DND_CODES.has(r.code));

  const kpis = [
    kb.make('consent_coverage_pct', {
      value: ratioPct(covered.length, cohort.length),
      breakdown: [...groupBy(cohort, (l) => l.source)].map(([source, ls]) => ({ key: source, label: source.replace(/_/g, ' '), value: ratioPct(ls.filter((l) => coveredIds.has(l.id)).length, ls.length), numerator: ls.filter((l) => coveredIds.has(l.id)).length, denominator: ls.length })),
      secondary: { label: 'Leads without valid consent', value: uncovered.length, unit: 'count' },
      note: cohort.length === 0 ? 'No leads captured in the period' : undefined, links: [{ label: 'Leads', path: '/leads' }],
    }),
    kb.make('consent_withdrawn', { value: withdrawnConsents.length, breakdown: [...byChannel].map(([k, v]) => ({ key: k, label: k.replace(/_/g, ' '), value: v.length })) }),
    kb.make('consent_suppressed', { value: suppressedLeads.size, note: 'Promotional contact blocked for 90 days after opt-out' }),
    kb.make('dnd_blocked_messages', { value: dndBlocked, breakdown: dndByCode.map((r) => ({ key: r.code, label: r.label, value: r.count })), secondary: { label: 'Leads on DND register', value: dndLeads, unit: 'count' } }),
    kb.make('blocked_messages', { value: blockedMsgs.length, breakdown: blocked_reasons.map((r) => ({ key: r.code, label: r.label, value: r.count })) }),
  ];

  const nameOf = (id: string): string => leadMap.get(id)?.name ?? 'Lead';
  const details: Record<string, KpiDetail> = {
    consent_coverage_pct: {
      title: 'Leads captured in the period',
      columns: [{ key: 'lead', label: 'Lead', type: 'text' }, { key: 'source', label: 'Source', type: 'text' }, { key: 'created', label: 'Captured', type: 'datetime' }, { key: 'first_outbound', label: 'First outbound message', type: 'datetime' }, { key: 'consent', label: 'Valid consent', type: 'text' }],
      rows: cohort.map((l) => ({ lead: l.name, source: l.source, created: l.created_at, first_outbound: firstOut.has(l.id) ? new Date(firstOut.get(l.id)!).toISOString() : null, consent: coveredIds.has(l.id) ? 'Yes' : 'No' })),
    },
    consent_withdrawn: {
      title: 'Consents withdrawn', columns: [{ key: 'lead', label: 'Lead', type: 'text' }, { key: 'withdrawn', label: 'Withdrawn at', type: 'datetime' }, { key: 'channel', label: 'Channel', type: 'text' }, { key: 'suppress', label: 'Suppressed until', type: 'datetime' }],
      rows: withdrawnConsents.map((c) => ({ lead: nameOf(c.lead_id), withdrawn: c.withdrawn_at, channel: c.withdrawal_channel, suppress: c.optout_suppress_until })),
    },
    consent_suppressed: {
      title: 'Leads under opt-out suppression', columns: [{ key: 'lead', label: 'Lead', type: 'text' }, { key: 'suppress', label: 'Suppressed until', type: 'datetime' }],
      rows: suppressed.map((c) => ({ lead: nameOf(c.lead_id), suppress: c.optout_suppress_until })),
    },
  };
  const msgDetail: KpiDetail = {
    title: 'Blocked messages', columns: [{ key: 'at', label: 'When', type: 'datetime' }, { key: 'lead', label: 'Lead', type: 'text' }, { key: 'channel', label: 'Channel', type: 'text' }, { key: 'purpose', label: 'Purpose', type: 'text' }, { key: 'reason', label: 'Block reason', type: 'text' }],
    rows: blockedMsgs.map((m) => ({ at: m.created_at, lead: m.lead_id ? nameOf(m.lead_id) : null, channel: m.channel, purpose: m.purpose, reason: m.block_reason })),
  };
  details['blocked_messages'] = msgDetail;
  details['dnd_blocked_messages'] = { ...msgDetail, title: 'Messages blocked by DND', rows: blockedMsgs.filter((m) => blockCodes(m.block_reason).some((c) => DND_CODES.has(c))).map((m) => ({ at: m.created_at, lead: m.lead_id ? nameOf(m.lead_id) : null, channel: m.channel, purpose: m.purpose, reason: m.block_reason })) };

  return {
    kpis, details,
    extra: {
      coverage: { leads: cohort.length, covered: covered.length, uncovered: uncovered.length }, blocked_reasons,
      uncovered_leads: uncovered.slice(0, 50).map((l) => ({ lead_id: l.id, name: l.name, created_at: l.created_at, path: entityPath('lead', l.id) })),
    },
  };
}
