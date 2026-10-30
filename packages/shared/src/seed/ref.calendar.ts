import type { RuleConfidence } from '../enums';
import type { ComplianceCalendarItem } from '../rows';
import { baseOf, refId, type SeedEnv } from './util';

interface CalendarSeed {
  due_date: string;
  title: string;
  description: string;
  category: string;
  confidence: RuleConfidence;
  source_ref: string;
  escalate_days: number[];
  rule_key: string | null;
}

/** prompt.md Section 6.4. Countdown escalation at D-14, D-7, D-3 applies to the first three items. */
export const CALENDAR_ITEMS: readonly CalendarSeed[] = [
  {
    due_date: '2026-11-13', title: 'DPDP Consent Manager registration', category: 'dpdp', confidence: 'high', escalate_days: [14, 7, 3],
    description: 'Consent Manager registration under the DPDP Rules 2025 (Rule 4) starts. High on date, medium on clause detail; some sources count a day later.',
    source_ref: 'India solar distributor CRM blueprint.md §3.4, §6 [S44][S45]', rule_key: 'dpdp.consent_manager_registration_date',
  },
  {
    due_date: '2026-11-30', title: 'CFA claim deadline — legacy cohort', category: 'pmsg', confidence: 'medium', escalate_days: [14, 7, 3],
    description: 'PM Surya Ghar CFA claims for the Phase II legacy cohort must be received by this date (31-Aug-2026 OM). Medium confidence — the OM text was not read (V-1).',
    source_ref: 'India solar distributor CRM blueprint.md §3.1, §6 [S3]', rule_key: 'pmsg.claim_deadline.legacy_cohort',
  },
  {
    due_date: '2026-12-31', title: 'ALMM List-II exemption ends (commissioning)', category: 'almm', confidence: 'high', escalate_days: [14, 7, 3],
    description: 'Net-metering and open-access projects commissioned after this date need List-I modules and List-II cells (18-Jul-2026 OM; no blanket extension). High on date and scope.',
    source_ref: 'India solar distributor CRM blueprint.md §3.2, §6 [S15][S16]', rule_key: 'almm.list2.exemption_net_metering_open_access_until',
  },
  {
    due_date: '2026-12-31', title: 'BIS self-certification for inverters above 200 kW ends unless extended', category: 'bis', confidence: 'medium', escalate_days: [],
    description: 'Self-certification for inverters above 200 kW was extended to this date (S.O. 3706(E)). Report confidence: medium-high.',
    source_ref: 'India solar distributor CRM blueprint.md §3.2, §6 [S23][S74]', rule_key: 'bis.inverter_self_cert_until',
  },
  {
    due_date: '2026-12-31', title: 'WhatsApp India INR billing migration deadline', category: 'whatsapp', confidence: 'high', escalate_days: [],
    description: 'Meta moves India WhatsApp Business billing to INR; migration must be complete by this date.',
    source_ref: 'India solar distributor CRM blueprint.md §3.4, §6 [S53]', rule_key: null,
  },
  {
    due_date: '2027-03-31', title: 'PMSG programme end and KUSUM Components A and C commissioning', category: 'pmsg', confidence: 'medium', escalate_days: [],
    description: 'PM Surya Ghar programme end per press; PM-KUSUM Components A and C commissioning for sanctions up to 31-Dec-2025. No extension found.',
    source_ref: 'India solar distributor CRM blueprint.md §3.1, §6 [S13][S65]', rule_key: 'pmsg.programme_end',
  },
  {
    due_date: '2027-05-13', title: 'DPDP core duties', category: 'dpdp', confidence: 'high', escalate_days: [],
    description: 'Notice and consent, safeguards, breach, erasure, rights and penalties apply. A compression to 12 months was proposed but not notified as of 08-Oct-2026.',
    source_ref: 'India solar distributor CRM blueprint.md §3.4, §6 [S43][S44][S45]', rule_key: 'dpdp.core_duties_date',
  },
  {
    due_date: '2028-06-01', title: 'ALMM List-III (ingots and wafers)', category: 'almm', confidence: 'medium', escalate_days: [],
    description: 'ALMM extends to ingots and wafers; the first list only follows once at least 3 independent units with 15 GW combined exist. Report confidence: medium-high.',
    source_ref: 'India solar distributor CRM blueprint.md §3.2, §6 [S19]', rule_key: 'almm.list3.effective_date',
  },
];

export function buildCalendar(env: SeedEnv): ComplianceCalendarItem[] {
  return CALENDAR_ITEMS.map((c, i) => ({
    ...baseOf(env, refId('calendar', i + 1), 30 * 1440),
    due_date: c.due_date, title: c.title, description: c.description, category: c.category, confidence: c.confidence,
    source_ref: c.source_ref, escalate_days: [...c.escalate_days], rule_key: c.rule_key, active: true,
  }));
}
