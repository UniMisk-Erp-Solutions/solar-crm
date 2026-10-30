import { daysBetween, istDateString, normalizeMobile } from '@solar/shared';
import type { AppContext } from '../auth/context';

export interface DataQualityCheck {
  key: string; label: string; count: number; severity: 'ok' | 'warning'; sample_ids: string[];
}
export interface DataQualityResult { checks: DataQualityCheck[]; total_issues: number; notified: number }

const ACTIVE_LEAD_STATUSES = ['assigned', 'accepted', 'contacted', 'qualified', 'site_visit'];

/**
 * Nightly scan for records that quietly break the workflow. It only reads and reports — nothing is changed.
 * Findings with a non-zero count raise one notification (while unread) for admin, management and compliance.
 */
export async function runDataQualityScan(ctx: AppContext): Promise<DataQualityResult> {
  const sample = Math.max(1, (await ctx.svc.rules.value<number>('data_quality.sample_size', undefined, 20)) ?? 20);
  const now = ctx.now();
  const today = istDateString(now);
  const checks: DataQualityCheck[] = [];
  const add = (key: string, label: string, ids: string[]) => checks.push({ key, label, count: ids.length, severity: ids.length ? 'warning' : 'ok', sample_ids: ids.slice(0, sample) });

  const leads = await ctx.db.table('leads').all({ anonymised_at: null });

  add('active_leads_missing_mandatory_fields', 'Active leads missing owner, next action or next follow-up date',
    leads.filter((l) => ACTIVE_LEAD_STATUSES.includes(l.status) && (!l.owner_id || !l.next_action?.trim() || !l.next_followup_at)).map((l) => l.id));

  add('qualified_leads_without_segment', 'Qualified leads with no segment (a quote cannot be started)',
    leads.filter((l) => ['qualified', 'site_visit', 'opportunity'].includes(l.status) && !l.segment).map((l) => l.id));

  const byMobile = new Map<string, string[]>();
  for (const l of leads) {
    if (['duplicate', 'merged', 'lost'].includes(l.status)) continue;
    const m = normalizeMobile(l.mobile);
    if (m) byMobile.set(m, [...(byMobile.get(m) ?? []), l.id]);
  }
  add('duplicate_mobiles', 'Open leads sharing the same mobile number (not marked duplicate or merged)', [...byMobile.values()].filter((ids) => ids.length > 1).flat());

  const quotes = await ctx.db.table('quotations').all({ status: ['sent', 'negotiation'] });
  add('sent_quotes_past_validity', 'Sent quotes whose validity date has passed but are not marked expired', quotes.filter((q) => q.validity_date < today).map((q) => q.id));

  const stalled = await ctx.db.table('clocks').all({ status: 'running', resolved_at: null, due_at: { lt: new Date(now.getTime() - 24 * 3_600_000).toISOString() } });
  add('stalled_clocks', 'Running clocks more than a day past due (is the clock tick running?)', stalled.map((c) => c.id));

  const staleDnd = leads.filter((l) => l.dnd_status !== 'unchecked' && l.dnd_checked_at && daysBetween(l.dnd_checked_at, now) > 365).map((l) => l.id);
  add('very_old_dnd_scrubs', 'Leads whose DND scrub is more than a year old', staleDnd);

  const total = checks.reduce((n, c) => n + c.count, 0);
  let notified = 0;
  if (total > 0) {
    notified = await ctx.svc.notify.notify({
      roles: ['admin', 'management', 'compliance_officer'], kind: 'dataquality.daily', severity: 'warning', entity_type: 'data_quality', entity_id: ctx.org_id, link: '/admin/data-quality',
      title: `Data quality: ${total} record${total === 1 ? '' : 's'} need attention`,
      body: checks.filter((c) => c.count).map((c) => `${c.count} — ${c.label}`).join('; '),
    });
  }
  return { checks, total_issues: total, notified };
}

