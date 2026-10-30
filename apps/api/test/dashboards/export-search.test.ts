import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { ReportCatalogItem, SearchResponse } from '@solar/shared';
import { INR_FORMAT } from '../../src/services/reportExport';
import { KPI_DEFS } from '../../src/services/kpi/definitions';
import { IDS, ago, dateOffset, id, makeEnv, seeder, type Seeder } from './fixtures';
import type { TestEnv } from '../helpers/env';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** exceljs strips the backslash escapes of a number format when it READS a file back; the written file keeps them (verified in the raw styles.xml). */
const asRead = (fmt: string): string => fmt.replace(/[\\](.)/g, '$1');
type Agent = ReturnType<TestEnv['as']>;
/** Fetch a binary response through supertest. */
async function download(agent: Agent, url: string): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const res = await agent.get(url).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (c: Buffer) => chunks.push(c));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  return { status: res.status, headers: res.headers as Record<string, string>, body: res.body as Buffer };
}
const open = async (buf: Buffer): Promise<ExcelJS.Workbook> => new ExcelJS.Workbook().xlsx.load(buf as unknown as ArrayBuffer);

async function seedSome(s: Seeder) {
  await s.lead(1, { status: 'qualified', segment: 'pmsg_residential', distributor_id: IDS.distributorA, created_at: ago(10) });
  await s.followup(1, 1, { due_at: ago(1), status: 'open' });
  await s.receivable(1, IDS.dealerA1, { distributor_id: IDS.distributorA, amount: 300_000, invoice_date: dateOffset(-30), due_date: dateOffset(-5) });
  await s.receivable(2, IDS.dealerA2, { distributor_id: IDS.distributorA, amount: 2_500_000, invoice_date: dateOffset(-30), due_date: dateOffset(10) });
  await s.db.table('dealers').update(IDS.dealerA2, { credit_limit: 12_345_678 });
}

describe('GET /reports/catalog', () => {
  it('lists every KPI with its definition; internal-only KPIs are hidden from distributor and dealer users', async () => {
    const env = makeEnv();
    const all: ReportCatalogItem[] = (await env.as('management').get('/api/v1/reports/catalog').expect(200)).body.data;
    expect(all).toHaveLength(KPI_DEFS.length);
    expect(all.length).toBeGreaterThanOrEqual(45);
    for (const item of all) {
      expect(item.definition.length).toBeGreaterThan(20);
      expect(item.formula.length).toBeGreaterThan(10);
      expect(item.source_tables.length).toBeGreaterThan(0);
      expect(item.formats).toEqual(['xlsx']);
      expect(item.export_path).toBe(`/reports/export?kpi=${item.key}&format=xlsx`);
    }
    const ext: ReportCatalogItem[] = (await env.as('distributor_user').get('/api/v1/reports/catalog').expect(200)).body.data;
    expect(ext.length).toBeLessThan(all.length);
    const hidden = all.filter((k) => !ext.some((e) => e.key === k.key)).map((k) => k.key).sort();
    expect(hidden).toEqual(['list2_exemption_days_left', 'non_list2_stock_units', 'non_list2_stock_value', 'open_overrides', 'price_change_margin_leakage']);
  });
});

describe('GET /reports/export', () => {
  it('exports a KPI as a branded xlsx with a definition sheet, data sheet and the filters applied', async () => {
    const env = makeEnv();
    await seedSome(seeder(env));
    const res = await download(env.as('accounts'), `/api/v1/reports/export?kpi=dealer_outstanding&format=xlsx&from=${dateOffset(-60)}&to=${dateOffset(0)}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain(XLSX);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="Future-Solar_dealer_outstanding_20261026\.xlsx"$/);

    const wb = await open(res.body);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'KPI definition', 'Data', 'Breakdown', 'Filters applied']);

    // Summary: navy title band, value in Indian-grouped ₹
    const sum = wb.getWorksheet('Summary')!;
    expect(String(sum.getCell('A1').value)).toBe('FUTURE SOLAR — Dealer outstanding');
    expect(sum.getCell('A1').fill).toMatchObject({ fgColor: { argb: 'FF1F3864' } });
    expect(sum.getCell('A2').fill).toMatchObject({ fgColor: { argb: 'FFBF9000' } });
    expect(sum.getCell('B4').value).toBe(2_800_000);
    expect(sum.getCell('B4').numFmt).toBe(asRead(INR_FORMAT));

    // KPI definition sheet carries the registry's text verbatim
    const def = wb.getWorksheet('KPI definition')!;
    const rows = new Map<string, string>();
    def.eachRow((row) => rows.set(String(row.getCell(1).value), String(row.getCell(2).value)));
    const d = KPI_DEFS.find((k) => k.key === 'dealer_outstanding')!;
    expect(rows.get('Key')).toBe('dealer_outstanding');
    expect(rows.get('Definition')).toBe(d.definition);
    expect(rows.get('Formula')).toBe(d.formula);
    expect(rows.get('Source tables')).toBe('dealer_receivables, dealers');
    expect(rows.get('Unit')).toBe('inr');

    // Data sheet: navy header with gold underline, ₹ columns in Indian grouping, one row per dealer
    const data = wb.getWorksheet('Data')!;
    const header = data.getRow(4);
    expect(header.getCell(1).value).toBe('Dealer');
    expect(header.getCell(1).fill).toMatchObject({ fgColor: { argb: 'FF1F3864' } });
    expect(header.getCell(1).font).toMatchObject({ bold: true, color: { argb: 'FFFFFFFF' } });
    expect(header.getCell(1).border).toMatchObject({ bottom: { style: 'medium', color: { argb: 'FFBF9000' } } });
    const limitCol = (header.values as ExcelJS.CellValue[]).indexOf('Credit limit (₹)');
    expect(limitCol).toBeGreaterThan(0);
    const bright = [5, 6, 7].map((r) => data.getRow(r)).find((r) => r.getCell(1).value === 'Bright Roofs')!;
    expect(bright.getCell(limitCol).value).toBe(12_345_678);
    expect(bright.getCell(limitCol).numFmt).toBe(asRead(INR_FORMAT));
    expect(data.rowCount).toBe(4 + 3); // 3 dealers
    expect(data.views[0]).toMatchObject({ state: 'frozen' });

    // Filters sheet
    const f = wb.getWorksheet('Filters applied')!;
    const fr = new Map<string, string>();
    f.eachRow((row) => fr.set(String(row.getCell(1).value), String(row.getCell(2).value)));
    expect(fr.get('From')).toBe('27-Aug-2026');
    expect(fr.get('To')).toBe('26-Oct-2026');
    expect(fr.get('Segment')).toBe('All segments');
    expect(fr.get('Generated by')).toBe('Test accounts — Accounts');
    expect(fr.get('Data scope')).toBe('Whole organisation');
  });

  it('writes dates as real dates formatted DD-MMM-YYYY (IST) and records the filters', async () => {
    const env = makeEnv();
    await seedSome(seeder(env));
    const res = await download(env.as('management'), '/api/v1/reports/export?kpi=overdue_followups&segment=pmsg_residential');
    expect(res.status).toBe(200);
    const wb = await open(res.body);
    const data = wb.getWorksheet('Data')!;
    expect(data.getRow(4).getCell(4).value).toBe('Was due');
    const cell = data.getRow(5).getCell(4);
    expect(cell.value).toBeInstanceOf(Date);
    expect(cell.numFmt).toBe('dd-mmm-yyyy hh:mm');
    // due = 25-Oct-2026 05:00 UTC = 10:30 IST
    expect((cell.value as Date).toISOString()).toBe('2026-10-25T10:30:00.000Z');
    const fr = new Map<string, string>();
    wb.getWorksheet('Filters applied')!.eachRow((row) => fr.set(String(row.getCell(1).value), String(row.getCell(2).value)));
    expect(fr.get('Segment')).toBe('PM Surya Ghar — residential');
  });

  it('every KPI in the catalogue can be exported and opens with the definition sheet', async () => {
    const env = makeEnv();
    await seedSome(seeder(env));
    const agent = env.as('admin');
    for (const def of KPI_DEFS) {
      const res = await download(agent, `/api/v1/reports/export?kpi=${def.key}&format=xlsx`);
      expect(res.status, def.key).toBe(200);
      const wb = await open(res.body);
      expect(wb.worksheets.map((w) => w.name), def.key).toEqual(expect.arrayContaining(['Summary', 'KPI definition', 'Data', 'Filters applied']));
      const rows = new Map<string, string>();
      wb.getWorksheet('KPI definition')!.eachRow((row) => rows.set(String(row.getCell(1).value), String(row.getCell(2).value)));
      expect(rows.get('Key'), def.key).toBe(def.key);
      expect(rows.get('Definition'), def.key).toBe(def.definition);
    }
  }, 120_000);

  it('audits every export', async () => {
    const env = makeEnv();
    await seedSome(seeder(env));
    await download(env.as('accounts'), '/api/v1/reports/export?kpi=dealer_dso_days');
    const rows = await env.ctx('admin').db.table('audit_log').all({ action: 'report.export' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'api', actor_id: IDS.profile('accounts'), detail: { kpi: 'dealer_dso_days', format: 'xlsx' } });
  });

  it('guards: unknown KPI, bad format, internal-only KPI for external users, and own-party data only', async () => {
    const env = makeEnv();
    await seedSome(seeder(env));
    await env.as('admin').get('/api/v1/reports/export?kpi=nope').expect(404);
    await env.as('admin').get('/api/v1/reports/export?kpi=dealer_outstanding&format=csv').expect(422);
    await env.as('admin').get('/api/v1/reports/export').expect(422);
    await env.as('distributor_user').get('/api/v1/reports/export?kpi=non_list2_stock_value').expect(403);
    await env.anon().get('/api/v1/reports/export?kpi=dealer_outstanding').expect(401);

    // dealer A1's user exports the dealer table: only their own dealer, and the scope is stated on the Filters sheet
    const res = await download(env.as('dealer_user'), '/api/v1/reports/export?kpi=dealer_outstanding');
    const wb = await open(res.body);
    const data = wb.getWorksheet('Data')!;
    expect(data.rowCount).toBe(4 + 1);
    expect(data.getRow(5).getCell(1).value).toBe('Sunrise Installers');
    const fr = new Map<string, string>();
    wb.getWorksheet('Filters applied')!.eachRow((row) => fr.set(String(row.getCell(1).value), String(row.getCell(2).value)));
    expect(fr.get('Data scope')).toMatch(/own party/);
  });
});

/* ───────────────────────── search ───────────────────────── */

async function seedSearch(s: Seeder) {
  const A = IDS.distributorA, B = IDS.distributorB;
  await s.lead(1, { name: 'Rajesh Patel', mobile: '+919876543210', email: 'rajesh@example.com', distributor_id: A, city: 'Surat' });
  await s.lead(2, { name: 'Rajesh Shah', mobile: '+919812345678', email: 'shah@example.com', distributor_id: B });
  await s.db.table('customers').insert({ id: id('cust', 1), legal_name: 'Rajesh Traders Pvt Ltd', display_name: 'Rajesh Traders', gstin: '24ABCDE1234F1Z5', customer_type: 'commercial' });
  await s.sku(1, { make: 'Waaree', model: 'WSMD-540', variant: 'Bifacial' });
  await s.opp(1, 1, { name: 'Rajesh Patel 5 kW rooftop', distributor_id: A });
  await s.quote(1, 1, { quote_no: 'QT-100', distributor_id: A }); await s.quote(2, 1, { quote_no: 'QT-200', distributor_id: B });
  await s.pi(1, 1, { pi_no: 'PI-100', distributor_id: A, legal_name: 'Rajesh Traders' });
  await s.so(1, 1, 1, { so_no: 'SO-100', distributor_id: A, customer_po_no: 'PO-77' });
}
const search = async (env: TestEnv, who: string, q: string): Promise<SearchResponse> => (await env.as(who).get(`/api/v1/search?q=${encodeURIComponent(q)}`).expect(200)).body.data;
const group = (r: SearchResponse, key: string) => r.groups.find((g) => g.key === key);

describe('GET /search', () => {
  it('searches across entity types with path links; roles with a need see the mobile number', async () => {
    const env = makeEnv();
    await seedSearch(seeder(env));
    const r = await search(env, 'sales_manager', 'Rajesh');
    expect(r.groups.map((g) => g.key)).toEqual(['leads', 'opportunities', 'customers', 'invoices']);
    expect(group(r, 'leads')!.total).toBe(2);
    const lead = group(r, 'leads')!.hits.find((h) => h.title === 'Rajesh Patel')!;
    expect(lead).toMatchObject({ type: 'lead', path: `/leads/${id('lead', 1)}`, masked: false });
    expect(lead.subtitle).toContain('+919876543210');
    expect(group(r, 'opportunities')!.hits[0]).toMatchObject({ path: `/opportunities/${id('opp', 1)}` });
    expect(group(r, 'customers')!.hits[0]).toMatchObject({ title: 'Rajesh Traders', path: `/customers/${id('cust', 1)}` });
    expect(group(r, 'invoices')!.hits[0]).toMatchObject({ title: 'PI-100', path: `/invoices/${id('pi', 1)}` });

    expect(group(await search(env, 'sales_manager', 'QT-100'), 'quotes')!.hits[0]).toMatchObject({ title: 'QT-100 (v1)', path: `/quotes/${id('quote', 1)}` });
    expect(group(await search(env, 'sales_manager', 'SO-100'), 'sales_orders')!.hits[0]).toMatchObject({ path: `/orders/${id('so', 1)}` });
    expect(group(await search(env, 'sales_manager', 'PO-77'), 'sales_orders')!.hits).toHaveLength(1);
    expect(group(await search(env, 'sales_manager', 'bifacial'), 'skus')!.hits[0]).toMatchObject({ title: 'Waaree WSMD-540 Bifacial', path: `/catalogue?sku=${id('sku', 1)}` });
    expect(group(await search(env, 'sales_manager', 'Sunrise'), 'dealers')!.hits[0]).toMatchObject({ path: `/dealers/${IDS.dealerA1}` });
    expect(group(await search(env, 'sales_manager', 'Beta Energy'), 'distributors')!.hits[0]).toMatchObject({ path: `/distributors/${IDS.distributorB}` });
    // a partial mobile number finds the lead for a role that may see it
    expect(group(await search(env, 'sales_manager', '98765 432'), 'leads')!.hits[0]!.title).toBe('Rajesh Patel');
  });

  it('masks mobile and e-mail for roles without a need, and does not let partial digits be probed', async () => {
    const env = makeEnv();
    await seedSearch(seeder(env));
    const r = await search(env, 'management', 'Rajesh');
    const hits = group(r, 'leads')!.hits;
    expect(hits).toHaveLength(2);
    for (const h of hits) {
      expect(h.masked).toBe(true);
      expect(h.subtitle).not.toMatch(/9876543210|9812345678|rajesh@example|shah@example/);
    }
    expect(hits.find((h) => h.title === 'Rajesh Patel')!.subtitle).toContain('+91 ••••• ••210');
    expect(JSON.stringify(r)).not.toContain('9876543210');

    // partial digits / partial e-mail find nothing for a masked role
    expect(group(await search(env, 'management', '98765'), 'leads')).toBeUndefined();
    expect(group(await search(env, 'management', 'rajesh@'), 'leads')).toBeUndefined();
    // the complete number or address still finds the lead (the user already knows it) — and the result is masked
    const byMobile = group(await search(env, 'management', '9876543210'), 'leads')!.hits;
    expect(byMobile.map((h) => h.title)).toEqual(['Rajesh Patel']);
    expect(byMobile[0]!.masked).toBe(true);
    expect(group(await search(env, 'accounts', 'rajesh@example.com'), 'leads')!.hits.map((h) => h.title)).toEqual(['Rajesh Patel']);
  });

  it('is scope-aware: a distributor user only finds their own party\'s records', async () => {
    const env = makeEnv();
    await seedSearch(seeder(env));
    const r = await search(env, 'distributor_user', 'Rajesh'); // distributor A
    expect(group(r, 'leads')!.hits.map((h) => h.title)).toEqual(['Rajesh Patel']);
    expect(group(r, 'customers')).toBeUndefined(); // customers are not reachable for external users
    expect(group(await search(env, 'distributor_user', 'QT-'), 'quotes')!.hits.map((h) => h.title)).toEqual(['QT-100 (v1)']);
    expect(group(await search(env, 'distributor_user', 'Solar'), 'dealers')).toBeUndefined(); // 'Gamma Solar Dealers' belongs to distributor B
    expect(group(await search(env, 'distributor_user', 'Sunrise'), 'dealers')!.hits).toHaveLength(1);
    expect(group(await search(env, 'distributor_user', 'Energy'), 'distributors')).toBeUndefined();
    expect(group(await search(env, 'distributor_user', 'Alpha'), 'distributors')!.hits).toHaveLength(1);
    // external users still see the (masked-free) mobile of their own leads — they need it to call the customer
    expect(group(r, 'leads')!.hits[0]!.masked).toBe(false);
    // dealer user: only their own dealer
    expect(group(await search(env, 'dealer_user', 'Roofs'), 'dealers')).toBeUndefined();
    expect(group(await search(env, 'dealer_user', 'Sunrise'), 'dealers')!.hits).toHaveLength(1);
    // distributor B's user does not see A's lead
    expect(group(await search(env, IDS.distributorUserB, 'Rajesh'), 'leads')!.hits.map((h) => h.title)).toEqual(['Rajesh Shah']);
  });

  it('returns at most 5 hits per group with the full total, and validates the query', async () => {
    const env = makeEnv();
    const s = seeder(env);
    for (let n = 1; n <= 8; n++) await s.lead(n, { name: `Priya Mehta ${n}`, distributor_id: IDS.distributorA });
    const r = await search(env, 'sales_manager', 'Priya');
    expect(group(r, 'leads')!.hits).toHaveLength(5);
    expect(group(r, 'leads')!.total).toBe(8);
    expect(r.total).toBe(5);
    await env.as('sales_manager').get('/api/v1/search?q=a').expect(422);
    await env.as('sales_manager').get('/api/v1/search').expect(422);
    await env.anon().get('/api/v1/search?q=priya').expect(401);
  });
});
