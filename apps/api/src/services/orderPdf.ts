/**
 * Branded PDFs for the order flow (pdfkit): the proforma invoice and the dispatch note.
 * Palette: navy #1F3864, gold #BF9000, Helvetica (the built-in Arial-metric face). Amounts are written "Rs." because the
 * built-in PDF fonts have no rupee glyph.
 */
import { formatDate, groupIndian, type Address, type Dispatch, type EinvoiceStatus, type InvoiceChainLink, type ProformaInvoice, type ProformaInvoiceLine } from '@solar/shared';

const NAVY = '#1F3864';
const GOLD = '#BF9000';
const INK = '#16233F';
const MUTED = '#5B6577';
const BAND = '#EEF2F8';
const PAGE_BOTTOM = 770;

const inr = (n: number): string => `Rs. ${groupIndian(n, 2)}`;
const addressLines = (a: Address | null | undefined): string[] => (a ? [a.line1, a.line2 ?? '', `${a.city}${a.district && a.district !== a.city ? `, ${a.district}` : ''}`, `${a.state} - ${a.pincode}`].filter(Boolean) : ['—']);

type Doc = PDFKit.PDFDocument;

async function render(title: string, build: (doc: Doc) => void): Promise<Buffer> {
  const { default: PDFDocument } = await import('pdfkit'); // loaded only when a PDF is made (keeps the function start-up fast)
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: title, Author: 'Future Solar CRM' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try { build(doc); doc.end(); } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
  });
}

function banner(doc: Doc, org: { name: string; legal_name: string; gstin: string | null; address: Address | null }, title: string): void {
  doc.rect(0, 0, doc.page.width, 78).fill(NAVY);
  doc.rect(0, 78, doc.page.width, 4).fill(GOLD);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(19).text(org.name, 40, 22, { width: 330 });
  doc.font('Helvetica').fontSize(8.5).fillColor('#D9E2F3').text(`${org.legal_name}${org.gstin ? `  |  GSTIN ${org.gstin}` : ''}`, 40, 48, { width: 330 });
  doc.font('Helvetica-Bold').fontSize(15).fillColor(GOLD).text(title, 330, 28, { width: 225, align: 'right' });
  doc.fillColor(INK);
  doc.y = 100;
}

function kv(doc: Doc, x: number, y: number, w: number, label: string, value: string): number {
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(label.toUpperCase(), x, y, { width: w });
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(value || '—', x, doc.y + 1, { width: w });
  return doc.y + 6;
}

function party(doc: Doc, x: number, y: number, w: number, heading: string, name: string, gstin: string | null, address: Address | null): number {
  doc.rect(x, y, w, 15).fill(BAND);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(NAVY).text(heading.toUpperCase(), x + 6, y + 4, { width: w - 12 });
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(name || '—', x + 6, y + 21, { width: w - 12 });
  doc.font('Helvetica').fontSize(9).fillColor(INK);
  for (const l of addressLines(address)) doc.text(l, x + 6, doc.y, { width: w - 12 });
  if (gstin) doc.font('Helvetica').fontSize(9).text(`GSTIN: ${gstin}`, x + 6, doc.y + 2, { width: w - 12 });
  return doc.y + 6;
}

interface Col { key: string; label: string; x: number; w: number; align?: 'left' | 'right' | 'center' }
function table(doc: Doc, cols: Col[], rows: Record<string, string>[], startY: number): number {
  let y = startY;
  const header = (yy: number): number => {
    doc.rect(40, yy, 515, 18).fill(NAVY);
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF');
    for (const c of cols) doc.text(c.label, c.x + 3, yy + 5, { width: c.w - 6, align: c.align ?? 'left' });
    return yy + 18;
  };
  y = header(y);
  rows.forEach((r, idx) => {
    doc.font('Helvetica').fontSize(8.5);
    const h = Math.max(...cols.map((c) => doc.heightOfString(r[c.key] ?? '', { width: c.w - 6 }))) + 8;
    if (y + h > PAGE_BOTTOM) { doc.addPage(); y = header(40); }
    if (idx % 2 === 1) doc.rect(40, y, 515, h).fill(BAND);
    doc.fillColor(INK);
    for (const c of cols) doc.text(r[c.key] ?? '', c.x + 3, y + 4, { width: c.w - 6, align: c.align ?? 'left' });
    y += h;
  });
  doc.moveTo(40, y).lineTo(555, y).strokeColor(GOLD).lineWidth(1).stroke();
  return y + 6;
}

function footer(doc: Doc, text: string): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(text, 40, 790, { width: 400, lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, 455, 790, { width: 100, align: 'right', lineBreak: false });
  }
}

export interface PiPdfData {
  org: { name: string; legal_name: string; gstin: string | null; address: Address | null };
  pi: ProformaInvoice; lines: ProformaInvoiceLine[]; quote_no: string | null; place_of_supply: string | null; paid_amount: number;
}

export function renderPiPdf(d: PiPdfData): Promise<Buffer> {
  const { pi } = d;
  return render(`Proforma Invoice ${pi.pi_no}`, (doc) => {
    banner(doc, d.org, 'PROFORMA INVOICE');
    let y = 96;
    const left = kv(doc, 40, y, 160, 'PI number', pi.pi_no);
    const mid = kv(doc, 215, y, 160, 'Issue date', pi.issue_date ? formatDate(pi.issue_date) : 'Draft — not issued');
    const right = kv(doc, 390, y, 165, 'Valid till', pi.valid_till ? formatDate(pi.valid_till) : '—');
    y = Math.max(left, mid, right);
    const l2 = kv(doc, 40, y, 160, 'Quotation', d.quote_no ?? '—');
    const m2 = kv(doc, 215, y, 160, 'Place of supply', d.place_of_supply ?? pi.shipping_address?.state ?? '—');
    const r2 = kv(doc, 390, y, 165, 'Payment terms', pi.payment_terms ?? '—');
    y = Math.max(l2, m2, r2) + 4;
    const a = party(doc, 40, y, 250, 'Bill to', pi.legal_name ?? '', pi.gstin, pi.billing_address);
    const b = party(doc, 305, y, 250, 'Ship to', pi.legal_name ?? '', null, pi.shipping_address);
    y = Math.max(a, b) + 8;

    y = table(doc, [
      { key: 'n', label: '#', x: 40, w: 24 }, { key: 'desc', label: 'Description', x: 64, w: 196 }, { key: 'hsn', label: 'HSN', x: 260, w: 58 },
      { key: 'qty', label: 'Qty', x: 318, w: 40, align: 'right' }, { key: 'rate', label: 'Rate', x: 358, w: 70, align: 'right' },
      { key: 'gst', label: 'GST %', x: 428, w: 44, align: 'right' }, { key: 'amt', label: 'Amount', x: 472, w: 83, align: 'right' },
    ], d.lines.map((l, i) => ({ n: String(i + 1), desc: l.description, hsn: l.hsn ?? '—', qty: String(l.qty), rate: groupIndian(l.unit_price, 2), gst: l.gst_rate === null ? '—' : String(l.gst_rate), amt: groupIndian(l.line_total, 2) })), y);

    if (y > 640) { doc.addPage(); y = 50; }
    const row = (label: string, value: string, bold = false): void => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9.5).fillColor(bold ? NAVY : INK);
      doc.text(label, 330, y, { width: 120 }); doc.text(value, 450, y, { width: 105, align: 'right' }); y += bold ? 18 : 14;
    };
    row('Taxable value', inr(pi.subtotal)); row('Freight', inr(pi.freight)); row('GST', inr(pi.tax_total));
    doc.moveTo(330, y).lineTo(555, y).strokeColor(GOLD).lineWidth(1).stroke(); y += 5;
    row('Total payable', inr(pi.total), true);
    if (d.paid_amount > 0) { row('Received so far', inr(d.paid_amount)); row('Balance', inr(Math.max(0, pi.total - d.paid_amount)), true); }

    y += 10;
    if (y > 640) { doc.addPage(); y = 50; }
    doc.rect(40, y, 515, 15).fill(BAND);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(NAVY).text('FUNDING SPLIT', 46, y + 4);
    y += 22;
    const split: [string, number][] = [['Consumer share', pi.consumer_share], ['Loan share', pi.loan_share], ['Subsidy receivable (CFA + state share)', pi.subsidy_receivable]];
    for (const [label, v] of split) {
      doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(label, 46, y, { width: 300 });
      doc.font('Helvetica-Bold').text(inr(v), 400, y, { width: 155, align: 'right' }); y += 14;
    }
    y += 8;
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text('This is a proforma invoice and not a tax invoice. Subsidy (CFA) is receivable from the government and is not payable by the consumer. Prices and taxes are as on the quotation and may change as per its change clause.', 40, y, { width: 515 });
    footer(doc, `${d.org.name} - ${pi.pi_no}`);
  });
}

export interface DispatchNoteData {
  org: { name: string; legal_name: string; gstin: string | null; address: Address | null };
  dispatch: Dispatch; so_no: string; pi_no: string | null; customer: string; gstin: string | null; ship_to: Address | null;
  vehicle_no: string | null; transporter: string | null; segment: string;
  rows: { serial: string; item: string; batch: string; so_line: string }[];
  einvoice: EinvoiceStatus | null; chain: InvoiceChainLink[];
}

export function renderDispatchNotePdf(d: DispatchNoteData): Promise<Buffer> {
  const { dispatch } = d;
  return render(`Dispatch note ${dispatch.dispatch_no}`, (doc) => {
    banner(doc, d.org, 'DISPATCH NOTE');
    let y = 96;
    const a = kv(doc, 40, y, 160, 'Dispatch no.', dispatch.dispatch_no);
    const b = kv(doc, 215, y, 160, 'Sales order', d.so_no);
    const c = kv(doc, 390, y, 165, 'Dispatched on', dispatch.dispatched_at ? formatDate(dispatch.dispatched_at) : dispatch.planned_at ? `Planned ${formatDate(dispatch.planned_at)}` : '—');
    y = Math.max(a, b, c);
    const a2 = kv(doc, 40, y, 160, 'Invoice no.', dispatch.invoice_no ?? '—');
    const b2 = kv(doc, 215, y, 160, 'Vehicle / transporter', [d.vehicle_no, d.transporter].filter(Boolean).join(' / ') || '—');
    const c2 = kv(doc, 390, y, 165, 'Proforma', d.pi_no ?? '—');
    y = Math.max(a2, b2, c2) + 4;
    const p = party(doc, 40, y, 250, 'Consignee / ship to', d.customer, d.gstin, d.ship_to);
    doc.y = y;
    const eway = dispatch.ewb_no ? dispatch.ewb_no : dispatch.ewb_status === 'manual_pending' ? 'Pending - enter manually' : dispatch.ewb_status.replace('_', ' ');
    const irn = d.einvoice?.irn ? `${d.einvoice.irn.slice(0, 20)}...` : d.einvoice ? `${d.einvoice.status.replace('_', ' ')}` : '—';
    let ry = y;
    ry = kv(doc, 305, ry, 250, 'E-way bill', eway);
    ry = kv(doc, 305, ry, 250, 'E-invoice IRN', irn);
    ry = kv(doc, 305, ry, 250, 'Compliance', dispatch.compliance_status);
    y = Math.max(p, ry) + 6;

    doc.font('Helvetica-Bold').fontSize(9).fillColor(NAVY).text(`Serial numbers dispatched (${d.rows.length})`, 40, y);
    y = table(doc, [
      { key: 'n', label: '#', x: 40, w: 28 }, { key: 'serial', label: 'Serial number', x: 68, w: 150 }, { key: 'item', label: 'Item', x: 218, w: 207 }, { key: 'batch', label: 'Batch', x: 425, w: 130 },
    ], d.rows.map((r, i) => ({ n: String(i + 1), serial: r.serial, item: r.item, batch: r.batch })), y + 14);

    if (d.chain.length) {
      if (y > 680) { doc.addPage(); y = 50; }
      doc.rect(40, y, 515, 15).fill(BAND);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(NAVY).text('INVOICE CHAIN (brand > distributor > dealer > site)', 46, y + 4);
      y += 22;
      for (const l of d.chain) {
        doc.font('Helvetica').fontSize(9).fillColor(INK).text(`${l.from}  >  ${l.to}`, 46, y, { width: 340 });
        doc.font('Helvetica-Bold').text(`${l.invoice_no}  |  ${formatDate(l.date)}`, 390, y, { width: 165, align: 'right' }); y += 14;
      }
    }
    y += 24;
    if (y > 740) { doc.addPage(); y = 60; }
    doc.moveTo(40, y).lineTo(200, y).strokeColor(MUTED).lineWidth(0.5).stroke();
    doc.moveTo(395, y).lineTo(555, y).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text('Dispatched by', 40, y + 3).text('Received by (name, signature, date)', 395, y + 3);
    footer(doc, `${d.org.name} - ${dispatch.dispatch_no}`);
  });
}
