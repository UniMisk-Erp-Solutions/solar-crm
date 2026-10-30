import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { SAP_COLUMNS, TALLY_COLUMNS } from '../../src/services/erpExport';
import { ADDR, GSTIN, fakes, orderEnv, readyForDispatch, seedStock, seedWorld } from './fixtures';

/** minimal RFC 4180 parser (quoted fields, doubled quotes) */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const binary = (res: import('superagent').Response, cb: (e: Error | null, b: Buffer) => void) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };
const exportCsv = async (env: ReturnType<typeof orderEnv>['env'], qs: string, role = 'accounts') => {
  const r = await env.as(role).get(`/api/v1/exports/erp?${qs}`);
  return { res: r, rows: parseCsv(r.text ?? '') };
};

async function shippedWorld(shipState?: string) {
  const { env } = orderEnv(fakes());
  const w = await seedWorld(env, shipState ? { shipping: { ...ADDR, state: shipState, city: 'Pune', pincode: '411001' } } : {});
  await seedStock(env, w);
  const rd = await readyForDispatch(env, w);
  const line = { module: rd.so.lines[0]!.id, inverter: rd.so.lines[1]!.id };
  const d = (await env.as('dispatch').post('/api/v1/dispatches').send({ so_id: rd.soId, planned_at: '2026-10-28', lines: [{ so_line_id: line.module, qty: 4 }, { so_line_id: line.inverter, qty: 1 }] })).body.data;
  const shipped = await env.as('dispatch').post(`/api/v1/dispatches/${d.id}/dispatch`).send({ vehicle_no: 'GJ01AB1234', invoice_no: 'FS/INV/26/0100' });
  expect(shipped.status).toBe(200);
  return { env, w, rd, dispatch: shipped.body.data };
}

describe('ERP export (Tally and SAP Business One layouts)', () => {
  it('Tally layout: header is the documented column list, one row per PI line, GST split CGST/SGST intra-state', async () => {
    const { env, rd } = await shippedWorld();
    const { res, rows } = await exportCsv(env, 'doc=pi&layout=tally&format=csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('erp-pi-tally.csv');
    expect(rows[0]).toEqual([...TALLY_COLUMNS]);
    expect(TALLY_COLUMNS).toContain('Voucher Number');
    const data = rows.slice(1).filter((r) => r.length > 1);
    expect(data).toHaveLength(3);
    const col = (name: string, r: string[]) => r[(TALLY_COLUMNS as readonly string[]).indexOf(name)];
    const first = data[0]!;
    expect(col('Voucher Type Name', first)).toBe('Proforma Invoice');
    expect(col('Voucher Number', first)).toBe(rd.pi.pi_no);
    expect(col('Voucher Date', first)).toBe('26-10-2026');
    expect(col('Party Ledger Name', first)).toBe('Patel Textiles Pvt Ltd');
    expect(col('Party GSTIN', first)).toBe(GSTIN);
    expect(col('Place of Supply', first)).toBe('Gujarat');
    expect(col('Billing Address', first)).toBe('12 Satellite Road, Ahmedabad, Gujarat - 380015');
    expect(col('Stock Item Name', first)).toBe('Waaree 545 Wp DCR module');
    expect([col('Quantity', first), col('Rate', first), col('Amount', first), col('GST Rate %', first)]).toEqual(['10', '30000', '300000', '5']);
    expect([col('CGST Amount', first), col('SGST Amount', first), col('IGST Amount', first)]).toEqual(['7500', '7500', '0']);
    expect(col('Freight Amount', first)).toBe('8000');            // header-level amounts only on the first line
    expect(col('Freight Amount', data[1]!)).toBe('0');
    expect(col('Line No', data[2]!)).toBe('3');
  });

  it('Tally layout: inter-state supply is taxed as IGST', async () => {
    const { env } = await shippedWorld('Maharashtra');
    const { rows } = await exportCsv(env, 'doc=so&layout=tally&format=csv');
    const col = (name: string, r: string[]) => r[(TALLY_COLUMNS as readonly string[]).indexOf(name)];
    const first = rows[1]!;
    expect(col('Voucher Type Name', first)).toBe('Sales Order');
    expect(col('Place of Supply', first)).toBe('Maharashtra');
    expect([col('CGST Amount', first), col('SGST Amount', first), col('IGST Amount', first)]).toEqual(['0', '0', '15000']);
    expect(col('Reference No', first)).toBe('PO-7781');
  });

  it('SAP Business One layout: documented columns, YYYYMMDD dates, tax code per line, CRM reference', async () => {
    const { env, rd } = await shippedWorld();
    const { res, rows } = await exportCsv(env, 'doc=so&layout=sap&format=csv');
    expect(res.status).toBe(200);
    expect(rows[0]).toEqual([...SAP_COLUMNS]);
    const col = (name: string, r: string[]) => r[(SAP_COLUMNS as readonly string[]).indexOf(name)];
    const data = rows.slice(1).filter((r) => r.length > 1);
    expect(data).toHaveLength(3);
    const first = data[0]!;
    expect(col('DocNum', first)).toBe(rd.so.so_no);
    expect(col('DocDate', first)).toBe('20261026');
    expect(col('CardName', first)).toBe('Patel Textiles Pvt Ltd');
    expect(col('CardCode', first)).toMatch(/^CUST-[0-9A-F]{8}$/);
    expect(col('NumAtCard', first)).toBe('PO-7781');
    expect(col('GSTIN', first)).toBe(GSTIN);
    expect(col('ItemCode', first)).toBe('WAAREE-WS-545');
    expect([col('LineNum', first), col('Quantity', first), col('UnitPrice', first), col('LineTotal', first), col('TaxCode', first), col('CGSTAmount', first), col('SGSTAmount', first)]).toEqual(['0', '10', '30000', '300000', 'GST5', '7500', '7500']);
    expect(col('DocCurrency', first)).toBe('INR');
    expect(col('U_CRM_Ref', first)).toBe(rd.soId);
    expect(col('FreightExpense', first)).toBe('8000');
  });

  it('invoice export: one voucher per shipped dispatch with only what shipped, serials and the bulk kit on the first consignment', async () => {
    const { env, dispatch } = await shippedWorld();
    const tally = await exportCsv(env, 'doc=invoice&layout=tally&format=csv');
    const col = (name: string, r: string[]) => r[(TALLY_COLUMNS as readonly string[]).indexOf(name)];
    const data = tally.rows.slice(1).filter((r) => r.length > 1);
    expect(data).toHaveLength(3); // modules (4), inverter (1) and the structure kit
    expect(data.every((r) => col('Voucher Number', r) === 'FS/INV/26/0100' && col('Voucher Type Name', r) === 'Sales')).toBe(true);
    const modules = data[0]!;
    expect([col('Quantity', modules), col('Amount', modules)]).toEqual(['4', '120000']);
    expect(col('Serial Numbers', modules)).toBe('JAN-001 JAN-002 JAN-003 JAN-004');
    expect(col('Narration', modules)).toContain(dispatch.dispatch_no);
    expect(col('Quantity', data[2]!)).toBe('1');

    const sap = await exportCsv(env, 'doc=invoice&layout=sap&format=csv');
    expect(sap.rows[0]).toEqual([...SAP_COLUMNS]);
    expect(sap.rows.slice(1).filter((r) => r.length > 1)).toHaveLength(3);
    expect(sap.rows[1]![(SAP_COLUMNS as readonly string[]).indexOf('DocNum')]).toBe('FS/INV/26/0100');
  });

  it('exports xlsx with the same columns and numeric cells', async () => {
    const { env } = await shippedWorld();
    const r = await env.as('accounts').get('/api/v1/exports/erp?doc=pi&layout=sap&format=xlsx').buffer(true).parse(binary);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('spreadsheetml');
    const buf = r.body as Buffer;
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    expect((ws.getRow(1).values as unknown[]).slice(1)).toEqual([...SAP_COLUMNS]);
    expect(ws.rowCount).toBe(4);
    expect(ws.getRow(2).getCell(SAP_COLUMNS.indexOf('LineTotal') + 1).value).toBe(300000);
  });

  it('filters by date range, validates the query and is limited to finance roles', async () => {
    const { env } = await shippedWorld();
    expect((await exportCsv(env, 'doc=pi&from=2026-10-26&to=2026-10-26')).rows.slice(1).filter((r) => r.length > 1)).toHaveLength(3);
    expect((await exportCsv(env, 'doc=pi&from=2026-10-27')).rows.slice(1).filter((r) => r.length > 1)).toHaveLength(0);
    expect((await exportCsv(env, 'doc=so&to=2026-10-25')).rows.slice(1).filter((r) => r.length > 1)).toHaveLength(0);
    expect((await exportCsv(env, 'doc=invoice&from=2026-10-26&to=2026-10-26')).rows.slice(1).filter((r) => r.length > 1)).toHaveLength(3);
    expect((await exportCsv(env, 'doc=invoice&from=2026-10-27')).rows.slice(1).filter((r) => r.length > 1)).toHaveLength(0);
    expect((await env.as('accounts').get('/api/v1/exports/erp?doc=grn')).status).toBe(422);
    expect((await env.as('accounts').get('/api/v1/exports/erp?doc=pi&layout=oracle')).status).toBe(422);
    expect((await env.as('dispatch').get('/api/v1/exports/erp?doc=pi')).status).toBe(403);
    expect((await env.as('dealer_user').get('/api/v1/exports/erp?doc=pi')).status).toBe(403);
    // the export itself is audited
    expect(await env.ctx('admin').db.table('audit_log').count({ action: 'erp.export' })).toBeGreaterThanOrEqual(5);
  });
});
