import type { LeadListItem } from '@solar/shared';
import { DistributorPicker } from './DistributorPicker';

/** Choose whom to ask for this lead: ranked suggestions, one or several distributors (POST /leads/:id/requests). */
export function AssignControl({ leadId, onDone }: { leadId: string; onDone?: (lead: LeadListItem) => void }) {
  return <DistributorPicker leadId={leadId} onSent={() => onDone?.({ id: leadId } as LeadListItem)} />;
}
