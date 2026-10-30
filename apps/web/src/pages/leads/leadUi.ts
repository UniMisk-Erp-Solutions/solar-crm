import { CUSTOMER_TYPES, TIMELINE_BUCKETS, titleCase, type LeadListItem } from '@solar/shared';

/** The five sources the PDF names, mapped onto the API's source values. */
export const SOURCE_CHOICES: { value: string; label: string }[] = [
  { value: 'website', label: 'Website' },
  { value: 'call_centre', label: 'Call' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'campaign', label: 'Campaign' },
  { value: 'referral', label: 'Referral' },
];
const SOURCE_LABEL: Record<string, string> = { ...Object.fromEntries(SOURCE_CHOICES.map((s) => [s.value, s.label])), dealer_upload: 'Dealer', manual: 'Call' };
export const sourceLabel = (s: string | null | undefined): string => (s ? SOURCE_LABEL[s] ?? titleCase(s) : '—');

export const CUSTOMER_TYPE_LABEL: Record<(typeof CUSTOMER_TYPES)[number], string> = {
  residential: 'Home', housing_society: 'Housing society', commercial: 'Commercial', industrial: 'Industrial', farmer: 'Farmer', government: 'Government',
};
export const TIMELINE_LABEL: Record<(typeof TIMELINE_BUCKETS)[number], string> = {
  immediate: 'As soon as possible', within_30_days: 'Within 30 days', one_to_three_months: '1 to 3 months', three_to_six_months: '3 to 6 months', six_months_plus: 'More than 6 months', unknown: 'Not sure yet',
};
export const DECISION_LABEL: Record<string, string> = { self: 'The customer decides', family: 'Family decides', committee: 'A committee decides', unknown: 'Not known' };
export const TEMPERATURE_MEANING: Record<string, string> = { cold: 'COLD — long-term', warm: 'WARM — 1 to 3 months', hot: 'HOT — 0 to 30 days' };

/**
 * Stage 1 of the flow chart as five views of the Inquiries list.
 *  6 = escalated to the DSM (no eligible distributor) · 7 = assigned, waiting for the distributor · loop = the SLA passed (Reminder 1 → DSM alert → auto-reassignment) · accepted = lead accepted.
 */
export const INQUIRY_PILLS: { value: string; label: string; status?: string; sla_state?: string }[] = [
  { value: 'all', label: 'All inquiries' },
  { value: 'escalated', label: 'Escalated to DSM', status: 'new,validated,unassigned,duplicate' },
  { value: 'awaiting', label: 'Awaiting acceptance', status: 'assigned' },
  { value: 'loop', label: 'Reminder and escalation loop', status: 'assigned', sla_state: 'breached' },
  { value: 'accepted', label: 'Lead accepted', status: 'accepted,contacted,qualified,site_visit,nurture,opportunity,won' },
  { value: 'closed', label: 'Lost or merged', status: 'lost,merged' },
];

/** Product interest is matched against what each distributor can supply, so the choices are the capability tags the distributors carry. */
export const PRODUCT_CHOICES: { value: string; label: string }[] = [
  { value: 'rooftop', label: 'Rooftop solar' },
  { value: 'pmsg', label: 'PM Surya Ghar (subsidy)' },
  { value: 'rwa', label: 'Housing society' },
  { value: 'commercial', label: 'Commercial' },
  { value: 'industrial', label: 'Industrial' },
  { value: 'net_metering', label: 'Net metering' },
  { value: 'open_access', label: 'Open access' },
  { value: 'captive', label: 'Captive (behind the meter)' },
  { value: 'kusum', label: 'Farmer pump (PM-KUSUM)' },
  { value: 'government', label: 'Government / tender' },
];
/** A sensible starting selection once the customer type is known (the user can change it). */
export const DEFAULT_PRODUCTS: Record<string, string[]> = {
  residential: ['rooftop'], housing_society: ['rwa'], commercial: ['commercial'], industrial: ['industrial'], farmer: ['kusum'], government: ['government'],
};

/** Where an inquiry is on the Stage 1 chart, in the chart's own words. */
export function stageOf(l: Pick<LeadListItem, 'status' | 'sla_state'>): { step: string; label: string; tone: 'danger' | 'warning' | 'primary' | 'success' | 'neutral' } {
  if (l.status === 'duplicate') return { step: '2', label: 'Duplicate — to review', tone: 'warning' };
  if (l.status === 'validated') return { step: '4', label: 'Choose distributors', tone: 'warning' };
  if (l.status === 'new' || l.status === 'unassigned') return { step: '6', label: 'Escalated to DSM', tone: 'danger' };
  if (l.status === 'assigned') return l.sla_state === 'breached' ? { step: '7', label: 'Reminder and escalation loop', tone: 'danger' } : { step: '7', label: 'Awaiting acceptance', tone: 'primary' };
  if (l.status === 'merged' || l.status === 'lost') return { step: '', label: l.status === 'lost' ? 'Lost' : 'Merged', tone: 'neutral' };
  return { step: '', label: 'Lead accepted', tone: 'success' };
}

/** The latest acceptance step in a lead's events (newest first), for the detail header. */
export function acceptanceFromEvents(events: { event_type: string }[]): { text: string; tone: 'warning' | 'danger' | 'info' } | null {
  for (const e of events) {
    if (e.event_type === 'auto_reassigned') return { text: 'Reassigned', tone: 'info' };
    if (e.event_type === 'acceptance_breached' || e.event_type === 'acceptance_expired') return { text: 'DSM alerted', tone: 'danger' };
    if (e.event_type === 'acceptance_reminder') return { text: 'Reminder sent', tone: 'warning' };
    if (e.event_type === 'accepted' || e.event_type === 'assigned') return null;
  }
  return null;
}

export const toIso = (localValue: string): string | undefined => {
  if (!localValue) return undefined;
  const d = new Date(localValue);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};
export const toLocalInput = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** One short phrase for the acceptance clocks, from what the list endpoint returns. */
export function acceptanceNote(l: Pick<LeadListItem, 'status' | 'sla_state'>): { text: string; tone: 'warning' | 'danger' } | null {
  if (l.status !== 'assigned') return null;
  if (l.sla_state === 'breached') return { text: 'Reminder sent · DSM alerted', tone: 'danger' };
  if (l.sla_state === 'due_soon') return { text: 'Reminder 1 due', tone: 'warning' };
  return null;
}
