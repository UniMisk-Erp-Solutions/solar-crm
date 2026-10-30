/**
 * ERP export of PI, sales-order and invoice (dispatch) lines as CSV or XLSX in two documented layouts:
 *   - "tally": TallyPrime voucher import (one row per voucher line; header columns repeat on every row)
 *   - "sap":   SAP Business One marketing-document import (Data Transfer Workbench style; one row per document line)
 * The column lists below are the contract; docs/ERP_EXPORT.md documents each column.
 */
import type ExcelJS from 'exceljs';
import { GSTIN_UNREGISTERED, isSerialTracked, type Address, type ErpDoc, type ErpFormat, type ErpLayout, type ProformaInvoice, type SalesOrder, type SalesOrderLine, type Sku } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { scopedWhere } from '../auth/access';
import type { Where } from '../db/types';
import { audit } from '../lib/audit';
import { istEndOfDay, istMidnight } from '../lib/time';
import { PI_ISSUED_STATUSES } from './piService';
import { round2 } from './orderSupport';

export const TALLY_COLUMNS = [
  'Voucher Date', 'Voucher Type Name', 'Voucher Number', 'Reference No', 'Reference Date', 'Party Ledger Name', 'Party GSTIN', 'Place of Supply', 'Billing Address', 'Shipping Address',
  'Sales Ledger', 'Line No', 'Stock Item Name', 'HSN/SAC', 'Quantity', 'UOM', 'Rate', 'Discount %', 'Amount', 'GST Rate %', 'CGST Amount', 'SGST Amount', 'IGST Amount', 'Freight Amount', 'Serial Numbers', 'Narration',
] as const;
export const SAP_COLUMNS = [
  'DocNum', 'DocDate', 'DocDueDate', 'TaxDate', 'CardCode', 'CardName', 'NumAtCard', 'GSTIN', 'BillToAddress', 'ShipToAddress', 'PlaceOfSupply', 'PaymentTerms', 'Comments', 'DocCurrency',
  'LineNum', 'ItemCode', 'ItemDescription', 'HSNCode', 'Quantity', 'UoMCode', 'UnitPrice', 'DiscountPercent', 'TaxCode', 'LineTotal', 'CGSTAmount', 'SGSTAmount', 'IGSTAmount', 'FreightExpense', 'WarehouseCode', 'SerialNumbers', 'U_CRM_Ref',
] as const;
const NUMERIC = new Set(['Quantity', 'Rate', 'Discount %', 'Amount', 'GST Rate %', 'CGST Amount', 'SGST Amount', 'IGST Amount', 'Freight Amount', 'Line No',
  'LineNum', 'UnitPrice', 'DiscountPercent', 'LineTotal', 'CGSTAmount', 'SGSTAmount', 'IGSTAmount', 'FreightExpense']);

/** Ledger and warehouse names the accountant maps once in the ERP; change here if the chart of accounts differs. */
export const ERP_DEFAULTS = { sales_ledger: 'Solar Sales', warehouse_code: 'WH01', currency: 'INR' } as const;

interface ErpLine { no: number; code: string; name: string; hsn: string; qty: number; uom: string; rate: number; discount_pct: number; amount: number; gst_rate: number | null; cgst: number; sgst: number; igst: number; freight: number; serials: string }
interface ErpVoucher {
  doc: ErpDoc; number: string; date: string; due_date: string; reference: string; reference_date: string; party_code: string; party_name: string; gstin: string; billing: string; shipping: string;
  place_of_supply: string; payment_terms: string; narration: string; crm_ref: string; lines: ErpLine[];
}
export interface ErpTable { columns: string[]; rows: (string | number)[][]; vouchers: number }

const oneLine = (a: Address | null | undefined): string => (a ? [a.line1, a.line2, a.city, `${a.state} - ${a.pincode}`].filter(Boolean).join(', ') : '');
const ddmmyyyy = (d: string): string => (d ? `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}` : '');
const yyyymmdd = (d: string): string => d.replace(/-/g, '');
const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();
const istDate = (iso: string): string => new Date(new Date(iso).getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
const itemCode = (sku: Sku | undefined, no: number): string => (sku ? `${sku.make}-${sku.model}${sku.variant ? `-${sku.variant}` : ''}`.toUpperCase().replace(/\s+/g, '-') : `ITEM-${no}`);

function split(amount: number, rate: number | null, intra: boolean): { cgst: number; sgst: number; igst: number } {
  const tax = round2((amount * (rate ?? 0)) / 100);
  return intra ? { cgst: round2(tax / 2), sgst: round2(tax / 2), igst: 0 } : { cgst: 0, sgst: 0, igst: tax };
}

interface RawLine { sku_id: string | null; description: string; hsn: string | null; gst_rate: number | null; qty: number; unit_price: number; line_total: number; ordered_qty: number; serials: string }

function toLines(raw: RawLine[], skus: Sku[], intra: boolean, freight: number): ErpLine[] {
  return raw.map((l, i) => {
    const sku = skus.find((s) => s.id === l.sku_id);
    const amount = l.ordered_qty > 0 ? round2((l.line_total * l.qty) / l.ordered_qty) : l.line_total;
    const gross = l.qty * l.unit_price;
    return {
      no: i + 1, code: itemCode(sku, i + 1), name: l.description, hsn: l.hsn ?? sku?.hsn ?? '', qty: l.qty, uom: sku?.uom ?? 'NOS', rate: l.unit_price,
      discount_pct: gross > 0 && amount < gross ? round2((1 - amount / gross) * 100) : 0, amount, gst_rate: l.gst_rate, ...split(amount, l.gst_rate, intra), freight: i === 0 ? freight : 0, serials: l.serials,
    };
  });
}

async function loadVouchers(ctx: AppContext, doc: ErpDoc, from?: string, to?: string): Promise<ErpVoucher[]> {
  const org = await ctx.db.table('organizations').get(ctx.org_id);
  const orgState = norm(org?.state);
  const range = (col: string): Where => (from || to ? { [col]: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {});

  const pisAll: ProformaInvoice[] = doc === 'pi' ? await ctx.db.table('proforma_invoices').all(await scopedWhere(ctx, 'proforma_invoices', { status: PI_ISSUED_STATUSES, ...range('issue_date') })) : [];
  const base = (pi: ProformaInvoice) => ({
    party_code: `CUST-${(pi.customer_id ?? pi.id).slice(0, 8).toUpperCase()}`, party_name: pi.legal_name ?? '', gstin: pi.gstin && pi.gstin !== GSTIN_UNREGISTERED ? pi.gstin : '',
    billing: oneLine(pi.billing_address), shipping: oneLine(pi.shipping_address), place_of_supply: pi.shipping_address?.state ?? pi.billing_address?.state ?? '', payment_terms: pi.payment_terms ?? '',
  });
  const intraOf = (pi: ProformaInvoice): boolean => norm(pi.shipping_address?.state ?? pi.billing_address?.state) === orgState && orgState !== '';

  if (doc === 'pi') {
    const lines = await ctx.db.table('proforma_invoice_lines').all({ pi_id: pisAll.map((p) => p.id) }, { orderBy: { col: 'sort_order' } });
    const skus = await ctx.db.table('skus').all({ id: [...new Set(lines.map((l) => l.sku_id).filter((x): x is string => !!x))] });
    const quotes = await ctx.db.table('quotations').all({ id: pisAll.map((p) => p.quote_id) });
    return pisAll.sort((a, b) => a.pi_no.localeCompare(b.pi_no)).map((pi) => ({
      doc, number: pi.pi_no, date: pi.issue_date ?? '', due_date: pi.valid_till ?? '', reference: quotes.find((q) => q.id === pi.quote_id)?.quote_no ?? '', reference_date: '', ...base(pi),
      narration: `Proforma invoice ${pi.pi_no}; funding: consumer ${round2(pi.consumer_share)}, loan ${round2(pi.loan_share)}, subsidy receivable ${round2(pi.subsidy_receivable)}`, crm_ref: pi.id,
      lines: toLines(lines.filter((l) => l.pi_id === pi.id).map((l) => ({ ...l, ordered_qty: l.qty, serials: '' })), skus, intraOf(pi), pi.freight),
    }));
  }

  const soWhere: Where = doc === 'so' ? { status: { nin: ['draft', 'cancelled'] }, ...range('order_date') } : { status: { nin: ['draft', 'cancelled'] } };
  const sos: SalesOrder[] = await ctx.db.table('sales_orders').all(await scopedWhere(ctx, 'sales_orders', soWhere));
  const soLines: SalesOrderLine[] = await ctx.db.table('sales_order_lines').all({ so_id: sos.map((s) => s.id) }, { orderBy: { col: 'sort_order' } });
  const skus = await ctx.db.table('skus').all({ id: [...new Set(soLines.map((l) => l.sku_id).filter((x): x is string => !!x))] });
  const pis = await ctx.db.table('proforma_invoices').all({ id: sos.map((s) => s.pi_id) });

  if (doc === 'so') {
    return sos.sort((a, b) => a.so_no.localeCompare(b.so_no)).flatMap((so) => {
      const pi = pis.find((p) => p.id === so.pi_id);
      if (!pi) return [];
      return [{
        doc, number: so.so_no, date: so.order_date, due_date: '', reference: so.customer_po_no ?? '', reference_date: so.customer_po_date ?? '', ...base(pi),
        narration: `Sales order ${so.so_no} against ${pi.pi_no}; customer PO ${so.customer_po_no ?? '-'}`, crm_ref: so.id,
        lines: toLines(soLines.filter((l) => l.so_id === so.id).map((l) => ({ ...l, ordered_qty: l.qty, serials: '' })), skus, intraOf(pi), pi.freight),
      }];
    });
  }

  // invoice: one voucher per shipped dispatch; bulk (non-serialised) lines ride with the order's first shipped dispatch
  const dispatchWhere: Where = { so_id: sos.map((s) => s.id), status: ['dispatched', 'delivered'] };
  const allShipped = await ctx.db.table('dispatches').all(dispatchWhere, { orderBy: { col: 'dispatched_at' } });
  const inRange = allShipped.filter((d) => {
    if (!d.dispatched_at) return false;
    if (from && d.dispatched_at < istMidnight(from).toISOString()) return false;
    if (to && d.dispatched_at > istEndOfDay(to).toISOString()) return false;
    return true;
  });
  const links = await ctx.db.table('dispatch_serials').all({ dispatch_id: inRange.map((d) => d.id) });
  const serials = await ctx.db.table('inventory_serials').all({ id: links.map((l) => l.serial_id) });
  return inRange.sort((a, b) => (a.invoice_no ?? a.dispatch_no).localeCompare(b.invoice_no ?? b.dispatch_no)).flatMap((d) => {
    const so = sos.find((s) => s.id === d.so_id);
    const pi = pis.find((p) => p.id === so?.pi_id);
    if (!so || !pi) return [];
    const first = allShipped.find((x) => x.so_id === so.id)?.id === d.id;
    const mine = links.filter((l) => l.dispatch_id === d.id);
    const raw: RawLine[] = [];
    for (const l of soLines.filter((x) => x.so_id === so.id)) {
      const lineLinks = mine.filter((m) => m.so_line_id === l.id);
      const tracked = isSerialTracked(skus.find((k) => k.id === l.sku_id)?.category);
      if (tracked) {
        if (!lineLinks.length) continue;
        raw.push({ ...l, qty: lineLinks.length, ordered_qty: l.qty, serials: lineLinks.map((m) => serials.find((s) => s.id === m.serial_id)?.serial ?? '').filter(Boolean).sort().join(' ') });
      } else if (first) raw.push({ ...l, ordered_qty: l.qty, serials: '' });
    }
    return [{
      doc, number: d.invoice_no ?? d.dispatch_no, date: istDate(d.dispatched_at!), due_date: '', reference: so.so_no, reference_date: so.order_date, ...base(pi),
      narration: `Invoice for dispatch ${d.dispatch_no}; order ${so.so_no}; vehicle ${d.vehicle_no ?? '-'}; e-way bill ${d.ewb_no ?? 'pending'}`, crm_ref: d.id,
      lines: toLines(raw, skus, intraOf(pi), first ? pi.freight : 0),
    }];
  });
}

const VOUCHER_TYPE: Record<ErpDoc, string> = { pi: 'Proforma Invoice', so: 'Sales Order', invoice: 'Sales' };

export function buildTable(layout: ErpLayout, vouchers: ErpVoucher[]): ErpTable {
  const rows: (string | number)[][] = [];
  for (const v of vouchers) {
    for (const l of v.lines) {
      if (layout === 'tally') {
        rows.push([
          ddmmyyyy(v.date), VOUCHER_TYPE[v.doc], v.number, v.reference, ddmmyyyy(v.reference_date), v.party_name, v.gstin, v.place_of_supply, v.billing, v.shipping,
          ERP_DEFAULTS.sales_ledger, l.no, l.name, l.hsn, l.qty, l.uom, l.rate, l.discount_pct, l.amount, l.gst_rate ?? '', l.cgst, l.sgst, l.igst, l.freight, l.serials, v.narration,
        ]);
      } else {
        rows.push([
          v.number, yyyymmdd(v.date), yyyymmdd(v.due_date || v.date), yyyymmdd(v.date), v.party_code, v.party_name, v.reference, v.gstin, v.billing, v.shipping, v.place_of_supply, v.payment_terms, v.narration, ERP_DEFAULTS.currency,
          l.no - 1, l.code, l.name, l.hsn, l.qty, l.uom, l.rate, l.discount_pct, l.gst_rate === null ? '' : `GST${l.gst_rate}`, l.amount, l.cgst, l.sgst, l.igst, l.freight, ERP_DEFAULTS.warehouse_code, l.serials, v.crm_ref,
        ]);
      }
    }
  }
  return { columns: [...(layout === 'tally' ? TALLY_COLUMNS : SAP_COLUMNS)], rows, vouchers: vouchers.length };
}

const csvCell = (v: string | number): string => {
  const s = typeof v === 'number' ? String(v) : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (t: ErpTable): Buffer => Buffer.from([t.columns, ...t.rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n', 'utf8');

export async function toXlsx(t: ErpTable, sheet: string): Promise<Buffer> {
  const { default: ExcelRuntime } = await import('exceljs'); // loaded only when a workbook is built (keeps the function start-up fast)
  const wb = new ExcelRuntime.Workbook();
  wb.creator = 'Future Solar CRM';
  const ws = wb.addWorksheet(sheet);
  ws.columns = t.columns.map((c) => ({ header: c, key: c, width: Math.min(40, Math.max(12, c.length + 4)) }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
  for (const r of t.rows) ws.addRow(r);
  t.columns.forEach((c, i) => { if (NUMERIC.has(c)) ws.getColumn(i + 1).numFmt = '#,##0.00'; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export interface ErpExportResult { filename: string; contentType: string; body: Buffer; rows: number; vouchers: number }

export async function exportErp(ctx: AppContext, q: { doc: ErpDoc; layout: ErpLayout; format: ErpFormat; from?: string; to?: string }): Promise<ErpExportResult> {
  const vouchers = await loadVouchers(ctx, q.doc, q.from, q.to);
  const table = buildTable(q.layout, vouchers);
  const stem = `erp-${q.doc}-${q.layout}${q.from ? `-from-${q.from}` : ''}${q.to ? `-to-${q.to}` : ''}`;
  const body = q.format === 'csv' ? toCsv(table) : await toXlsx(table, `${VOUCHER_TYPE[q.doc]} lines`);
  await audit(ctx, { action: 'erp.export', detail: { doc: q.doc, layout: q.layout, format: q.format, from: q.from ?? null, to: q.to ?? null, vouchers: table.vouchers, rows: table.rows.length } });
  return {
    filename: `${stem}.${q.format}`, rows: table.rows.length, vouchers: table.vouchers, body,
    contentType: q.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}
