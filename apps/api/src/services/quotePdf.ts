/**
 * Branded quotation PDF (pdfkit): navy #1F3864 and gold #BF9000, Helvetica.
 * Helvetica is the PDF base-14 font that is metric-compatible with Arial, so layouts match the Arial brand font without embedding a font file.
 * The base-14 fonts have no rupee glyph, so amounts print as "Rs. 12,34,567" (Indian digit grouping).
 */
import PDFDocument from 'pdfkit';
import { SEGMENT_LABEL, formatDate, groupIndian, type Finding, type Quotation } from '@solar/shared';

const NAVY = '#1F3864';
const GOLD = '#BF9000';
const INK = '#16233F';
const GREY = '#55627F';
const RED = '#B3261E';
const AMBER = '#9A5B00';
const LIGHT = '#EEF1F8';

export interface PdfLine { sl: number; description: string; hsn: string | null; qty: number; uom: string; unit_price: number; discount_pct: number; taxable: number; gst_rate: number | null; gst_amount: number; total: number }
export interface PdfModule { label: string; almm_list1: boolean; almm_list2: boolean; dcr_verified: boolean; bis: string; snapshot_date: string | null }
export interface QuotePdfData {
  quote: Quotation; customerName: string; siteLine: string | null; ownerName: string | null; dealerName: string | null; orgName: string; orgGstin: string | null;
  lines: PdfLine[]; modules: PdfModule[]; findings: Finding[]; clauses: { key: string; title: string; body: string }[]; draft: boolean; generatedAt: Date;
}

/** Defaults printed only when the organisation has no `clause.*` templates configured. */
export const FALLBACK_CLAUSES: { key: string; title: string; body: string }[] = [
  { key: 'clause.price_validity', title: 'Validity', body: 'This offer is valid until the validity date shown above. Prices are based on the price snapshot of the quote date.' },
  { key: 'clause.duty_gst_change', title: 'Duty and GST change', body: 'Prices exclude any change in customs duty, anti-dumping duty or GST after the quote date; such a change will be charged or credited at actuals.' },
  { key: 'clause.almm_change', title: 'ALMM / regulatory change', body: 'If a change in the ALMM lists, BIS or scheme conditions makes a quoted product ineligible before delivery, the product will be substituted with an eligible one and the price re-confirmed.' },
];

const money = (n: number): string => `Rs. ${groupIndian(n, Number.isInteger(n) ? 0 : 2)}`;

/** Standard PDF fonts are WinAnsi: replace the few characters we use elsewhere that are outside it. */
export const pdfSafe = (s: string | null | undefined): string =>
  (s ?? '').replace(/\u00A0/g, ' ').replace(/₹/g, 'Rs.').replace(/→/g, '>').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/[^ -~¡-ÿ–—‘’“”•]/g, '?');

export function renderQuotePdf(d: QuotePdfData): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: `Quotation ${d.quote.quote_no} v${d.quote.version}`, Author: d.orgName, Subject: 'Techno-commercial quotation', Creator: 'Future Solar CRM' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const L = doc.page.margins.left;
    const W = doc.page.width - L - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom - 30;
    const q = d.quote;
    const text = (s: string, x: number, y: number, o: PDFKit.Mixins.TextOptions & { font?: string; size?: number; color?: string } = {}) => {
      doc.font(o.font ?? 'Helvetica').fontSize(o.size ?? 9).fillColor(o.color ?? INK).text(pdfSafe(s), x, y, { width: o.width, align: o.align, lineBreak: o.lineBreak });
    };
    const ensure = (h: number) => { if (doc.y + h > bottom()) { doc.addPage(); doc.y = doc.page.margins.top; } };
    const heading = (s: string) => {
      ensure(40);
      const y = doc.y + 8;
      doc.rect(L, y, 3, 14).fill(GOLD);
      text(s.toUpperCase(), L + 9, y + 2, { font: 'Helvetica-Bold', size: 10, color: NAVY, width: W });
      doc.y = y + 22;
    };

    /* header band */
    doc.rect(0, 0, doc.page.width, 78).fill(NAVY);
    doc.rect(0, 78, doc.page.width, 3).fill(GOLD);
    text('Future Solar', L, 22, { font: 'Helvetica-Bold', size: 22, color: '#FFFFFF', width: 300 });
    text('TECHNO-COMMERCIAL QUOTATION', L, 50, { font: 'Helvetica-Bold', size: 9, color: '#E8C547', width: 300 });
    text(`${q.quote_no}  ·  Version ${q.version}`, L + W - 240, 26, { font: 'Helvetica-Bold', size: 12, color: '#FFFFFF', width: 240, align: 'right' });
    text(`Date ${formatDate(d.generatedAt)}  ·  Valid till ${formatDate(q.validity_date)}`, L + W - 240, 46, { size: 9, color: '#E8C547', width: 240, align: 'right' });
    doc.y = 96;

    if (d.draft) {
      text('DRAFT — not issued to the customer. Compliance and approvals are still open.', L, doc.y, { font: 'Helvetica-Bold', size: 9, color: RED, width: W });
      doc.moveDown(1);
    }

    /* parties */
    const colW = (W - 20) / 2;
    const top = doc.y;
    text('PREPARED FOR', L, top, { font: 'Helvetica-Bold', size: 8, color: GOLD, width: colW });
    text(d.customerName, L, top + 12, { font: 'Helvetica-Bold', size: 11, width: colW });
    text(d.siteLine ?? '—', L, top + 28, { size: 9, color: GREY, width: colW });
    text(`Place of supply: ${q.place_of_supply ?? '—'}`, L, top + 52, { size: 9, color: GREY, width: colW });
    const x2 = L + colW + 20;
    text('PROJECT', x2, top, { font: 'Helvetica-Bold', size: 8, color: GOLD, width: colW });
    text(`${SEGMENT_LABEL[q.segment]}  ·  ${q.kw} kW`, x2, top + 12, { font: 'Helvetica-Bold', size: 11, width: colW });
    text(`Expected commissioning: ${q.expected_commissioning_date ? formatDate(q.expected_commissioning_date) : 'to be confirmed'}`, x2, top + 28, { size: 9, color: GREY, width: colW });
    text(`Prepared by: ${d.ownerName ?? d.orgName}${d.dealerName ? `  ·  Channel partner: ${d.dealerName}` : ''}`, x2, top + 40, { size: 9, color: GREY, width: colW });
    doc.y = top + 78;

    /* lines */
    heading('Bill of quantities');
    const cols = [
      { k: 'sl', t: '#', w: 20, a: 'left' as const }, { k: 'desc', t: 'Description / HSN', w: 150, a: 'left' as const }, { k: 'qty', t: 'Qty', w: 38, a: 'right' as const },
      { k: 'rate', t: 'Unit price', w: 62, a: 'right' as const }, { k: 'disc', t: 'Disc %', w: 36, a: 'right' as const }, { k: 'tax', t: 'Taxable', w: 66, a: 'right' as const },
      { k: 'gst', t: 'GST', w: 54, a: 'right' as const }, { k: 'tot', t: 'Total', w: W - 20 - 150 - 38 - 62 - 36 - 66 - 54, a: 'right' as const },
    ];
    const tableHead = () => {
      const y = doc.y;
      doc.rect(L, y, W, 18).fill(NAVY);
      let x = L;
      for (const c of cols) { text(c.t, x + 3, y + 5, { font: 'Helvetica-Bold', size: 8, color: '#FFFFFF', width: c.w - 6, align: c.a }); x += c.w; }
      doc.y = y + 18;
    };
    tableHead();
    d.lines.forEach((ln, i) => {
      const desc = `${ln.description}${ln.hsn ? `\nHSN ${ln.hsn}` : '\nHSN not recorded'}`;
      doc.font('Helvetica').fontSize(9);
      const h = Math.max(24, doc.heightOfString(pdfSafe(desc), { width: cols[1]!.w - 6 }) + 8);
      if (doc.y + h > bottom()) { doc.addPage(); doc.y = doc.page.margins.top; tableHead(); }
      const y = doc.y;
      if (i % 2 === 1) doc.rect(L, y, W, h).fill(LIGHT);
      const vals: Record<string, string> = {
        sl: String(ln.sl), desc, qty: `${ln.qty} ${ln.uom}`, rate: money(ln.unit_price), disc: ln.discount_pct ? `${ln.discount_pct}%` : '—', tax: money(ln.taxable),
        gst: ln.gst_rate === null ? 'not set' : `${ln.gst_rate}%\n${money(ln.gst_amount)}`, tot: money(ln.total),
      };
      let x = L;
      for (const c of cols) { text(vals[c.k] ?? '', x + 3, y + 4, { size: 9, width: c.w - 6, align: c.a }); x += c.w; }
      doc.y = y + h;
    });
    doc.moveTo(L, doc.y).lineTo(L + W, doc.y).strokeColor(NAVY).lineWidth(0.8).stroke();

    /* totals */
    ensure(130);
    const tx = L + W - 230;
    let ty = doc.y + 8;
    const row = (label: string, value: string, bold = false, color = INK) => {
      text(label, tx, ty, { font: bold ? 'Helvetica-Bold' : 'Helvetica', size: bold ? 11 : 9, color, width: 120 });
      text(value, tx + 110, ty, { font: bold ? 'Helvetica-Bold' : 'Helvetica', size: bold ? 11 : 9, color, width: 120, align: 'right' });
      ty += bold ? 20 : 15;
    };
    row('Subtotal', money(q.subtotal));
    if (q.discount_amount > 0) row(`Discount (${q.discount_pct}%)`, `- ${money(q.discount_amount)}`);
    row('Taxable value', money(q.subtotal - q.discount_amount));
    row('GST', money(q.tax_total));
    if (q.freight > 0) row('Freight', money(q.freight));
    doc.moveTo(tx, ty).lineTo(tx + 230, ty).strokeColor(GOLD).lineWidth(1).stroke();
    ty += 5;
    row('Total payable', money(q.total), true, NAVY);
    doc.y = ty + 4;

    /* tax per line summary by rate */
    const byRate = new Map<string, { taxable: number; tax: number }>();
    for (const ln of d.lines) {
      const k = ln.gst_rate === null ? 'Rate not set' : `${ln.gst_rate}%`;
      const e = byRate.get(k) ?? { taxable: 0, tax: 0 };
      e.taxable += ln.taxable; e.tax += ln.gst_amount;
      byRate.set(k, e);
    }
    heading('Tax summary');
    for (const [k, v] of byRate) { ensure(14); text(`${k}   taxable ${money(v.taxable)}   GST ${money(v.tax)}`, L, doc.y, { size: 9, width: W }); doc.moveDown(0.3); }
    if (d.lines.some((l) => l.gst_rate === null)) text('Lines marked "not set" carry no GST rate yet; tax on them is excluded until the tax position is approved.', L, doc.y + 2, { size: 8, color: AMBER, width: W });

    /* funding split */
    heading('Funding split');
    const fund: [string, number, string][] = [
      ['Central financial assistance (CFA)', q.cfa_entitlement, 'Indicative entitlement under the scheme rules in force on the commissioning date; payable to the consumer after DISCOM approval.'],
      ['State share', q.state_share, 'Only where a state scheme is active.'],
      ['Bank loan', q.loan_share, q.loan_rate_pct !== null ? `Indicative rate ${q.loan_rate_pct}% as on ${q.loan_rate_source_date ? formatDate(q.loan_rate_source_date) : 'the quote date'}; subject to bank approval.` : 'Subject to bank approval.'],
      ['Consumer contribution', q.consumer_share, 'Balance payable by the consumer.'],
    ];
    for (const [label, amt, note] of fund) {
      ensure(26);
      const y = doc.y;
      text(label, L, y, { font: 'Helvetica-Bold', size: 9, width: 190 });
      text(money(amt), L + 190, y, { size: 9, width: 90, align: 'right' });
      text(note, L + 290, y, { size: 8, color: GREY, width: W - 290 });
      doc.y = Math.max(doc.y, y + 22);
    }

    /* compliance summary */
    heading('Compliance summary');
    const label = q.compliance_status === 'clear' ? 'Clear — no open compliance issues' : q.compliance_status === 'warnings' ? 'Warnings noted (see below)' : q.compliance_status === 'blocked' ? 'BLOCKED — not issuable' : 'Not yet evaluated';
    text(`Status: ${label}`, L, doc.y, { font: 'Helvetica-Bold', size: 9, color: q.compliance_status === 'blocked' ? RED : q.compliance_status === 'warnings' ? AMBER : NAVY, width: W });
    doc.moveDown(0.6);
    if (d.modules.length) {
      for (const m of d.modules) {
        ensure(26);
        text(`${m.label}`, L, doc.y, { font: 'Helvetica-Bold', size: 9, width: W });
        text(`ALMM List-I: ${m.almm_list1 ? 'Yes' : 'No'}   ·   ALMM List-II (cells): ${m.almm_list2 ? 'Yes' : 'No'}   ·   DCR: ${m.dcr_verified ? 'Verified' : 'Not verified'}   ·   BIS: ${m.bis}   ·   Listing checked on ${m.snapshot_date ? formatDate(m.snapshot_date) : 'not recorded'}`, L, doc.y + 1, { size: 8, color: GREY, width: W });
        doc.moveDown(0.5);
      }
    }
    const shown = d.findings.filter((f) => f.severity !== 'info');
    if (!shown.length) text('No warnings or hard stops were raised for this quotation.', L, doc.y, { size: 9, color: GREY, width: W });
    for (const f of shown) {
      ensure(24);
      const tag = f.severity === 'hard_stop' ? (f.overridden ? 'Hard stop — overridden by Compliance' : 'Hard stop') : f.overridden ? 'Warning — overridden' : f.advisory ? 'Advisory' : 'Warning';
      text(`${f.gate}  ${tag}: ${f.message}`, L, doc.y, { size: 8, color: f.severity === 'hard_stop' && !f.overridden ? RED : AMBER, width: W });
      doc.moveDown(0.3);
    }

    /* clauses and terms */
    heading('Terms and conditions');
    const clauses = d.clauses.length ? d.clauses : FALLBACK_CLAUSES;
    if (q.payment_terms) { text(`Payment terms: ${q.payment_terms}`, L, doc.y, { size: 9, width: W }); doc.moveDown(0.5); }
    clauses.forEach((c, i) => {
      doc.font('Helvetica').fontSize(8);
      ensure(doc.heightOfString(pdfSafe(c.body), { width: W - 14 }) + 16);
      text(`${i + 1}.  ${c.title}`, L, doc.y, { font: 'Helvetica-Bold', size: 9, width: W });
      text(c.body, L + 14, doc.y + 1, { size: 8, color: GREY, width: W - 14 });
      doc.moveDown(0.5);
    });
    text(`Quotation valid until ${formatDate(q.validity_date)}. Price snapshot taken on ${formatDate(q.price_snapshot_at)}.`, L, doc.y + 4, { size: 8, color: GREY, width: W });

    /* footer on every page */
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const mb = doc.page.margins.bottom;
      doc.page.margins.bottom = 0; // writing in the bottom margin must not spawn a new page
      const fy = doc.page.height - 34;
      doc.moveTo(L, fy - 4).lineTo(L + W, fy - 4).strokeColor(GOLD).lineWidth(0.8).stroke();
      doc.font('Helvetica').fontSize(7.5).fillColor(GREY);
      doc.text(pdfSafe(`${d.orgName}${d.orgGstin ? `  ·  GSTIN ${d.orgGstin}` : ''}  ·  ${q.quote_no} v${q.version}`), L, fy, { width: W - 80, lineBreak: false });
      doc.text(`Page ${i - range.start + 1} of ${range.count}`, L + W - 80, fy, { width: 80, align: 'right', lineBreak: false });
      doc.page.margins.bottom = mb;
    }
    doc.end();
  });
}
