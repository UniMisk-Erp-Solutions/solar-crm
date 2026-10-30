import type { BrandUsp, Finding, Quotation, QuotationLine, QuoteDiscussion, Sku } from '@solar/shared';

export type QuoteLine = QuotationLine & { gross?: number; sku: (Pick<Sku, 'id' | 'category' | 'make' | 'model' | 'variant' | 'wattage'> & { brand_usp: BrandUsp | null }) | null };
export interface QuoteApproval { id: string; lane: string; step: number; required_role: string; decision: string; meta?: { round?: number } | null }

export interface QuoteDetail extends Omit<Quotation, 'compliance_findings'> {
  lines: QuoteLine[];
  findings: Finding[];
  approvals: QuoteApproval[];
  discussions: QuoteDiscussion[];
  versions: { id: string; version: number; status: string; total: number }[];
  followups: { id: string; day: number; status: string }[];
  customer: { legal_name?: string | null; display_name?: string | null } | null;
  opportunity: { id: string; name: string } | null;
  editable: boolean;
}

export const ROLE_SHORT: Record<string, string> = { dsm: 'DSM', regional_head: 'Regional Head', management: 'Management', sales_manager: 'Sales Manager' };

/** The approvers (commercial chain, latest round) the system asked for, in order. */
export function commercialApprovers(q: Pick<QuoteDetail, 'approvals'>): string[] {
  const rows = q.approvals.filter((a) => a.lane === 'commercial');
  const round = Math.max(1, ...rows.map((a) => a.meta?.round ?? 1));
  return rows.filter((a) => (a.meta?.round ?? 1) === round).sort((a, b) => a.step - b.step).map((a) => ROLE_SHORT[a.required_role] ?? a.required_role);
}

export const blockersOf = (q: Pick<QuoteDetail, 'findings'>) => q.findings.filter((f) => f.severity === 'hard_stop' && !f.overridden);
export const warningsOf = (q: Pick<QuoteDetail, 'findings'>) => q.findings.filter((f) => f.severity === 'warning' && !f.overridden);
