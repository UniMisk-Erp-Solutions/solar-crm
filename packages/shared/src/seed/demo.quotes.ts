import type { ApprovalDecision, ApprovalLane, AppRole, Gate, QuoteStatus, Segment } from '../enums';
import type { Approval, DocumentRow, Quotation, QuotationLine, QuoteDiscussion } from '../rows';
import { skuSeed, priceIdOf, type SkuKey } from './demo.catalogue';
import { DEMO_IDS } from './demo.ids';
import { customerIdOf, OPP_OF_LEAD, siteIdOf } from './demo.leads';
import { specOf, type LeadKey } from './demo.leads.data';
import { baseOf, demoId, earlierOf, laterOf, round2, DAY, type SeedEnv } from './util';

const I = DEMO_IDS;
const P = DEMO_IDS.profile;
export type QuoteKey = keyof typeof DEMO_IDS.quote;

interface LineSpec { sku: SkuKey; qty: number; discountPct?: number; /** hsn and GST rate missing */ untaxed?: boolean; /** CA has NOT approved the tax position */ unapproved?: boolean }

interface QuoteSpec {
  key: QuoteKey; no: string; lead: LeadKey; status: QuoteStatus; version: number; parent?: QuoteKey;
  lines: LineSpec[]; discountPct: number; freight: number;
  /** override the default commissioning / validity dates (absolute or relative to the anchor) */
  commissioning: (env: SeedEnv) => string; validity: (env: SeedEnv) => string; exemption: boolean;
  /** quote is a long-gone accepted version */
  agedDays?: number; households?: number; loan?: { share: number; rate: number; source: string };
}

const std = (sku: SkuKey, qty: number, extra: Partial<LineSpec> = {}): LineSpec => ({ sku, qty, ...extra });
const mods = (sku: SkuKey, qty: number): LineSpec => std(sku, qty);
/** inverter, structure (per kW) and cable (per metre) for a system of `kw` */
const bos = (inv: [SkuKey, number], kw: number, cableM: number, invExtra: Partial<LineSpec> = {}): LineSpec[] => [std(inv[0], inv[1], invExtra), std('s1Structure', kw), std('c1Cable', cableM)];

const dFrom = (days: number) => (env: SeedEnv): string => env.d(days);
const afterExemption = (env: SeedEnv): string => laterOf('2027-02-15', env.d(110));
const beforeExemption = (env: SeedEnv): string => earlierOf(env.d(35), '2026-12-15');

const SPECS: QuoteSpec[] = [
  { key: 'g1', no: 'Q-DEMO-G01', lead: 'oppCaptiveDnd', status: 'draft', version: 1, lines: [mods('m2NonDcr', 150), ...bos(['i3Commercial100', 1], 90, 900)], discountPct: 0, freight: 18000, commissioning: dFrom(60), validity: dFrom(15), exemption: false },
  { key: 'g2', no: 'Q-DEMO-G02', lead: 'oppPmsg', status: 'draft', version: 1, lines: [mods('m2NonDcr', 5), ...bos(['i1Residential', 1], 3, 42)], discountPct: 0, freight: 2500, commissioning: dFrom(45), validity: dFrom(15), exemption: false },
  { key: 'g3', no: 'Q-DEMO-G03', lead: 'oppNetMetered', status: 'draft', version: 1, lines: [mods('m3NotListI', 203), ...bos(['i3Commercial100', 1], 119.77, 1200)], discountPct: 0, freight: 20000, commissioning: beforeExemption, validity: dFrom(15), exemption: true },
  { key: 'g4', no: 'Q-DEMO-G04', lead: 'oppRwa', status: 'draft', version: 1, lines: [mods('m6NoListII', 104), ...bos(['i3Commercial100', 1], 60.32, 600)], discountPct: 0, freight: 12000, commissioning: dFrom(60), validity: dFrom(15), exemption: false, households: 25 },
  { key: 'g5', no: 'Q-DEMO-G05', lead: 'oppOpenAccess', status: 'draft', version: 1, lines: [mods('m6NoListII', 500), ...bos(['i3Commercial100', 3], 290, 2900)], discountPct: 0, freight: 45000, commissioning: afterExemption, validity: dFrom(15), exemption: true },
  { key: 'g6', no: 'Q-DEMO-G06', lead: 'oppNetMetered', status: 'draft', version: 1, lines: [mods('m4BisExpired', 100), mods('m5BisModelMismatch', 100), ...bos(['i3Commercial100', 1], 116.5, 1170)], discountPct: 0, freight: 20000, commissioning: beforeExemption, validity: dFrom(15), exemption: true },
  { key: 'g7', no: 'Q-DEMO-G07', lead: 'oppOpenAccess', status: 'draft', version: 1, lines: [mods('m2NonDcr', 500), ...bos(['i2Large250', 1], 300, 3000)], discountPct: 0, freight: 45000, commissioning: afterExemption, validity: dFrom(15), exemption: false },
  { key: 'g8', no: 'Q-DEMO-G08', lead: 'oppNetMetered', status: 'draft', version: 1, lines: [mods('m2NonDcr', 200), ...bos(['i3Commercial100', 1], 120, 1200)], discountPct: 0, freight: 20000, commissioning: beforeExemption, validity: (env) => laterOf('2027-01-31', env.d(60)), exemption: true },
  { key: 'g9', no: 'Q-DEMO-G09', lead: 'oppPmsg', status: 'draft', version: 1, lines: [mods('m1Dcr', 5), ...bos(['i1Residential', 1], 3, 42, { untaxed: true, unapproved: true })], discountPct: 0, freight: 2500, commissioning: dFrom(45), validity: dFrom(15), exemption: false },
  { key: 'g10', no: 'Q-DEMO-G10', lead: 'oppGovernment', status: 'draft', version: 1, lines: [mods('m8StaleSnapshot', 420), ...bos(['i3Commercial100', 2], 249.9, 2500)], discountPct: 0, freight: 40000, commissioning: dFrom(90), validity: dFrom(15), exemption: false },
  { key: 'g11', no: 'Q-DEMO-G11', lead: 'oppPmsgOverLimit', status: 'draft', version: 1, lines: [mods('m1Dcr', 5), ...bos(['i1Residential', 1], 3, 42)], discountPct: 0, freight: 2500, commissioning: dFrom(45), validity: dFrom(15), exemption: false },
  { key: 'g12', no: 'Q-DEMO-G12', lead: 'oppKusum', status: 'draft', version: 1, lines: [mods('m1Dcr', 17), ...bos(['i1Residential', 2], 10.2, 140)], discountPct: 0, freight: 4500, commissioning: dFrom(60), validity: dFrom(15), exemption: false },
  { key: 'g13', no: 'Q-DEMO-G13', lead: 'oppPmsg', status: 'draft', version: 1, lines: [mods('m1Dcr', 9), ...bos(['i1Residential', 1], 5.4, 76)], discountPct: 0, freight: 3500, commissioning: dFrom(45), validity: dFrom(15), exemption: false },
  { key: 'g14', no: 'Q-DEMO-G14', lead: 'oppPmsg', status: 'draft', version: 1, lines: [mods('m1Dcr', 5), ...bos(['i1Residential', 1], 3, 42)], discountPct: 0, freight: 2500, commissioning: dFrom(45), validity: dFrom(15), exemption: false },
  { key: 'clean1', no: 'Q-DEMO-C01', lead: 'oppPmsg', status: 'draft', version: 1, lines: [mods('m1Dcr', 5), ...bos(['i1Residential', 1], 3, 42)], discountPct: 0, freight: 2500, commissioning: dFrom(45), validity: dFrom(15), exemption: false },
  { key: 'clean2', no: 'Q-DEMO-C02', lead: 'oppGovernment', status: 'draft', version: 1, lines: [mods('m1Dcr', 417), ...bos(['i3Commercial100', 2], 250.2, 2500)], discountPct: 0, freight: 40000, commissioning: dFrom(90), validity: dFrom(15), exemption: false },
  { key: 'pendingH', no: 'Q-DEMO-P01', lead: 'oppGovernment', status: 'pending_approval', version: 1, lines: [mods('m1Dcr', 417), ...bos(['i3Commercial100', 2], 250.2, 2500)], discountPct: 7, freight: 40000, commissioning: dFrom(90), validity: dFrom(15), exemption: false },
  { key: 'w1v1', no: 'Q-DEMO-W1-v1', lead: 'won1', status: 'revised', version: 1, lines: [mods('m1Dcr', 5), ...bos(['i1Residential', 1], 3, 42)], discountPct: 0, freight: 2500, commissioning: dFrom(-35), validity: dFrom(-55), exemption: false, agedDays: 66 },
  { key: 'w1', no: 'Q-DEMO-W1-v2', lead: 'won1', status: 'accepted', version: 2, parent: 'w1v1', lines: [mods('m1Dcr', 5), ...bos(['i1Residential', 1], 3, 42)], discountPct: 4, freight: 2500, commissioning: dFrom(-35), validity: dFrom(-50), exemption: false, agedDays: 62 },
  { key: 'w2v1', no: 'Q-DEMO-W2-v1', lead: 'won2', status: 'rejected', version: 1, lines: [mods('m1Dcr', 5), ...bos(['i1Residential', 1], 3, 42)], discountPct: 12, freight: 2500, commissioning: dFrom(-30), validity: dFrom(-60), exemption: false, agedDays: 75 },
  { key: 'w2', no: 'Q-DEMO-W2-v2', lead: 'won2', status: 'accepted', version: 2, parent: 'w2v1', lines: [mods('m1Dcr', 5), ...bos(['i1Residential', 1], 3, 42)], discountPct: 6, freight: 2500, commissioning: dFrom(-30), validity: dFrom(-55), exemption: false, agedDays: 70, loan: { share: 60000, rate: 5.75, source: '2026-08-04' } },
  { key: 'w3', no: 'Q-DEMO-W3', lead: 'won3', status: 'accepted', version: 1, lines: [mods('m1Dcr', 4), ...bos(['i1Residential', 1], 2.4, 34)], discountPct: 0, freight: 2000, commissioning: dFrom(-40), validity: dFrom(-60), exemption: false, agedDays: 80 },
  { key: 'w4', no: 'Q-DEMO-W4', lead: 'won4', status: 'accepted', version: 1, lines: [mods('m1Dcr', 67), ...bos(['i3Commercial100', 1], 40.2, 400)], discountPct: 2.5, freight: 15000, commissioning: dFrom(20), validity: dFrom(-45), exemption: false, agedDays: 70, households: 14 },
  { key: 'w5', no: 'Q-DEMO-W5', lead: 'won5', status: 'accepted', version: 1, lines: [mods('m1Dcr', 5), ...bos(['i1Residential', 1], 3, 42)], discountPct: 0, freight: 2500, commissioning: dFrom(30), validity: dFrom(-20), exemption: false, agedDays: 45 },
];

/** What each gate-scenario quote demonstrates; rendered into docs/DEMO_SCENARIOS.md. */
export interface QuoteScenario { quote_no: string; key: QuoteKey; gate: Gate | 'clean'; title: string; why: string; clear: string; expect: string }

export const DEMO_QUOTE_SCENARIOS: readonly QuoteScenario[] = [
  { quote_no: 'Q-DEMO-G01', key: 'g1', gate: 'G1', title: 'Consent and DND', why: 'The customer is on the DND register and gave consent for service and quotation only, so sending the quotation as a promotional WhatsApp or SMS is barred.', clear: 'Send the quotation through the service/transactional channel only, or have the customer give promotional consent and clear the DND scrub.', expect: 'G1 hard stop on any promotional send (verified, active rules).' },
  { quote_no: 'Q-DEMO-G02', key: 'g2', gate: 'G2', title: 'Non-DCR module on a subsidised job', why: 'The PM Surya Ghar quote carries SKU DS-N600-STD, whose DCR certificate is not verified. DCR is an essential condition for CFA.', clear: 'Replace the module line with DS-N600-DCR, or verify the DCR certificate in the SKU compliance register.', expect: 'G2 hard stop (pmsg.dcr_required_for_cfa is verified and active).' },
  { quote_no: 'Q-DEMO-G03', key: 'g3', gate: 'G3', title: 'Module model not on ALMM List-I', why: 'The net-metered C&I quote uses NovaPV NP-M590, which is not an ALMM List-I model.', clear: 'Replace the module with a List-I model, or update the SKU once the model is listed and refresh the snapshot.', expect: 'G3 hard stop (almm.list1.enforcement_date verified and active).' },
  { quote_no: 'Q-DEMO-G04', key: 'g4', gate: 'G4', title: 'Cells not on ALMM List-II (subsidy job)', why: 'The RWA / GHS society quote uses DS-N580-STK, whose cell maker is not on List-II, and the job commissions after 01-Jun-2026.', clear: 'Use a module with List-II cells (for example DS-N600-DCR).', expect: 'G4 hard stop (almm.list2.effective_date verified and active).' },
  { quote_no: 'Q-DEMO-G05', key: 'g5', gate: 'G5', title: 'Relies on the List-II exemption but commissions late', why: 'The open-access quote uses non-List-II cells under the exemption, but the expected commissioning date is after 31-Dec-2026.', clear: 'Bring commissioning on or before 31-Dec-2026, switch to List-II cells, or obtain a compliance-lane override with a written reason.', expect: 'G5 hard stop (exemption rule verified and active); override needs the compliance lane.' },
  { quote_no: 'Q-DEMO-G06', key: 'g6', gate: 'G6', title: 'BIS licence expired / licensed model differs', why: 'One line uses PW-M580 with a BIS licence that expired 45 days ago; the other uses PW-M585 while the licence covers PW-M580.', clear: 'Renew the licence in the SKU register, or choose modules with a valid licence for the quoted model.', expect: 'G6 warning only while bis.module_standard_no is conflicting and inactive; it becomes a hard stop once a compliance officer enforces it.' },
  { quote_no: 'Q-DEMO-G07', key: 'g7', gate: 'G7', title: 'Inverter above 200 kW on self-certification', why: 'The open-access quote includes the 250 kW GM-250K-3P, which is self-certified, and commissions after the self-certification end date (31-Dec-2026).', clear: 'Commission before the end date, use a BIS-licensed inverter, or wait for an extension notification.', expect: 'G7 warning (rule capped at warning until a compliance officer enforces a hard stop).' },
  { quote_no: 'Q-DEMO-G08', key: 'g8', gate: 'G8', title: 'Validity beyond the exemption horizon', why: 'The exemption-reliant quote is valid until Jan-2027, beyond the 31-Dec-2026 exemption date it depends on.', clear: 'Shorten the validity date to the horizon, or re-quote after the exemption position is settled.', expect: 'G8 warning.' },
  { quote_no: 'Q-DEMO-G09', key: 'g9', gate: 'G9', title: 'GST rate or HSN missing; tax position not approved', why: 'The inverter line has no HSN or GST rate and no CA approval, and the inverter GST rule is conflicting (5 % vs 18 %).', clear: 'Enter the HSN and rate, then have a CA user (accounts) approve the tax position on the line.', expect: 'G9 hard stop for the inverter line while gst.inverter_rate is conflicting; warning otherwise.' },
  { quote_no: 'Q-DEMO-G10', key: 'g10', gate: 'G10', title: 'Stale ALMM snapshot', why: 'SKU DS-N595-ST was last checked against ALMM 12 days ago; the limit is 7 days.', clear: 'Re-verify the SKU against the ALMM list and refresh its snapshot date.', expect: 'G10 warning.' },
  { quote_no: 'Q-DEMO-G11', key: 'g11', gate: 'G11', title: 'Dealer over credit limit', why: 'Dealer Anand Rooftop Solutions has ₹ 22.5 lakh outstanding against a ₹ 20 lakh limit, part of it subsidy-linked and ageing past 60 days.', clear: 'Collect overdue payments, take an advance, or obtain an approved credit override from the accounts lane.', expect: 'G11 hard stop on sales-order creation.' },
  { quote_no: 'Q-DEMO-G12', key: 'g12', gate: 'G12', title: 'Name on bill differs; pending dues', why: 'The PM-KUSUM applicant is the son; the electricity bill is in the father\'s name and shows pending dues.', clear: 'Clear the dues and either correct the bill name or record the family relationship and obtain a consent letter.', expect: 'G12 warning.' },
  { quote_no: 'Q-DEMO-G13', key: 'g13', gate: 'G13', title: 'PMSG system above 3 kW', why: 'The 5.4 kW option earns no CFA beyond 3 kW (CFA capped at ₹ 78,000).', clear: 'Reduce to 3 kW or accept that the extra capacity is not subsidised.', expect: 'G13 warning.' },
  { quote_no: 'Q-DEMO-G14', key: 'g14', gate: 'G14', title: 'Aadhaar image uploaded', why: 'A file named aadhaar_card_front.jpg is attached to the quote. Only the file name exists — no real document — to exercise the filename guard.', clear: 'Delete the attachment; if the customer insists, record the last four digits only in the masked field.', expect: 'G14 hard stop (policy).' },
  { quote_no: 'Q-DEMO-C01', key: 'clean1', gate: 'clean', title: 'Clean PM Surya Ghar quote', why: 'DCR, List-I, List-II and BIS all valid; 3 kW; fresh snapshot; CA-approved tax lines; consent on file.', clear: 'Nothing to clear — evaluate, request approvals and send.', expect: 'No findings.' },
  { quote_no: 'Q-DEMO-C02', key: 'clean2', gate: 'clean', title: 'Clean government bid quote', why: 'DCR-verified List-I/List-II modules, fresh snapshot, validity inside the price horizon.', clear: 'Nothing to clear — evaluate and send.', expect: 'No findings.' },
];

/* ───────────────────────── pricing ───────────────────────── */

export interface PricedLine { spec: LineSpec; unit_price: number; line_total: number; gst_rate: number | null; hsn: string | null }
export function priceLines(spec: { lines: LineSpec[] }): PricedLine[] {
  return spec.lines.map((l) => {
    const s = skuSeed(l.sku);
    const disc = l.discountPct ?? 0;
    return { spec: l, unit_price: s.price, line_total: round2(l.qty * s.price * (1 - disc / 100)), gst_rate: l.untaxed ? null : s.gst, hsn: l.untaxed ? null : s.hsn };
  });
}

function cfaFor(segment: Segment, kw: number, households: number | undefined): { cfa: number; lines: { label: string; kw: number; rate: number; amount: number }[] } {
  if (segment === 'pmsg_residential') {
    const first = Math.min(kw, 2), third = Math.max(0, Math.min(kw, 3) - 2);
    const lines = [{ label: 'First 2 kW', kw: first, rate: 30000, amount: round2(first * 30000) }];
    if (third > 0) lines.push({ label: 'Third kW', kw: round2(third), rate: 18000, amount: round2(third * 18000) });
    return { cfa: Math.min(78000, lines.reduce((s, l) => s + l.amount, 0)), lines };
  }
  if (segment === 'rwa_ghs') {
    const eligible = Math.min(kw, (households ?? 0) * 3, 500);
    return { cfa: round2(eligible * 18000), lines: [{ label: 'Common-facility CFA', kw: round2(eligible), rate: 18000, amount: round2(eligible * 18000) }] };
  }
  return { cfa: 0, lines: [] };
}

export interface QuoteSet { quotes: Quotation[]; lines: QuotationLine[]; discussions: QuoteDiscussion[]; approvals: Approval[]; documents: DocumentRow[] }

export const quoteSpecOf = (key: QuoteKey): QuoteSpec => {
  const s = SPECS.find((x) => x.key === key);
  if (!s) throw new Error(`Unknown quote ${key}`);
  return s;
};
export const QUOTE_KEYS: readonly QuoteKey[] = SPECS.map((s) => s.key);

export function buildQuotes(env: SeedEnv): QuoteSet {
  const out: QuoteSet = { quotes: [], lines: [], discussions: [], approvals: [], documents: [] };
  const clauseKeys = ['clause.price_validity', 'clause.gst_change', 'clause.duty_change', 'clause.almm_change', 'clause.payment_terms_default'];

  SPECS.forEach((q) => {
    const ls = specOf(q.lead);
    const priced = priceLines(q);
    const kw = round2(q.lines.reduce((s, l) => {
      const sku = skuSeed(l.sku);
      return sku.category === 'module' ? s + (l.qty * (sku.wattage ?? 0)) / 1000 : s;
    }, 0));
    const subtotal = round2(priced.reduce((s, l) => s + l.line_total, 0));
    const discountAmount = round2((subtotal * q.discountPct) / 100);
    const tax = round2(priced.reduce((s, l) => s + (l.gst_rate === null ? 0 : (l.line_total * (1 - q.discountPct / 100) * l.gst_rate) / 100), 0) + q.freight * 0.18);
    const total = round2(subtotal - discountAmount + q.freight + tax);
    const { cfa, lines: cfaLines } = cfaFor(ls.segment, kw, q.households);
    const loan = q.loan?.share ?? 0;
    const evaluated = q.status !== 'draft';
    const aged = (q.agedDays ?? 1) * DAY;
    const approvedAll = !q.lines.some((l) => l.unapproved);
    const id = I.quote[q.key];

    out.quotes.push({
      ...baseOf(env, id, aged, P.techno_commercial), quote_no: q.no, version: q.version, parent_quote_id: q.parent ? I.quote[q.parent] : null,
      opportunity_id: OPP_OF_LEAD[q.lead]!, lead_id: I.lead[q.lead], customer_id: customerIdOf(q.lead), site_id: siteIdOf(q.lead), segment: ls.segment, kw, expected_commissioning_date: q.commissioning(env),
      status: q.status, validity_date: q.validity(env), price_snapshot_at: env.t(q.agedDays ? -aged : -DAY), tax_position_approved: approvedAll, clause_keys: clauseKeys, place_of_supply: 'Gujarat',
      payment_terms: '30 % advance with the purchase order; balance against dispatch documents before delivery.',
      subtotal, discount_pct: q.discountPct, discount_amount: discountAmount, freight: q.freight, tax_total: tax, total, margin_pct: evaluated ? 14.2 : null,
      floor_check: evaluated ? { ok: true, lines: priced.map((p) => ({ sku_id: I.sku[p.spec.sku], unit_price: p.unit_price, floor_price: skuSeed(p.spec.sku).floor, below_floor: false })), margin_pct: 14.2 } : null,
      cfa_entitlement: cfa, state_share: 0, loan_share: loan, consumer_share: round2(total - cfa - loan),
      cfa_breakdown: { lines: cfaLines, cap: ls.segment === 'pmsg_residential' ? 78000 : null, note: 'State share is zero until a Gujarat state scheme is configured and activated.' },
      loan_rate_pct: q.loan?.rate ?? null, loan_rate_source_date: q.loan?.source ?? null,
      exemption_reliance: q.exemption, compliance_status: evaluated ? 'clear' : 'pending', compliance_findings: [], compliance_evaluated_at: evaluated ? env.t(-aged + 60) : null, rule_ids_used: [], requote_reason: null,
      owner_id: P.techno_commercial, distributor_id: ls.dist, dealer_id: ls.dealer, territory_id: ls.territory,
      sent_at: q.status === 'accepted' || q.status === 'revised' || q.status === 'rejected' ? env.t(-aged + 120) : null, accepted_at: q.status === 'accepted' ? env.t(-aged + 3 * DAY) : null,
      rejected_reason: q.status === 'rejected' ? 'Discount above 10 % was not approved by Management.' : null, pdf_document_id: null, terms_confirmed_at: q.status === 'accepted' ? env.t(-aged + 3 * DAY + 30) : null,
    });

    priced.forEach((p, i) => {
      const sku = skuSeed(p.spec.sku);
      out.lines.push({
        ...baseOf(env, demoId('quote-line', out.lines.length + 1), aged, P.techno_commercial), quote_id: id, sku_id: I.sku[p.spec.sku], description: `${sku.make} ${sku.model} — ${sku.variant}`,
        hsn: p.hsn, gst_rate: p.gst_rate, gst_as_of: p.gst_rate === null ? null : env.d(-1), tax_position_approved: !p.spec.unapproved, tax_approved_by: p.spec.unapproved ? null : P.accounts,
        qty: p.spec.qty, uom: sku.uom, unit_price: p.unit_price, discount_pct: p.spec.discountPct ?? 0, line_total: p.line_total, price_id: priceIdOf(p.spec.sku), sort_order: i + 1,
      });
    });
  });

  // follow-up / negotiation discussions on quotes that were sent
  const discuss = (key: QuoteKey, kind: QuoteDiscussion['kind'], outcome: string, notes: string, agoDays: number, nextInDays: number | null): void => {
    out.discussions.push({
      ...baseOf(env, demoId('quote-discussion', out.discussions.length + 1), agoDays * DAY, P.techno_commercial), quote_id: I.quote[key], kind, outcome, notes, logged_by: P.techno_commercial,
      logged_at: env.t(-agoDays * DAY), next_followup_at: nextInDays === null ? null : env.t(nextInDays * DAY),
    });
  };
  discuss('w1v1', 'call', 'Asked for a better price', 'Customer compared two dealers and asked for a discount.', 65, null);
  discuss('w1', 'whatsapp', 'Accepted', 'Customer accepted the revised price and asked for the proforma invoice.', 62, null);
  discuss('w2v1', 'meeting', 'Discount requested', 'Customer asked for 12 % off; management declined.', 74, null);
  discuss('w2', 'call', 'Accepted with a bank loan', 'Customer accepted at 6 % off and will apply for a loan.', 70, null);
  discuss('w3', 'email', 'Accepted', 'Terms confirmed by e-mail.', 78, null);
  discuss('w4', 'meeting', 'Accepted by the managing committee', 'Committee resolution passed at the general body meeting.', 68, null);
  discuss('w5', 'call', 'Accepted', 'Customer accepted; advance expected after the proforma invoice.', 43, null);
  discuss('pendingH', 'meeting', 'Technical bid accepted', 'Price bid discussion pending approval of a 7 % discount.', 3, 2);

  // approvals attached to quotes (commercial and compliance lanes)
  const approve = (key: QuoteKey, lane: ApprovalLane, step: number, role: AppRole, approver: string | null, decision: ApprovalDecision, comment: string | null, agoDays: number, dueInHours: number | null): void => {
    const requested = env.t(-agoDays * DAY);
    out.approvals.push({
      ...baseOf(env, demoId('approval', out.approvals.length + 1), agoDays * DAY, P.techno_commercial), entity_type: 'quotation', entity_id: I.quote[key], lane, step, required_role: role, approver_id: approver, decision, comment,
      decided_at: decision === 'pending' ? null : env.t(-agoDays * DAY + 4 * 60), due_at: dueInHours === null ? env.t(-agoDays * DAY + 24 * 60) : env.t(dueInHours * 60), requested_by: P.techno_commercial, requested_at: requested, meta: { quote_no: out.quotes.find((x) => x.id === I.quote[key])?.quote_no ?? null },
    });
  };
  approve('w1', 'commercial', 1, 'dsm', P.dsm, 'approved', 'Approved — 4 % for a repeat-referral customer.', 63, null);
  approve('w2v1', 'commercial', 1, 'dsm', P.dsm, 'approved', 'Forwarded to the Regional Head.', 75, null);
  approve('w2v1', 'commercial', 2, 'regional_head', P.regional_head, 'approved', 'Forwarded to Management.', 75, null);
  approve('w2v1', 'commercial', 3, 'management', P.management, 'rejected', 'Margin too thin at 12 % — counter at 6 %.', 75, null);
  approve('w2', 'commercial', 1, 'dsm', P.dsm, 'approved', 'Approved at 6 %.', 71, null);
  approve('w2', 'commercial', 2, 'regional_head', P.regional_head, 'approved', 'Approved at 6 %.', 71, null);
  approve('w4', 'compliance', 1, 'compliance_officer', P.compliance_officer, 'approved', 'Module substitution recorded; cells verified on List-II.', 69, null);
  approve('pendingH', 'commercial', 1, 'dsm', P.dsm, 'approved', 'Approved 7 % — large government order.', 2, null);
  approve('pendingH', 'commercial', 2, 'regional_head', null, 'pending', null, 1, 20);
  approve('pendingH', 'compliance', 1, 'compliance_officer', null, 'pending', null, 1, 16);

  // G14 scenario: a file NAME that trips the filename guard. No such file exists in storage.
  out.documents.push({
    ...baseOf(env, demoId('document', 1), 2 * DAY, P.dealer_user_2), entity_type: 'quotation', entity_id: I.quote.g14, bucket: 'lead-docs', path: 'demo/g14/aadhaar_card_front.jpg', doc_type: 'identity_proof',
    file_name: 'aadhaar_card_front.jpg', mime: 'image/jpeg', size_bytes: 184_320, uploaded_by: P.dealer_user_2,
  });

  return out;
}
