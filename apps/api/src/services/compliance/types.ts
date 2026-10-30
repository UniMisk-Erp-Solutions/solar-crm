import type { ComplianceStatus, Finding, Gate, Segment, Severity, Site, Sku, SkuCompliance, SerialSnapshot } from '@solar/shared';
import type { AppContext } from '../../auth/context';
import type { RuleBook } from './ruleBook';

/** One product line as the gates see it (a quote line, a preview SKU, or a dispatch serial's SKU). */
export interface EvalLine {
  /** quotation_lines.id when the line exists, otherwise the sku id */
  key: string;
  sku: Sku | null;
  compliance: SkuCompliance | null;
  description: string;
  hsn: string | null;
  gst_rate: number | null;
  tax_position_approved: boolean;
  /** true when the line was priced by a human CA decision rather than a rule */
  tax_position_by_human: boolean;
  /** valid_to of the sku_prices snapshot the line was priced from (null = open ended / no snapshot) */
  price_valid_to: string | null;
}

export interface EvalSerial {
  id: string;
  serial: string;
  sku: Sku | null;
  /** the SKU's CURRENT register entry (used for thin-film exemption and the snapshot-freshness check) */
  compliance: SkuCompliance | null;
  snapshot: SerialSnapshot;
}

export type EvalMode = 'quote' | 'preview' | 'dispatch';

/** Everything the gates need — assembled by compliance/inputs.ts so the gate code never touches the database for the entity itself. */
export interface EvalInput {
  mode: EvalMode;
  segment: Segment;
  kw: number;
  /** IST date of ctx.now() */
  today: string;
  /** date pricing / GST rules are resolved on */
  quoteDate: string;
  /** date compliance rules are resolved on: expected commissioning date, or today when unknown */
  refDate: string;
  commissioningDate: string | null;
  validityDate: string | null;
  priceSnapshotAt: string | null;
  exemptionReliance: boolean;
  lines: EvalLine[];
  serials: EvalSerial[];
  leadId: string | null;
  site: Site | null;
  dealerId: string | null;
  orderValue: number;
  texts: { field: string; text: string | null | undefined }[];
  fileNames: { field: string; name: string }[];
  /** rule ids resolved while building the entity (e.g. CFA rules) that the evaluation should also record as dependencies */
  extraRuleIds: string[];
}

export interface GateEnv { ctx: AppContext; rules: RuleBook; input: EvalInput }
export type GateFn = (env: GateEnv) => Promise<Finding[]>;

export interface OverrideGrant {
  approvalId: string;
  gates: Gate[];
  reason: string;
  decidedBy: string | null;
  decidedAt: string | null;
  /** quotes only: SKU signature at request time; an override stops applying when the lines change */
  lineSignature: string | null;
}

export interface GateSummary {
  gate: Gate;
  title: string;
  applicability: 'applies' | 'not_applies' | 'warning';
  /** pass: nothing found · warn: warning (or overridden) · fail: un-overridden hard stop · skipped: not applicable / not evaluated */
  status: 'pass' | 'warn' | 'fail' | 'skipped';
  severity: Severity | null;
  messages: string[];
}

export interface FullEvaluation {
  findings: Finding[];
  hasHardStop: boolean;
  status: ComplianceStatus;
  ruleIdsUsed: string[];
  evaluated_at: string;
  gates: GateSummary[];
  overridesApplied: { approvalId: string; gates: Gate[]; reason: string }[];
  /** grants that exist but no longer apply (lines changed) */
  overridesStale: string[];
}

export const GATE_TITLE: Record<Gate, string> = {
  G1: 'Consent, DND and opt-out suppression',
  G2: 'DCR-verified modules (subsidy schemes)',
  G3: 'ALMM List-I (module model)',
  G4: 'ALMM List-II (cells)',
  G5: 'List-II exemption date',
  G6: 'BIS licence and licensed model',
  G7: 'Inverter self-certification (above threshold kW)',
  G8: 'Quote validity vs price / duty horizon',
  G9: 'HSN, GST rate and tax position',
  G10: 'ALMM snapshot freshness',
  G11: 'Dealer credit limit and portal status',
  G12: 'Name on DISCOM bill / pending dues',
  G13: 'PMSG system size above CFA limit',
  G14: 'Aadhaar number or document',
};
