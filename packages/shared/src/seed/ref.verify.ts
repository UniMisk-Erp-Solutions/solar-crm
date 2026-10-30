import type { RuleConfidence } from '../enums';
import type { VerifyRegisterItem } from '../rows';
import { baseOf, refId, type SeedEnv } from './util';

/**
 * The "Verify before relying" register — prompt.md Section 15, numbered V-1 … V-25 exactly as in
 * "India solar distributor CRM blueprint.md" §10a, plus V-26 (GERC regulation-version labels) which the seed itself introduces.
 * docs/VERIFY_BEFORE_RELYING.md is generated from this list by scripts/generate-seed-sql.ts so the two never drift.
 */
export interface VerifySeed {
  code: string;
  title: string;
  detail: string;
  where_to_check: string;
  confidence: RuleConfidence;
  owner: string;
}

const COMPLIANCE = 'Compliance officer';
const CA = 'CA / Accounts';
const SALES_OPS = 'Sales operations';

export const VERIFY_ITEMS: readonly VerifySeed[] = [
  { code: 'V-1', title: 'PMSG CFA claim deadline 30-Nov-2026 and Phase II scope', detail: 'The MNRE OM text was not read; the deadline and the legacy-cohort scope come from trade press only [S3].', where_to_check: 'MNRE OM dated 31-Aug-2026 (text, file number, stage definitions) — MNRE / pmsuryaghar.gov.in', confidence: 'medium', owner: COMPLIANCE },
  { code: 'V-2', title: 'ADD on Chinese cells/modules — DGTR recommended; Finance Ministry notification unconfirmed', detail: 'DGTR final findings (30-Sep-2025) recommended the duty, but a Mercom headline says it was imposed while InfoLink says the notification is unconfirmed [S27][S28].', where_to_check: 'CBIC customs (ADD) notifications, Oct-2025 to Jan-2026 — CBIC / Finance Ministry', confidence: 'low', owner: CA },
  { code: 'V-3', title: 'ALMM 18-Jul-2026 OM and 04-Aug-2026 clarification; OM numbers not supported', detail: 'OM numbers and the "tenth List-II revision 28-Sep-2026" come from a vendor blog and are unsupported [S17].', where_to_check: 'OM text and numbers — MNRE ALMM page', confidence: 'medium', owner: COMPLIANCE },
  { code: 'V-4', title: 'List-II bid-date carve-out: 09-Dec-2024 vs 31-Aug-2025 — conflicting', detail: 'AZB & Partners flags the inconsistency [S14]; the applicable grandfathering date cannot be determined.', where_to_check: '09-Dec-2024 OM and 23-Sep-2025 FAQ — MNRE', confidence: 'low', owner: COMPLIANCE },
  { code: 'V-5', title: 'BIS module standard: IS 14286 vs IS 14086; full QCO list under S.O. 492(E) — conflicting', detail: 'Sources disagree on the standard number [S24]; the full list of products under the 2025 Order is not captured.', where_to_check: 'Standard number and the 2025 Order schedule — BIS / MNRE gazette S.O. 492(E)', confidence: 'low', owner: COMPLIANCE },
  { code: 'V-6', title: 'DCR: a vendor guide says PMSG needs no DCR, contradicted by MNRE guideline text and press — check current clause', detail: 'A vendor guide [S25] contradicts the guideline text (cl. 5(m)) [S1] and press [S18]. Gate G2 follows the guideline.', where_to_check: 'Current PMSG DCR clause and the KUSUM DCR clause — MNRE guidelines', confidence: 'medium', owner: COMPLIANCE },
  { code: 'V-7', title: 'PM-KUSUM sales after 30-Sep-2026 — extension unknown', detail: 'Whether farmer-pump sales remain open after the 30-Sep-2026 commissioning deadline is not verified [S13].', where_to_check: 'MNRE KUSUM OMs — MNRE', confidence: 'low', owner: COMPLIANCE },
  { code: 'V-8', title: 'Gujarat state subsidy figures — summary-only, internally inconsistent, no GR found', detail: 'Only a news summary exists; the worked example is internally inconsistent and no scheme name, procedure or deadline was found [S10]. The state share stays zero.', where_to_check: 'GR, scheme name, procedure and deadline — GEDA / Gujarat Energy Department', confidence: 'low', owner: COMPLIANCE },
  { code: 'V-9', title: 'Whether a distributor or unregistered installer may work under a registered vendor in PMSG — no clause found', detail: 'No sub-contracting clause was found in the guideline text available.', where_to_check: 'Guideline annexures and the vendor manual — MNRE / REC', confidence: 'low', owner: COMPLIANCE },
  { code: 'V-10', title: 'Surya Roshni v. PGVCL outcome; banking-charge rule by regulation version', detail: 'The GERC order outcome was not seen [S39]; which regulation version governs banking charges is unresolved.', where_to_check: 'GERC order in Surya Roshni v. PGVCL — GERC', confidence: 'low', owner: COMPLIANCE },
  { code: 'V-11', title: 'Gujarat net-metering specifics (₹2.25/unit, ₹500/day, GEDA role, Solar Policy end) — vendor blog', detail: 'Details come from a vendor blog only [S11] and are not encoded as active rules.', where_to_check: 'GERC regulations and amendments — GERC gazette; GEDA', confidence: 'low', owner: COMPLIANCE },
  { code: 'V-12', title: 'Gujarat open-access surcharge and banking charge after Mar-2026; wheeling charges', detail: 'Values after 31-Mar-2026 were not found [S40][S41]; the ₹1.00/kWh surcharge period has expired.', where_to_check: 'GERC orders — GERC', confidence: 'low', owner: COMPLIANCE },
  { code: 'V-13', title: 'Gross metering above 10 kW — headline only', detail: 'Only a 2020 headline was seen; the rule text was not opened.', where_to_check: 'Ministry of Power rule text — MoP gazette', confidence: 'low', owner: COMPLIANCE },
  { code: 'V-14', title: 'TCS/TDS (194Q, 206C(1H)), e-way bill, s.17(5) ITC blocks, GST on inverters/structures/batteries, 70:30 split — not researched or low', detail: 'Not researched, or sourced from low-confidence material [S31][S32]. Placeholders only.', where_to_check: 'Notifications and CA review — CBIC; Income-tax Department', confidence: 'low', owner: CA },
  { code: 'V-15', title: 'Module warranty and performance-cover mandate — headline only', detail: 'Only a headline ("10-year warranty, 25-year performance cover") was seen; article and date were not retrieved [S77].', where_to_check: 'MNRE order — MNRE', confidence: 'low', owner: COMPLIANCE },
  { code: 'V-16', title: 'All vendor-sourced CRM feature and pricing claims', detail: 'Competitor features and prices come from vendor marketing pages [S70–S73] and are unverified.', where_to_check: 'Product demos and official price lists — the vendors', confidence: 'low', owner: SALES_OPS },
  { code: 'V-17', title: 'TRAI: 140/160/1600 series, header suffix (-P vs -F), Third Amendment status, IndiaMART case', detail: 'Sources conflict on the series and header suffix; the draft Third Amendment 2026 has no final text; the IndiaMART challenge outcome is unknown [S47][S48][S49][S52]. Both are configurable, not hard-coded.', where_to_check: 'Gazette and DoT number allotment — TRAI / DoT', confidence: 'low', owner: COMPLIANCE },
  { code: 'V-18', title: 'DPDP: exact commencement date count; compression to 12 months; s.7 deemed consent; grievance timelines; exemptions', detail: 'Based on law-firm commentary [S43][S45]; some sources count the dates a day later; deemed consent, grievance timelines and exemptions are not verified.', where_to_check: 'DPDP Rules gazette and any amendment — MeitY / e-gazette', confidence: 'medium', owner: COMPLIANCE },
  { code: 'V-19', title: 'PMSG loan rate: 7% vs 5.75%', detail: 'A Feb-2025 document says about 7 %; a ministry statement of 4-Aug-2026 says 5.75 % [S8][S66]. No rate is printed on quotes.', where_to_check: 'Current Jan Samarth / bank terms — DFS / lending banks', confidence: 'low', owner: SALES_OPS },
  { code: 'V-20', title: 'Installation count figures conflict (2.36M / 4M / ~4.5M / 50.06 lakh)', detail: 'Definitions differ between sources [S9][S65–S67]; none is used as a market-size number.', where_to_check: 'Parliament replies and the ministry dashboard — PIB / pmsuryaghar.gov.in', confidence: 'low', owner: SALES_OPS },
  { code: 'V-21', title: 'Inverter GST 5% vs 18%; Karnataka HC ruling (W.P. 9686/2025)', detail: 'The ruling is reported by a secondary source and the wider rate position is low confidence [S31]. Every inverter line needs a CA tax-position approval (gate G9).', where_to_check: 'Judgment in W.P. 9686/2025 and any CBIC clarification — Karnataka HC; CBIC', confidence: 'low', owner: CA },
  { code: 'V-22', title: 'Vendor-enforcement claims (66 deactivations, 60-day rule, Vendor-Consumer Agreement from 23-Sep-2026, 15-day defect rule) — blog with internal errors', detail: 'Sourced from a vendor blog with internal errors [S64][S42]; only the MNRE SOP of 22-Jun-2026 is treated as reliable.', where_to_check: 'MNRE SOP and portal notices — MNRE', confidence: 'low', owner: COMPLIANCE },
  { code: 'V-23', title: 'Accelerated depreciation 40% under s.34 Income-tax Act 2025 — secondary source; CA to confirm', detail: 'Secondary source only [S12].', where_to_check: 'Section text and rules — CBDT', confidence: 'low', owner: CA },
  { code: 'V-24', title: 'Distributor margins, credit days, working capital, conversion rates — hypotheses; never coded', detail: 'Unsourced vendor blog material [S59][S68][S69]. Treated as interview prompts, never seeded as rules.', where_to_check: 'Interviews with 5–10 Gujarat distributors; RHPs — primary research', confidence: 'hypothesis', owner: SALES_OPS },
  { code: 'V-25', title: 'DISCOM-specific timelines for UGVCL, DGVCL, MGVCL, PGVCL and Torrent Power — not found', detail: 'Only the 15-day feasibility and commissioning rules were found; no statutory SLA exists for the other DISCOM stages.', where_to_check: 'Rights of Consumers Rules and DISCOM circulars — the DISCOMs', confidence: 'low', owner: COMPLIANCE },
  { code: 'V-26', title: 'GERC regulation-version labels and effective dates (rule gerc.regulation_versions)', detail: 'Seeded from trade-press summaries [S37][S38]: the effective date of the original 2016 regulations is approximate and the Fifth Amendment date (4-Nov-2025) is as reported. Used only to label which version applies from the commissioning date.', where_to_check: 'GERC Net Metering Rooftop Solar PV Grid Interactive Systems Regulations 2016 and each amendment — GERC gazette', confidence: 'low', owner: COMPLIANCE },
];

export function buildVerifyRegister(env: SeedEnv): VerifyRegisterItem[] {
  return VERIFY_ITEMS.map((v, i) => ({
    ...baseOf(env, refId('verify', i + 1), 30 * 1440),
    code: v.code, title: v.title, detail: v.detail, where_to_check: v.where_to_check, confidence: v.confidence, owner: v.owner,
    status: 'open', closing_source_url: null, closed_at: null,
  }));
}
