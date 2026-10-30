import { titleCase } from '@solar/shared';
import { Badge, type Tone } from '@/components/ui/badge';

type Entry = { label: string; tone: Tone };
const e = (label: string, tone: Tone): Entry => ({ label, tone });

/** One place that decides how every status in the product looks, so the UI stays consistent. */
const DICT: Record<string, Record<string, Entry>> = {
  lead_status: {
    new: e('New', 'info'), validated: e('Validated', 'info'), duplicate: e('Duplicate', 'warning'), merged: e('Merged', 'neutral'), unassigned: e('Needs assignment', 'danger'),
    assigned: e('Awaiting acceptance', 'warning'), accepted: e('Accepted', 'primary'), contacted: e('Contacted', 'primary'), qualified: e('Qualified', 'success'),
    site_visit: e('Site visit', 'primary'), nurture: e('Nurture', 'neutral'), opportunity: e('Opportunity', 'success'), lost: e('Lost', 'danger'), won: e('Won', 'success'),
  },
  temperature: { hot: e('Hot', 'danger'), warm: e('Warm', 'warning'), cold: e('Cold', 'info') },
  quote_status: {
    draft: e('Draft', 'neutral'), blocked: e('Blocked', 'danger'), price_review: e('Price review', 'info'), pending_approval: e('Pending approval', 'warning'), approved: e('Approved', 'success'),
    sent: e('Sent', 'primary'), negotiation: e('Negotiation', 'primary'), accepted: e('Accepted', 'success'), rejected: e('Rejected', 'danger'), revised: e('Revised', 'neutral'),
    requote_required: e('Re-quote required', 'warning'), expired: e('Expired', 'neutral'),
  },
  compliance_status: { pending: e('Not checked', 'neutral'), clear: e('Compliant', 'success'), warnings: e('Warnings', 'warning'), blocked: e('Blocked', 'danger') },
  approval_decision: { pending: e('Pending', 'warning'), approved: e('Approved', 'success'), rejected: e('Rejected', 'danger'), skipped: e('Skipped', 'neutral') },
  approval_lane: { commercial: e('Commercial', 'primary'), compliance: e('Compliance', 'accent'), credit: e('Credit', 'info') },
  pi_status: { draft: e('Draft', 'neutral'), pending_approval: e('Pending approval', 'warning'), issued: e('Issued', 'primary'), partially_paid: e('Part-paid', 'info'), paid: e('Paid', 'success'), cancelled: e('Cancelled', 'danger') },
  so_status: {
    draft: e('Draft', 'neutral'), on_hold: e('On hold', 'danger'), pending_approval: e('Pending approval', 'warning'), approved: e('Approved', 'success'), dispatch_planning: e('Dispatch planning', 'primary'),
    partially_dispatched: e('Part-dispatched', 'info'), dispatched: e('Dispatched', 'success'), closed: e('Closed', 'neutral'), cancelled: e('Cancelled', 'danger'),
  },
  dispatch_status: { planned: e('Planned', 'neutral'), blocked: e('Blocked', 'danger'), ready: e('Ready', 'info'), dispatched: e('Dispatched', 'success'), delivered: e('Delivered', 'success'), cancelled: e('Cancelled', 'danger') },
  opportunity_stage: { qualified: e('Qualified', 'info'), quotation: e('Quotation', 'primary'), negotiation: e('Negotiation', 'warning'), pi_stage: e('PI / order', 'accent'), won: e('Won', 'success'), lost: e('Lost', 'danger') },
  loan_status: { draft: e('Draft', 'neutral'), applied: e('Applied', 'info'), in_review: e('In review', 'warning'), approved: e('Approved', 'success'), rejected: e('Rejected', 'danger'), disbursed: e('Disbursed', 'success'), withdrawn: e('Withdrawn', 'neutral') },
  subsidy_status: { not_ready: e('Not ready', 'neutral'), ready: e('Ready to claim', 'info'), claimed: e('Claimed', 'primary'), released: e('Released', 'success'), rejected: e('Rejected', 'danger') },
  portal_status: { active: e('Active on portal', 'success'), deactivated: e('Deactivated', 'danger'), under_sop: e('Under SOP review', 'warning') },
  party_status: { onboarding: e('Onboarding', 'info'), active: e('Active', 'success'), on_hold: e('On hold', 'warning'), inactive: e('Inactive', 'neutral') },
  severity: { hard_stop: e('Hard stop', 'danger'), warning: e('Warning', 'warning'), info: e('Info', 'neutral') },
  confidence: { high: e('High confidence', 'success'), medium: e('Medium confidence', 'warning'), low: e('Low confidence', 'danger'), hypothesis: e('Hypothesis', 'neutral') },
  rule_status: { verified: e('Verified', 'success'), unverified: e('Unverified', 'warning'), conflicting: e('Conflicting', 'danger') },
  serial_status: { in_stock: e('In stock', 'success'), reserved: e('Reserved', 'info'), dispatched: e('Dispatched', 'primary'), installed: e('Installed', 'success'), rma: e('RMA', 'warning') },
  clock_status: { running: e('Running', 'info'), met: e('Met', 'success'), breached: e('Breached', 'danger'), cancelled: e('Cancelled', 'neutral') },
  warranty_status: { open: e('Open', 'warning'), inspected: e('Inspected', 'info'), sent_to_brand: e('With brand', 'primary'), replaced: e('Replaced', 'success'), rejected: e('Rejected', 'danger'), closed: e('Closed', 'neutral') },
  survey_status: { scheduled: e('Scheduled', 'info'), completed: e('Completed', 'success'), cancelled: e('Cancelled', 'neutral') },
  feasibility: { not_required: e('Not required', 'neutral'), pending: e('Pending', 'warning'), deemed: e('Deemed feasible', 'info'), approved: e('Approved', 'success'), rejected: e('Rejected', 'danger') },
  credit_result: { pending: e('Pending', 'warning'), approved: e('Credit approved', 'success'), rejected: e('Rejected', 'danger') },
  installation_status: { planned: e('Planned', 'neutral'), installed: e('Installed', 'info'), certified: e('Certificate filed', 'primary'), commissioned: e('Commissioned', 'success') },
  followup_status: { open: e('Open', 'info'), done: e('Done', 'success'), missed: e('Missed', 'danger'), cancelled: e('Cancelled', 'neutral') },
  assignment_status: { pending: e('Pending', 'warning'), accepted: e('Accepted', 'success'), rejected: e('Rejected', 'danger'), expired: e('Expired', 'neutral'), reassigned: e('Reassigned', 'neutral') },
  payment_status: { received: e('Received', 'success'), pending: e('Pending', 'warning'), bounced: e('Bounced', 'danger') },
  job_status: { running: e('Running', 'info'), ok: e('OK', 'success'), failed: e('Failed', 'danger') },
  open_closed: { open: e('Open', 'warning'), closed: e('Closed', 'success') },
};

export type StatusKind = keyof typeof DICT;

export function statusMeta(kind: string, value: string | null | undefined): Entry {
  if (!value) return e('—', 'neutral');
  return DICT[kind]?.[value] ?? e(titleCase(value), 'neutral');
}

export function StatusBadge({ kind, value, className }: { kind: StatusKind | (string & {}); value: string | null | undefined; className?: string }) {
  const m = statusMeta(kind, value);
  return <Badge tone={m.tone} className={className} dot>{m.label}</Badge>;
}

export function TemperatureBadge({ value }: { value: string | null | undefined }) {
  return value ? <StatusBadge kind="temperature" value={value} /> : <Badge>Not set</Badge>;
}

export function ConfidenceBadge({ confidence, status }: { confidence?: string | null; status?: string | null }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {confidence && <StatusBadge kind="confidence" value={confidence} />}
      {status && status !== 'verified' && <StatusBadge kind="rule_status" value={status} />}
    </span>
  );
}
