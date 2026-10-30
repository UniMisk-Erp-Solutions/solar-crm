/**
 * Coverage registry for the end-to-end flow test. The specification is `Solar CRM flow diagrams.md`: every numbered step of the master flow (1-34),
 * every extension node (N0a, N0b, X1-X5, N3a, N3b, N4a, P1-P5), both branches of every decision node in sections 2-9, the escalation matrix (10),
 * the six conversion gates (10a) and the three state diagrams (11.1 lead, 11.2 quotation, 11.3 clock) are declared in FLOW_NODES.
 * A test proves a node with `covers(id, 'what was asserted', actor)`; the last test fails when any node has no proof, checks that the actor is a
 * role the colour legend allows for that node, and writes docs/FLOW_TRACEABILITY.md.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from 'vitest';

export type Legend = 'system' | 'distributor' | 'customer' | 'sales' | 'mgmt';
/** An actor is a seeded role, or `system` (public API key, clock engine, nightly job) or `customer` (the end customer's own action, recorded by staff). */
export type Actor = string;

const LEGEND_LABEL: Record<Legend, string> = {
  system: 'System / CRM (blue)', distributor: 'Distributor / DSM (teal)', customer: 'End customer (green)', sales: 'Sales / Techno-commercial (purple)', mgmt: 'Management / Sales Ops / Accounts (orange)',
};

/** Who may perform a step of each legend group. `admin` may always act. System steps are triggered by the machine or by any user. */
const LEGEND_ROLES: Record<Legend, string[]> = {
  system: ['system', 'admin', 'distributor_user', 'dealer_user', 'dsm', 'sales_manager', 'regional_head', 'techno_commercial', 'accounts', 'compliance_officer', 'dispatch', 'management'],
  distributor: ['distributor_user', 'dealer_user', 'dsm', 'sales_manager', 'regional_head', 'admin', 'system'],
  customer: ['customer', 'distributor_user', 'dealer_user', 'dsm', 'sales_manager', 'regional_head', 'techno_commercial', 'accounts', 'management', 'admin'],
  sales: ['techno_commercial', 'sales_manager', 'regional_head', 'dsm', 'distributor_user', 'dealer_user', 'management', 'compliance_officer', 'admin', 'system'],
  mgmt: ['management', 'regional_head', 'sales_manager', 'dsm', 'accounts', 'compliance_officer', 'dispatch', 'techno_commercial', 'admin', 'system'],
};

export interface FlowNode { id: string; section: string; label: string; legend: Legend; endpoints: string; web: string }
const nodes: FlowNode[] = [];
const sec = (section: string) => (id: string, label: string, legend: Legend, endpoints: string, web: string): void => { nodes.push({ id, section, label, legend, endpoints, web }); };

/* ───────── 1 · master flow: the 34 company steps ───────── */
const m = sec('1 Master flow');
m('1', 'Inquiry captured', 'system', 'POST /public/leads · POST /webhooks/campaign · POST /webhooks/whatsapp · POST /leads', '/apply (public form) · /leads/new');
m('2', 'Validate and de-duplicate', 'system', 'POST /public/leads (422 on bad mobile/e-mail; duplicate report)', '/leads/:id');
m('3', 'Capture details', 'system', 'POST /public/leads · GET /public/pincode/:pin · PATCH /leads/:id', '/leads/:id');
m('4', 'Territory and capability match', 'system', 'POST /public/leads (routing snapshot in lead_assignments)', '/leads/:id');
m('5', 'Auto-assign to distributor / DSM', 'distributor', 'POST /public/leads · POST /leads/:id/reassign', '/leads/:id');
m('6', 'Escalate to DSM / reassign territory', 'distributor', 'POST /leads/:id/reassign · POST /leads/:id/reject', '/leads (kanban "unassigned")');
m('7', 'Lead acceptance by distributor', 'distributor', 'POST /leads/:id/accept', '/ (home: leads awaiting acceptance) · /leads/:id');
m('8', 'Initial customer contact', 'distributor', 'POST /leads/:id/contacts · POST /leads/:id/messages', '/leads/:id');
m('9', 'Qualification call', 'distributor', 'POST /leads/:id/qualification', '/leads/:id');
m('10', 'Lead temperature', 'system', 'POST /leads/:id/qualification · GET /leads/:id/score', '/leads/:id');
m('11', 'Lead quality score', 'system', 'GET /leads/:id/score · POST /leads/:id/score/recompute', '/leads/:id');
m('12', 'CRM follow-up engine', 'system', 'PATCH /leads/:id · POST /leads/:id/followups · POST /followups/:id/complete · GET /followups', '/ (home) · /leads/:id');
m('13', 'Auto reminders and notifications', 'system', 'clock engine (tickClocks) · GET /notifications · POST /leads/:id/messages', '/notifications');
m('14', 'Customer site visit', 'sales', 'POST /surveys · PATCH /surveys/:id · POST /surveys/:id/photos', '/surveys/:id');
m('15', 'Requirement capture form', 'sales', 'PUT /leads/:id/site · POST /leads/:id/site/bill · GET|PUT /leads/:id/requirement', '/leads/:id (site and requirement tabs)');
m('16', 'Product recommendation and brand USP', 'sales', 'GET /skus/recommend', '/catalogue · /quotes/:id');
m('17', 'Technical discussion and solution fit', 'sales', 'POST /compliance/preview · PATCH /surveys/:id (findings) · GET /leads/:id/timeline', '/surveys/:id · /opportunities/:id');
m('18', 'Rate negotiation with end customer', 'customer', 'GET|POST /leads/:id/negotiations', '/leads/:id');
m('19', 'Convert to opportunity', 'sales', 'GET /leads/:id/convert-check · POST /leads/:id/convert', '/leads/:id → /opportunities/:id');
m('20', 'Update opportunity', 'sales', 'PATCH /opportunities/:id · POST /opportunities/:id/stage', '/opportunities/:id');
m('21', 'Prepare techno-commercial offer', 'sales', 'POST /quotes · PUT /quotes/:id/lines · PATCH /quotes/:id', '/quotes/:id');
m('22', 'Internal price review', 'sales', 'POST /quotes/:id/evaluate · GET /quotes/:id (margin, floor check)', '/quotes/:id');
m('23', 'Approval matrix (commercial, compliance, credit lanes)', 'mgmt', 'POST /quotes/:id/request-approval · GET /approvals · POST /approvals/:id/decide', '/approvals');
m('24', 'Send quotation to customer', 'sales', 'POST /quotes/:id/send · GET /quotes/:id/pdf', '/quotes/:id');
m('25', 'Customer discussion and negotiation', 'customer', 'POST /quotes/:id/discussions', '/quotes/:id');
m('26', 'Revise quote / follow-up', 'sales', 'POST /quotes/:id/revise', '/quotes/:id');
m('27', 'Commercial terms confirmed', 'sales', 'POST /quotes/:id/accept', '/quotes/:id');
m('28', 'Prepare proforma invoice', 'mgmt', 'GET /quotes/:id/pre-pi-checklist · POST /pis · PATCH /pis/:id', '/invoices/:id');
m('29', 'PI approval and issue', 'mgmt', 'POST /pis/:id/submit · POST /approvals/:id/decide', '/invoices/:id · /approvals');
m('30', 'Payment or credit verification', 'mgmt', 'POST /pis/:id/payments · POST /pis/:id/credit-check · POST /credit-checks/:id/decide · GET /credit-position/:dealerId', '/invoices/:id');
m('31', 'Customer PO or order confirmation', 'customer', 'POST /sales-orders (customer_po_no, customer_po_date)', '/orders/:id');
m('32', 'Create sales order', 'system', 'POST /sales-orders (gate G11)', '/orders/:id');
m('33', 'SO approval and circulation', 'mgmt', 'POST /approvals/:id/decide (sales_order) · GET /notifications', '/approvals · /orders/:id');
m('34', 'Hand over to dispatch planning', 'mgmt', 'POST /sales-orders/:id/handover', '/orders/:id');

/* ───────── extension nodes of the master flow ───────── */
const x = sec('1 Extension nodes');
x('N0', 'Lead arrives (website, call, WhatsApp, campaign, referral, dealer upload)', 'system', 'POST /public/leads (per source key) · POST /webhooks/campaign · POST /webhooks/whatsapp', '/apply');
x('N0a', 'Consent ledger entry (notice version, purposes, channels, named recipients)', 'system', 'POST /public/leads (consent) · GET /public/consent-notice · GET /leads/:id/consents', '/leads/:id (consent panel)');
x('N0b', 'DND scrub and WhatsApp opt-in check', 'system', 'POST /public/leads · POST /leads/:id/dnd-scrub · POST /webhooks/whatsapp', '/leads/:id (consent panel)');
x('X1', 'Record source and provenance (notice version, purposes, channels, recipients)', 'system', 'POST /public/leads (provenance → source_detail)', '/leads/:id');
x('X2', 'Decision: consent present and DND scrub clear?', 'system', 'POST /public/leads · GET /leads/:id (consent_summary)', '/leads/:id');
x('X3', 'Block promotional outreach, service reply only inside window, log reason', 'system', 'POST /leads/:id/messages (422 CONSENT_BLOCKED) · GET /leads/:id/messages', '/leads/:id (messages)');
x('X4', 'Decision: duplicate or existing owner?', 'system', 'POST /public/leads (duplicate_of, lock_status)', '/leads/:id');
x('X5', 'Ownership lock decision, manager override workflow', 'mgmt', 'POST /leads/:id/lock-override · POST /leads/:id/lock-override/decide · POST /leads/:id/merge', '/leads/:id');
x('N3a', 'Segmentation fork and rule pack (7 segments)', 'sales', 'GET /segments/:segment/form · GET /compliance/gates · POST /leads/:id/convert (scheme_route)', '/leads/:id · /admin/gates');
x('N3b', 'DISCOM feasibility tracking', 'sales', 'PATCH /surveys/:id/feasibility · clock discom_feasibility', '/surveys/:id');
x('N4a', 'Compliance engine (ALMM, DCR, BIS, GST, price validity)', 'system', 'POST /quotes/:id/evaluate · POST /compliance/preview · GET /compliance/gates', '/quotes/:id (compliance panel)');
x('P1', 'Serial-number dispatch', 'system', 'POST /dispatches · POST /dispatches/:id/evaluate · POST /dispatches/:id/dispatch', '/dispatch/:id');
x('P2', 'Installation and DISCOM commissioning', 'distributor', 'POST /installations · POST /installations/:id/certificate · POST /installations/:id/commission · /discom-applications', '/post-sale');
x('P3', 'Subsidy claim and loan tracking', 'mgmt', '/subsidy-claims · /loans', '/post-sale');
x('P4', 'Warranty, RMA and 5-year O&M', 'distributor', '/warranty-tickets · GET /installations/om-register', '/post-sale');
x('P5', 'Channel scorecard and credit review', 'mgmt', 'GET /dealers/:id/scorecard · POST /distributors/:id/score/recompute · GET /dealers/exposure', '/dealers/:id · /distributors/:id');

/* ───────── 2 · stage 1 decisions ───────── */
const s2 = sec('2 Stage 1 decisions');
s2('2/X2/yes', 'Consent present and DND clear: YES → straight to capture, promotional allowed', 'system', 'GET /leads/:id (consent_summary.outbound)', '/leads/:id');
s2('2/X2/no', 'Consent missing or DND registered: NO → promotional blocked, reason logged', 'system', 'POST /leads/:id/messages', '/leads/:id');
s2('2/X4/yes', 'Duplicate or existing owner: YES → held for manager (ownership lock)', 'system', 'POST /public/leads', '/leads/:id');
s2('2/X4/no', 'Duplicate or existing owner: NO → validated and routed', 'system', 'POST /public/leads', '/leads/:id');
s2('2/D1/yes', 'Distributor available and eligible: YES → step 5 auto-assign + acceptance clock', 'system', 'POST /public/leads', '/leads/:id');
s2('2/D1/no', 'Distributor available and eligible: NO → step 6 unassigned, DSM alerted', 'system', 'POST /public/leads · POST /leads/:id/reassign', '/leads (kanban)');
s2('2/D2/yes', 'Accepted within SLA: YES → lead accepted, clock met', 'distributor', 'POST /leads/:id/accept', '/leads/:id');
s2('2/D2/no', 'Accepted within SLA: NO → Reminder 1, DSM alert, auto reassignment', 'system', 'tickClocks · lead_acceptance clock handlers', '/leads/:id');
s2('2/R1', 'Reminder 1 at 70 % of the SLA', 'system', 'tickClocks → lead.acceptance.reminder1', '/notifications');
s2('2/R2', 'DSM alert at 100 %', 'system', 'tickClocks → lead.acceptance.dsm_alert', '/notifications');
s2('2/R3', 'Auto reassignment to the next best distributor', 'system', 'tickClocks → auto_reassigned', '/leads/:id');

/* ───────── 3 · stage 2 decisions ───────── */
const s3 = sec('3 Stage 2 decisions');
s3('3/COLD', 'Temperature COLD (long-term / low urgency)', 'system', 'POST /leads/:id/qualification', '/leads/:id');
s3('3/WARM', 'Temperature WARM (1-3 months)', 'system', 'POST /leads/:id/qualification', '/leads/:id');
s3('3/HOT', 'Temperature HOT (0-30 days / immediate)', 'system', 'POST /leads/:id/qualification', '/leads/:id');
s3('3/UP', 'Deadline uplift: raise one level when a compliance deadline is within 60 days', 'system', 'POST /leads/:id/qualification', '/leads/:id');
s3('3/MF', 'Mandatory fields on every save (last action, next action, next follow-up date, owner)', 'system', 'PATCH /leads/:id', '/leads/:id (mandatory-field banner)');
s3('3/D1/yes', 'Next action completed on time: YES → on track', 'system', 'POST /followups/:id/complete', '/ (home)');
s3('3/D1/no', 'Next action completed on time: NO → follow-up missed, escalation DSM → Sales Manager → Management', 'system', 'tickClocks → followup.missed', '/notifications');
s3('3/CH/wa-window', 'WhatsApp free text only inside the 24 h window', 'distributor', 'POST /leads/:id/messages', '/leads/:id (messages)');
s3('3/CH/wa-template', 'WhatsApp outside the window → approved template with consent', 'distributor', 'POST /leads/:id/messages', '/leads/:id (messages)');
s3('3/CH/sms', 'SMS needs DLT template id and header', 'distributor', 'POST /leads/:id/messages', '/leads/:id (messages)');
s3('3/CH/call', 'Call logged on the registered series, DND scrubbed', 'distributor', 'POST /leads/:id/messages (channel call)', '/leads/:id (messages)');
s3('3/CH/optout-bar', '90-day bar after opt-out', 'system', 'POST /webhooks/whatsapp (STOP) · POST /leads/:id/messages', '/leads/:id (consent panel)');

/* ───────── 4 · stage 3 decisions ───────── */
const s4 = sec('4 Stage 3 decisions');
s4('4/NM/yes', 'Name on bill equals applicant and no pending dues: YES → no warning', 'sales', 'PUT /leads/:id/site', '/leads/:id (site tab)');
s4('4/NM/no', 'Name on bill differs or pending dues: NO → warning G12 (hint), fix before DISCOM filing', 'sales', 'PUT /leads/:id/site · POST /compliance/preview', '/leads/:id (site tab)');
s4('4/FE/no', 'System above 10 kW: NO → no feasibility study needed', 'sales', 'POST /surveys · PATCH /surveys/:id/feasibility (409)', '/surveys/:id');
s4('4/FE/yes', 'System above 10 kW: YES → 15-day feasibility clock, deemed feasible on silence', 'sales', 'PATCH /surveys/:id/feasibility · tickClocks', '/surveys/:id');
s4('4/CP', 'Live compliance panel (ALMM, DCR, BIS, snapshot date)', 'system', 'POST /compliance/preview', '/quotes/:id');
s4('4/Q/yes', 'Qualified project and real opportunity: YES → convert (three confirmations)', 'sales', 'POST /leads/:id/convert', '/leads/:id');
s4('4/Q/no', 'Qualified project: NO → nurture / recycle with re-engagement date', 'sales', 'POST /leads/:id/nurture · POST /leads/:id/lost', '/leads/:id');
s4('4/NUR', 'Nurture lead re-enters the flow on the re-engagement date', 'system', 'job lead.nurture_reactivation', '/ (home: follow-ups)');
s4('4/WI', 'Work instruction: no conversion without the three confirmations (service guard; SQL trigger asserted in the SQL suite)', 'system', 'POST /leads/:id/convert (422 GUARD_BLOCKED)', '/leads/:id');

/* ───────── 5 · stage 4 decisions ───────── */
const s5 = sec('5 Stage 4 decisions');
s5('5/CE', 'Compliance engine evaluates the quote (gates G1-G14)', 'system', 'POST /quotes/:id/evaluate', '/quotes/:id');
s5('5/HS/yes', 'Any hard stop: YES → quote blocked, send and approval refused', 'system', 'PUT /quotes/:id/lines · POST /quotes/:id/send', '/quotes/:id');
s5('5/HS/no', 'Any hard stop: NO → internal price review', 'system', 'POST /quotes/:id/evaluate', '/quotes/:id');
s5('5/FIX/swap', 'Fix: replace the SKU / record the tax position', 'sales', 'PUT /quotes/:id/lines · POST /quotes/:id/tax-position', '/quotes/:id');
s5('5/FIX/override', 'Fix: compliance override approved by the compliance lane with a written reason', 'mgmt', 'POST /compliance/overrides · POST /approvals/:id/decide', '/approvals');
s5('5/D1/yes', 'Special pricing or discount needed: YES → approval matrix', 'sales', 'POST /quotes/:id/request-approval', '/quotes/:id');
s5('5/D1/no', 'Special pricing or discount needed: NO → straight to send', 'sales', 'POST /quotes/:id/request-approval (approved at once)', '/quotes/:id');
s5('5/L1', 'Commercial lane: DSM → Regional Head → Management', 'mgmt', 'POST /approvals/:id/decide', '/approvals');
s5('5/L2', 'Compliance lane: substitution, exemption reliance, unverified-rule dependency', 'mgmt', 'POST /approvals/:id/decide', '/approvals');
s5('5/L3', 'Credit lane: dealer limit, ageing, portal status', 'mgmt', 'POST /approvals/:id/decide', '/approvals');
s5('5/D2/yes', 'Quotation accepted: YES → commercial terms confirmed', 'sales', 'POST /quotes/:id/accept', '/quotes/:id');
s5('5/D2/no', 'Quotation accepted: NO → step 26 revise (version n+1, parent linked), loops back to 21', 'sales', 'POST /quotes/:id/revise', '/quotes/:id');
s5('5/FU', 'Quote follow-up cadence Day 1/3/5/7 then escalation', 'system', 'POST /quotes/:id/send · tickClocks', '/quotes/:id');
s5('5/RQ', 'Re-quote engine flags open quotes when price, register or rule changes', 'system', 'POST /prices · PUT /skus/:id/compliance · GET /reports/requote-exposure', '/quotes · /reports');

/* ───────── 6 · stage 5 decisions ───────── */
const s6 = sec('6 Stage 5 decisions');
s6('6/CK/no', 'Pre-PI checklist complete: NO → blocked until complete', 'mgmt', 'POST /pis/:id/submit (422 PRE_PI_CHECKLIST)', '/invoices/:id');
s6('6/CK/yes', 'Pre-PI checklist complete: YES → PI approval', 'mgmt', 'POST /pis/:id/submit', '/invoices/:id');
s6('6/D1/no', 'Advance received OR credit approved: NO → SO on hold, customer reminder, escalation by the clock engine', 'mgmt', 'POST /sales-orders · tickClocks', '/orders/:id');
s6('6/D1/yes', 'Advance received OR credit approved: YES → order confirmation and SO', 'mgmt', 'POST /pis/:id/payments · POST /credit-checks/:id/decide', '/invoices/:id');
s6('6/G11/yes', 'Gate G11: dealer over limit or portal deactivated → hard stop on the SO', 'system', 'POST /sales-orders (422 GUARD_BLOCKED G11)', '/orders/:id');
s6('6/G11/override', 'G11 override needs Accounts then Management approval', 'mgmt', 'POST /credit-overrides · POST /approvals/:id/decide', '/approvals');
s6('6/G11/no', 'Gate G11 clear → create sales order', 'system', 'POST /sales-orders', '/orders/:id');

/* ───────── 7 · after dispatch ───────── */
const s7 = sec('7 After dispatch');
s7('7/B', 'Reserve serials by batch (FIFO) against SO lines', 'system', 'POST /dispatches', '/dispatch/:id');
s7('7/C/fail-replace', 'Dispatch compliance fails: hard stop → replace the serial', 'system', 'POST /dispatches/:id/evaluate · POST /dispatches/:id/serials', '/dispatch/:id');
s7('7/C/fail-override', 'Dispatch compliance fails: hard stop → approved override (compliance lane)', 'mgmt', 'POST /dispatches/:id/compliance-override · POST /approvals/:id/decide', '/dispatch/:id · /approvals');
s7('7/C/pass', 'Dispatch compliance passes → dispatch note, invoice chain, e-way bill / e-invoice status', 'system', 'POST /dispatches/:id/dispatch · PATCH /dispatches/:id/einvoice · GET /dispatches/:id/note', '/dispatch/:id');
s7('7/E', 'Installation: vendor of record, geo-tagged photos, installation certificate', 'distributor', 'POST /installations · POST /installations/:id/photos · POST /installations/:id/certificate', '/post-sale');
s7('7/F', 'DISCOM commissioning clock starts at certificate submission (15 days)', 'system', 'POST /installations/:id/certificate', '/post-sale');
s7('7/G', 'DISCOM meter, commissioning; regulation version by commissioning date', 'distributor', 'POST /installations/:id/commission', '/post-sale');
s7('7/H/yes', 'Within 15 days: YES → no breach', 'system', 'POST /installations/:id/commission', '/post-sale');
s7('7/H/no', 'Within 15 days: NO → deemed-clock breach logged and escalated with evidence', 'system', 'tickClocks → discom.deemed_breach', '/post-sale · /notifications');
s7('7/I', 'DISCOM inspection approval', 'distributor', 'PATCH /discom-applications/:id · POST /subsidy-claims/:id/discom-approval', '/post-sale');
s7('7/J', 'Subsidy claim readiness (bank proof, photos, inspection approval, e-token)', 'mgmt', 'POST /subsidy-claims · PATCH /subsidy-claims/:id', '/post-sale');
s7('7/K', 'CFA release clock (15 days from DISCOM approval); legacy cohort deadline 30-Nov-2026 work-list', 'system', 'POST /subsidy-claims/:id/discom-approval · GET /subsidy-claims/worklist', '/post-sale');
s7('7/L', 'Subsidy received (release)', 'mgmt', 'POST /subsidy-claims/:id/release', '/post-sale');
s7('7/M', 'Loan track: bank, status, rejection code, co-applicant, document checklist', 'mgmt', 'POST|PATCH /loans · GET /loans/summary', '/post-sale');
s7('7/N', 'Close dealer receivable, release subsidy-linked exposure', 'mgmt', 'POST /subsidy-claims/:id/release · GET /credit-position/:dealerId', '/dealers/:id');
s7('7/O', 'Installed-base register: warranty end, 5-year O&M', 'distributor', 'GET /installations/om-register', '/post-sale');
s7('7/P', 'Warranty or RMA ticket with brand claim number, cost bearer, TAT clock', 'distributor', 'POST /warranty-tickets · PATCH /warranty-tickets/:id', '/post-sale');
s7('7/Q', 'Dealer complaint / MNRE SOP notice', 'customer', 'POST /sop-cases', '/dealers/:id');
s7('7/R', 'SOP tracker: reply 8 d, reminder 15 d, show-cause 15 d, deactivation 1 month, appeal 30 d', 'system', 'POST /sop-cases/:id/transition', '/dealers/:id');
s7('7/R-G11', 'SOP deactivation feeds gate G11', 'system', 'GET /credit-position/:dealerId · POST /compliance/preview', '/dealers/:id');

/* ───────── 8 · compliance engine ───────── */
const s8 = sec('8 Gate evaluation');
s8('8/R1/no', 'Rule verified and active: NO → ADVISORY only, never blocks', 'system', 'POST /quotes/:id/evaluate · POST /rules/:id/activate', '/quotes/:id · /admin/rules');
s8('8/VERD/hard', 'Condition violated, hard rule → HARD STOP', 'system', 'POST /quotes/:id/evaluate', '/quotes/:id');
s8('8/VERD/soft', 'Condition violated, soft rule → WARNING', 'system', 'POST /quotes/:id/evaluate', '/quotes/:id');
s8('8/VERD/pass', 'Condition not violated → PASS', 'system', 'POST /compliance/preview', '/quotes/:id');
s8('8/SAVE', 'Findings stored with the rule ids used', 'system', 'GET /quotes/:id (rule_ids_used, findings)', '/quotes/:id');
s8('8/OUT', 'Any hard stop left: YES → Blocked / NO → Proceed', 'system', 'POST /quotes/:id/evaluate · POST /dispatches/:id/dispatch', '/quotes/:id · /dispatch/:id');

/* ───────── 9 · consent and messaging ───────── */
const s9 = sec('9 Consent and messaging');
s9('9/BLK', 'BLOCK G1: log reason, notify owner', 'system', 'POST /leads/:id/messages (422 CONSENT_BLOCKED)', '/leads/:id');
s9('9/W2', 'WhatsApp free-form session message inside the 24 h window', 'distributor', 'POST /leads/:id/messages', '/leads/:id');
s9('9/W4', 'WhatsApp template with category recorded', 'distributor', 'POST /leads/:id/messages', '/leads/:id');
s9('9/SM', 'SMS with DLT template id and header', 'distributor', 'POST /leads/:id/messages', '/leads/:id');
s9('9/CL', 'Call logged', 'distributor', 'POST /leads/:id/messages', '/leads/:id');
s9('9/OPT', 'STOP / opt-out: optout_suppress_until set, propagated to distributor and dealer, one-click withdrawal logged', 'system', 'POST /webhooks/whatsapp · POST /leads/:id/consents/withdraw', '/leads/:id');

/* ───────── 10 · escalation matrix and conversion gates ───────── */
const s10 = sec('10 Escalation and conversion gates');
s10('10/T1', 'Escalation trigger: unaccepted lead (Distributor → DSM → Sales Manager)', 'system', 'tickClocks', '/notifications');
s10('10/T2', 'Escalation trigger: overdue follow-up (owner → DSM → Sales Manager → Management)', 'system', 'tickClocks', '/notifications');
s10('10/T3', 'Escalation trigger: pending approval', 'system', 'tickClocks (approval clocks)', '/approvals');
s10('10/T4', 'Escalation trigger: pending payment or credit', 'system', 'tickClocks (payment_reminder)', '/orders/:id');
s10('10/T5', 'Escalation trigger: no customer response (quote follow-up)', 'system', 'tickClocks (quote_followup)', '/quotes/:id');
s10('10/X1', 'Research additions to the DSM: DISCOM breach, legacy CFA near 30-Nov, dealer deactivated / under SOP, stale non-List-II stock', 'system', 'tickClocks · jobs · GET /dashboards/*', '/reports · /notifications');
s10('10a/gates', 'Six conversion gates counted by the funnel dashboard', 'system', 'GET /dashboards/funnel', '/reports');

/* ───────── 11 · state diagrams ───────── */
const s11a = sec('11.1 Lead lifecycle');
for (const [id, label] of [['New', 'New: captured with consent record'], ['Validated', 'Validated: checks passed / manager override'], ['Duplicate', 'Duplicate: match found'], ['Merged', 'Merged into existing'], ['Unassigned', 'Unassigned: no eligible distributor'],
  ['Assigned', 'Assigned: auto-assign'], ['Accepted', 'Accepted within SLA'], ['Reassigned', 'Reassigned: SLA missed'], ['Rejected', 'Rejected by distributor'], ['Contacted', 'Contacted (step 8)'], ['Qualified', 'Qualified (steps 9 and 11)'],
  ['SiteVisit', 'Site visit (step 14)'], ['Opportunity', 'Opportunity: three confirmations true'], ['Nurture', 'Nurture: not qualified / recycled'], ['Lost', 'Lost: reason recorded'], ['Won', 'Won: sales order created']] as const) {
  s11a(`L/${id}`, label, 'system', 'lead status transitions via the lead, site, opportunity and order endpoints', '/leads (kanban)');
}
const s11b = sec('11.2 Quotation lifecycle');
for (const [id, label] of [['Draft', 'Draft'], ['ComplianceCheck', 'ComplianceCheck: evaluate'], ['Blocked', 'Blocked: hard stop found'], ['PriceReview', 'PriceReview: no hard stop'], ['PendingApproval', 'PendingApproval: lanes open'],
  ['Approved', 'Approved: all lanes approve / none needed'], ['Rejected', 'Rejected: any lane rejects'], ['Sent', 'Sent'], ['Negotiation', 'Negotiation'], ['Accepted', 'Accepted: step 27'], ['Revised', 'Revised: step 26 new version'],
  ['RequoteRequired', 'RequoteRequired: rule or price changed'], ['Expired', 'Expired: validity passed']] as const) {
  s11b(`Q/${id}`, label, 'sales', 'quote endpoints (see section 5)', '/quotes/:id');
}
const s11c = sec('11.3 Clock states');
for (const [id, label] of [['Running', 'Running: start trigger fires'], ['Warned', 'Warned: 70 % of the time used'], ['Escalated1', 'Escalated 1: 100 % reached, owner → DSM'], ['Escalated2', 'Escalated 2: DSM → Sales Manager'],
  ['Escalated3', 'Escalated 3: → Management'], ['Met', 'Met: completion event'], ['Cancelled', 'Cancelled: entity cancelled'], ['Breached', 'Breached: logged permanently']] as const) {
  s11c(`K/${id}`, label, 'system', 'tickClocks · GET /clocks', '/ (home) · /notifications');
}

export const FLOW_NODES: readonly FlowNode[] = nodes;

/* ───────── registry ───────── */
interface Proof { what: string; actor: Actor; test: string }
const proofs = new Map<string, Proof[]>();

/** Record that the current test asserted `what` for diagram node `id`, performed by `actor` (a seeded role, `system` or `customer`). Fails on unknown ids and on actors the legend does not allow. */
export function covers(id: string, what: string, actor: Actor = 'system'): void {
  const node = nodes.find((n) => n.id === id);
  if (!node) throw new Error(`covers(): "${id}" is not a node of Solar CRM flow diagrams.md (see FLOW_NODES)`);
  // a second seeded user of the same role (distributor_user_b, dealer_user_2 ...) is the same legend role
  const role = (actor as string).replace(/^(distributor_user|dealer_user)_[a-z0-9]+$/, '$1') as Actor;
  if (!LEGEND_ROLES[node.legend].includes(role)) throw new Error(`covers(${id}): ${actor} is not an allowed actor for ${LEGEND_LABEL[node.legend]}. Allowed: ${LEGEND_ROLES[node.legend].join(', ')}`);
  const test = expect.getState().currentTestName ?? '(unknown test)';
  const list = proofs.get(id) ?? [];
  list.push({ what, actor, test });
  proofs.set(id, list);
}

export const uncovered = (): string[] => nodes.filter((n) => !proofs.has(n.id)).map((n) => n.id);
export const proofCount = (): number => [...proofs.values()].reduce((a, b) => a + b.length, 0);

const esc = (s: string) => s.replace(/\|/g, '\\|');
const short = (s: string, n = 150) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Markdown for docs/FLOW_TRACEABILITY.md, generated from the registry. Deterministic (no dates) so it only changes when the flow or its tests change. */
export function traceabilityMarkdown(): string {
  const lines: string[] = [
    '# Flow traceability',
    '',
    'Generated by `apps/api/test/e2e/flow.test.ts` (last test, "every diagram node has an assertion") from the coverage registry in `apps/api/test/e2e/flowCoverage.ts`. **Do not edit by hand** - run `cd apps/api && npx vitest run test/e2e/flow.test.ts` to refresh it.',
    '',
    'Specification: `Solar CRM flow diagrams.md` (the 34 numbered steps of section 1, the extension nodes N0a/N0b/X1-X5/N3a/N3b/N4a/P1-P5, every decision node with both branches in sections 2-9, the escalation matrix of section 10, the conversion gates of 10a and the state diagrams of 11.1-11.3).',
    'Each row names the API endpoint(s) that implement the node, the web route (intended screen - the web app is still being built, see `apps/web/src/routes.tsx`), the role that performed it in the test and the test that proves it.',
    '',
    `Nodes: ${nodes.length} - proofs recorded: ${proofCount()} - nodes without proof: ${uncovered().length}.`,
    '',
  ];
  let current = '';
  for (const n of nodes) {
    if (n.section !== current) {
      current = n.section;
      lines.push('', `## ${current}`, '', '| Node | What the diagram says | Legend group | API endpoint(s) | Web route | Performed by | Proof (test name) | What is asserted |', '|---|---|---|---|---|---|---|---|');
    }
    const p = proofs.get(n.id) ?? [];
    const first = p[0];
    const tests = [...new Set(p.map((x) => x.test))].map((t) => `\`${esc(short(t, 110))}\``).join('<br>');
    const what = p.map((x) => esc(short(x.what, 140))).join('<br>');
    const actors = [...new Set(p.map((x) => x.actor))].join(', ');
    lines.push(`| ${esc(n.id)} | ${esc(n.label)} | ${LEGEND_LABEL[n.legend]} | ${esc(n.endpoints)} | ${esc(n.web)} | ${first ? actors : '-'} | ${first ? tests : '**MISSING**'} | ${first ? what : '-'} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Writes the traceability document next to the other docs (only when the content changed). Returns the path. */
export function writeTraceability(): string {
  const file = resolve(__dirname, '../../../../docs/FLOW_TRACEABILITY.md');
  const text = traceabilityMarkdown();
  if (!existsSync(file) || readFileSync(file, 'utf8') !== text) writeFileSync(file, text, 'utf8');
  return file;
}

/** Plain-text coverage table for the test log: node, performed by, number of assertions, first proving test. */
export function coverageTable(): string {
  const rows = nodes.map((n) => {
    const p = proofs.get(n.id) ?? [];
    return `${n.id.padEnd(18)} ${[...new Set(p.map((x) => x.actor))].join(',').padEnd(34)} ${String(p.length).padStart(2)}  ${p[0] ? short(p[0].test, 100) : 'MISSING'}`;
  });
  return ['node               performed by                       n  first proving test', ...rows].join('\n');
}
