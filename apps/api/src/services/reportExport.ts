import type ExcelJS from 'exceljs';
import { ROLE_LABEL, SEGMENT_LABEL, formatDateTime, formatDate, type Kpi, type KpiUnit } from '@solar/shared';
import type { AppContext } from '../auth/context';
import type { DetailColumn, DetailCell, KpiDetail } from './kpi/common';
import type { KpiResult } from './kpiService';

/** Brand colours (prompt Section 11 / design brief). ARGB for exceljs. */
const NAVY = 'FF1F3864';
const GOLD = 'FFBF9000';
const WHITE = 'FFFFFFFF';
const LIGHT = 'FFF3F6FB';

/** Indian digit grouping (12,34,567) for Excel — three-section number formats are the only way to get lakh/crore grouping. */
export const INR_FORMAT = '[>=10000000]"₹ "##\\,##\\,##\\,##0;[>=100000]"₹ "##\\,##\\,##0;"₹ "##,##0';
export const INR_FORMAT_PAISE = '[>=10000000]"₹ "##\\,##\\,##\\,##0.00;[>=100000]"₹ "##\\,##\\,##0.00;"₹ "##,##0.00';
const INT_FORMAT = '[>=10000000]##\\,##\\,##\\,##0;[>=100000]##\\,##\\,##0;##,##0';
export const DATE_FORMAT = 'dd-mmm-yyyy';
export const DATETIME_FORMAT = 'dd-mmm-yyyy hh:mm';

const unitFormat = (unit: KpiUnit): string => {
  switch (unit) {
    case 'inr': return INR_FORMAT;
    case 'pct': return '0.0"%"';
    case 'days': return '0.0" days"';
    case 'minutes': return '0.0" min"';
    default: return INT_FORMAT;
  }
};
const columnFormat = (t: DetailColumn['type']): string | undefined => {
  switch (t) {
    case 'inr': return INR_FORMAT;
    case 'pct': return '0.0"%"';
    case 'date': return DATE_FORMAT;
    case 'datetime': return DATETIME_FORMAT;
    case 'days': return '0.0';
    case 'minutes': return '0.0';
    case 'int': return INT_FORMAT;
    case 'number': return '#,##0.00';
    default: return undefined;
  }
};

const IST_MS = 5.5 * 3_600_000;
/** An ISO instant → a Date whose UTC fields equal the IST wall-clock (Excel has no time zones). */
const istWall = (iso: string): Date | null => { const t = Date.parse(iso); return Number.isNaN(t) ? null : new Date(t + IST_MS); };
const toExcelDate = (v: string, withTime: boolean): Date | string => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00Z`);
  const w = istWall(v);
  if (!w) return v;
  return withTime ? w : new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()));
};
const cellValue = (v: DetailCell, type: DetailColumn['type']): ExcelJS.CellValue => {
  if (v === null || v === undefined) return null;
  if (type === 'date' || type === 'datetime') return typeof v === 'string' ? toExcelDate(v, type === 'datetime') : v;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return v;
};

const style = {
  title: { font: { name: 'Arial', bold: true, size: 16, color: { argb: WHITE } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } } },
  sub: { font: { name: 'Arial', size: 10, color: { argb: WHITE }, bold: true }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: GOLD } } },
  head: { font: { name: 'Arial', bold: true, size: 10, color: { argb: WHITE } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } } },
  body: { font: { name: 'Arial', size: 10 } },
} as const;

function brandBand(ws: ExcelJS.Worksheet, title: string, subtitle: string, cols: number): void {
  ws.mergeCells(1, 1, 1, cols);
  ws.mergeCells(2, 1, 2, cols);
  const t = ws.getCell(1, 1); t.value = title; t.font = style.title.font; t.fill = style.title.fill; t.alignment = { vertical: 'middle' };
  const s = ws.getCell(2, 1); s.value = subtitle; s.font = style.sub.font; s.fill = style.sub.fill; s.alignment = { vertical: 'middle', wrapText: true };
  ws.getRow(1).height = 28; ws.getRow(2).height = 20;
}

function headerRow(ws: ExcelJS.Worksheet, rowNo: number, labels: string[]): void {
  const r = ws.getRow(rowNo);
  labels.forEach((l, i) => {
    const c = r.getCell(i + 1);
    c.value = l; c.font = style.head.font; c.fill = style.head.fill;
    c.alignment = { vertical: 'middle', wrapText: true };
    c.border = { bottom: { style: 'medium', color: { argb: GOLD } } };
  });
  r.height = 22;
}

function fitColumns(ws: ExcelJS.Worksheet, headers: string[], rows: ExcelJS.CellValue[][], min = 12, max = 60): void {
  headers.forEach((h, i) => {
    let w = h.length + 2;
    for (const r of rows.slice(0, 200)) { const v = r[i]; const len = v instanceof Date ? 20 : v === null || v === undefined ? 0 : String(v).length; if (len + 2 > w) w = len + 2; }
    ws.getColumn(i + 1).width = Math.min(max, Math.max(min, w));
  });
}

/** Writes a branded table (header row at `startRow`) with per-column formats, freeze panes and an auto-filter. */
function writeTable(ws: ExcelJS.Worksheet, startRow: number, columns: DetailColumn[], rows: Record<string, DetailCell>[], opts: { freeze?: boolean } = {}): void {
  headerRow(ws, startRow, columns.map((c) => c.label));
  const values = rows.map((r) => columns.map((c) => cellValue(r[c.key] ?? null, c.type)));
  values.forEach((vals, ri) => {
    const row = ws.getRow(startRow + 1 + ri);
    vals.forEach((v, ci) => {
      const cell = row.getCell(ci + 1);
      cell.value = v; cell.font = style.body.font;
      const fmt = columnFormat(columns[ci]!.type);
      if (fmt && v !== null) cell.numFmt = fmt;
      if (ri % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } };
      if (typeof v === 'number') cell.alignment = { horizontal: 'right' };
    });
  });
  fitColumns(ws, columns.map((c) => c.label), values);
  if (opts.freeze) ws.views = [{ state: 'frozen', ySplit: startRow }];
  if (rows.length) ws.autoFilter = { from: { row: startRow, column: 1 }, to: { row: startRow, column: columns.length } };
}

/** A KPI's breakdown as a table: label, value (in the KPI's unit) and any per-row extras. */
function breakdownTable(kpi: Kpi): { columns: DetailColumn[]; rows: Record<string, DetailCell>[] } | null {
  if (!kpi.breakdown?.length) return null;
  const extras = [...new Set(kpi.breakdown.flatMap((b) => Object.keys(b).filter((k) => k !== 'label' && k !== 'value' && k !== 'key')))];
  const valueType: DetailColumn['type'] = kpi.unit === 'inr' ? 'inr' : kpi.unit === 'pct' ? 'pct' : kpi.unit === 'days' ? 'days' : kpi.unit === 'minutes' ? 'minutes' : 'int';
  const columns: DetailColumn[] = [{ key: 'label', label: 'Item', type: 'text' }, { key: 'value', label: kpi.label, type: valueType }];
  const extraType = (k: string): DetailColumn['type'] => (/amount|value|outstanding|limit/.test(k) ? 'inr' : /^(valid_till|date)$/.test(k) ? 'date' : 'number');
  for (const e of extras) columns.push({ key: e, label: e.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), type: extraType(e) });
  const rows = kpi.breakdown.map((b) => {
    const r: Record<string, DetailCell> = { label: b.label, value: b.value };
    for (const e of extras) { const v = b[e]; r[e] = v === undefined ? null : v; }
    return r;
  });
  return { columns, rows };
}

export interface BuiltReport { buffer: Buffer; filename: string; rows: number; sheets: string[] }

export async function buildReportWorkbook(ctx: AppContext, result: KpiResult): Promise<BuiltReport> {
  const { def, kpi, detail, run } = result;
  const f = run.filters;
  const { default: ExcelRuntime } = await import('exceljs'); // loaded only when a workbook is built (keeps the function start-up fast)
  const wb = new ExcelRuntime.Workbook();
  wb.creator = 'Future Solar CRM'; wb.created = ctx.now(); wb.title = def.label; wb.company = 'Future Solar';
  const generated = formatDateTime(ctx.now());
  const subtitle = `Generated ${generated} IST by ${ctx.user.full_name} (${ROLE_LABEL[ctx.user.role]}) · Period ${formatDate(f.from)} to ${formatDate(f.to)}`;

  /* ── Summary ── */
  const sum = wb.addWorksheet('Summary');
  brandBand(sum, `FUTURE SOLAR — ${def.label}`, subtitle, 3);
  sum.getColumn(1).width = 30; sum.getColumn(2).width = 28; sum.getColumn(3).width = 70;
  const sumRows: [string, ExcelJS.CellValue, string | undefined][] = [['Value', kpi.value, unitFormat(kpi.unit)]];
  if (kpi.secondary) sumRows.push([kpi.secondary.label, kpi.secondary.value, unitFormat(kpi.secondary.unit)]);
  if (kpi.target) sumRows.push([`Target (${kpi.target.direction === 'at_least' ? 'at least' : 'at most'}, ${kpi.target.label.toLowerCase()})`, kpi.target.value, unitFormat(kpi.unit)], ['Target met', kpi.target.met === null ? 'No data' : kpi.target.met ? 'Yes' : 'No', undefined]);
  sumRows.push(['What this means', kpi.definition, undefined]);
  if (kpi.note) sumRows.push(['Note', kpi.note, undefined]);
  sumRows.forEach(([k, v, fmt], i) => {
    const r = sum.getRow(4 + i);
    r.getCell(1).value = k; r.getCell(1).font = { name: 'Arial', bold: true, size: 10, color: { argb: NAVY } };
    const c = r.getCell(2); c.value = v; c.font = style.body.font; c.alignment = { horizontal: 'left', vertical: 'top', wrapText: typeof v === 'string' };
    if (fmt && typeof v === 'number') c.numFmt = fmt;
    if (typeof v === 'string' && v.length > 30) { sum.mergeCells(4 + i, 2, 4 + i, 3); r.height = Math.max(18, Math.ceil(v.length / 90) * 15); }
  });

  /* ── KPI definition ── */
  const defWs = wb.addWorksheet('KPI definition');
  brandBand(defWs, `KPI definition — ${def.label}`, 'How this number is calculated. Source: Future Solar CRM KPI registry (docs/KPI_DEFINITIONS.md)', 2);
  defWs.getColumn(1).width = 26; defWs.getColumn(2).width = 100;
  headerRow(defWs, 4, ['Field', 'Detail']);
  const defRows: [string, string][] = [
    ['Key', def.key], ['Label', def.label], ['Dashboard', def.dashboard], ['Unit', def.unit], ['Definition', def.definition], ['Formula', def.formula],
    ['Source tables', def.sources.join(', ')], ['Exclusions', def.exclusions.length ? def.exclusions.join('; ') : 'None'],
    ['Target', def.target ? `${def.target.direction === 'at_least' ? 'At least' : 'At most'} ${kpi.target?.value ?? def.target.fallback} — ${def.target.label} (rule ${def.target.rule}; advisory, never blocks anything)` : 'None set'],
  ];
  defRows.forEach(([k, v], i) => {
    const r = defWs.getRow(5 + i);
    r.getCell(1).value = k; r.getCell(1).font = { name: 'Arial', bold: true, size: 10, color: { argb: NAVY } }; r.getCell(1).alignment = { vertical: 'top' };
    r.getCell(2).value = v; r.getCell(2).font = style.body.font; r.getCell(2).alignment = { vertical: 'top', wrapText: true };
    r.height = Math.max(16, Math.ceil(v.length / 110) * 15);
  });

  /* ── Data ── */
  const sheets = ['Summary', 'KPI definition'];
  const dataWs = wb.addWorksheet('Data');
  const bd = breakdownTable(kpi);
  const table = detail ?? (bd ? { title: `${kpi.label} — breakdown`, ...bd } : null);
  let rowCount = 0;
  if (table) {
    brandBand(dataWs, table.title, subtitle, Math.max(2, table.columns.length));
    writeTable(dataWs, 4, table.columns, table.rows, { freeze: true });
    rowCount = table.rows.length;
    if (!table.rows.length) { dataWs.getCell(5, 1).value = 'No records match the filters applied.'; dataWs.getCell(5, 1).font = { name: 'Arial', italic: true, size: 10 }; }
  } else {
    brandBand(dataWs, kpi.label, subtitle, 2);
    dataWs.getCell(4, 1).value = 'This KPI is a single figure — see the Summary sheet.'; dataWs.getCell(4, 1).font = { name: 'Arial', italic: true, size: 10 };
  }
  sheets.push('Data');

  if (detail && bd) {
    const bws = wb.addWorksheet('Breakdown');
    brandBand(bws, `${kpi.label} — breakdown`, subtitle, Math.max(2, bd.columns.length));
    writeTable(bws, 4, bd.columns, bd.rows, { freeze: true });
    sheets.push('Breakdown');
  }
  if (kpi.series?.length) {
    const sws = wb.addWorksheet('Series');
    brandBand(sws, `${kpi.label} — trend`, subtitle, 2);
    writeTable(sws, 4, [{ key: 'x', label: 'Period starting', type: /^\d{4}-\d{2}-\d{2}$/.test(kpi.series[0]!.x) ? 'date' : 'text' }, { key: 'y', label: kpi.label, type: kpi.unit === 'pct' ? 'pct' : kpi.unit === 'inr' ? 'inr' : 'number' }], kpi.series.map((p) => ({ x: p.x, y: p.y })));
    sheets.push('Series');
  }

  /* ── Filters applied ── */
  const fws = wb.addWorksheet('Filters applied');
  brandBand(fws, 'Filters applied to this export', subtitle, 2);
  fws.getColumn(1).width = 26; fws.getColumn(2).width = 60;
  headerRow(fws, 4, ['Filter', 'Value']);
  const distName = f.distributor_id ? (await ctx.db.table('distributors').get(f.distributor_id))?.legal_name ?? f.distributor_id : 'All';
  const dealerName = f.dealer_id ? (await ctx.db.table('dealers').get(f.dealer_id))?.legal_name ?? f.dealer_id : 'All';
  const external = ctx.user.role === 'distributor_user' || ctx.user.role === 'dealer_user';
  const filterRows: [string, string][] = [
    ['From', formatDate(f.from)], ['To', formatDate(f.to)], ['Days covered', String(f.days)],
    ['Segment', f.segment ? SEGMENT_LABEL[f.segment] : 'All segments'], ['Distributor', distName], ['Dealer', dealerName],
    ['Generated by', `${ctx.user.full_name} — ${ROLE_LABEL[ctx.user.role]}`], ['Generated at', `${generated} IST`],
    ['Data scope', external ? 'Your own party only (distributor / dealer scope applied)' : ctx.user.territory_ids.length ? 'Your assigned territories' : 'Whole organisation'],
    ['Currency / dates', '₹ with Indian digit grouping; dates as DD-MMM-YYYY (Asia/Kolkata)'],
  ];
  filterRows.forEach(([k, v], i) => {
    const r = fws.getRow(5 + i);
    r.getCell(1).value = k; r.getCell(1).font = { name: 'Arial', bold: true, size: 10, color: { argb: NAVY } };
    r.getCell(2).value = v; r.getCell(2).font = style.body.font;
  });
  sheets.push('Filters applied');

  const stamp = f.today.replace(/-/g, '');
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, filename: `Future-Solar_${def.key}_${stamp}.xlsx`, rows: rowCount, sheets };
}

export type { KpiDetail };
