import { TABLE_NAMES, type TableName } from '../enums';
import { buildReferenceSeed } from './build';
import { DEFERRED_COLUMNS, INSERT_ORDER, REFERENCE_TABLES } from './order';
import type { SeedData } from './types';

/**
 * Renders the seed as plain SQL text. Nothing in this module (or anywhere in the repository) ever EXECUTES SQL —
 * the owner runs the generated files by hand in the Supabase SQL editor.
 */

/** jsonb columns per table (everything else that is an array is a Postgres array). Mirrors supabase/sql/02–07. */
export const JSON_COLUMNS: Partial<Record<TableName, readonly string[]>> = {
  organizations: ['address', 'settings'], territories: ['pincode_ranges'], distributors: ['address'], distributor_score_history: ['components'],
  leads: ['source_detail'], lead_events: ['detail'], lead_assignments: ['score_snapshot'], lead_scores: ['components'],
  customers: ['billing_address', 'shipping_address'], sites: ['address'], site_surveys: ['photos'],
  opportunities: ['funding_mix'], requirement_forms: ['data'], segment_form_config: ['fields'], skus: ['brand_usp'], sku_prices: ['landed_cost'],
  inventory_serials: ['compliance_snapshot', 'invoice_chain'], quotations: ['floor_check', 'cfa_breakdown', 'compliance_findings'],
  approval_rules: ['conditions'], approvals: ['meta'], proforma_invoices: ['billing_address', 'shipping_address', 'pre_pi_checklist'], credit_checks: ['ageing'],
  dispatches: ['invoice_chain', 'compliance_findings', 'ship_to'], einvoice_status: ['payload'], loans: ['document_checklist'], installations: ['photos'],
  rule_config: ['value'], clocks: ['meta'], kpi_snapshots: ['dims'], audit_log: ['old_data', 'new_data', 'detail'], job_runs: ['details'], breach_incidents: ['evidence'],
};

/** Tables with an immutability trigger (insert-only ledgers). Their triggers are lifted for the delete transaction only. */

const quote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

function arrayLiteral(items: readonly unknown[]): string {
  const parts = items.map((x) => {
    if (x === null || x === undefined) return 'NULL';
    const s = String(x);
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });
  return quote(`{${parts.join(',')}}`);
}

/** Renders one value. `json` = the column is jsonb. */
export function sqlLiteral(value: unknown, json: boolean): string {
  if (value === null || value === undefined) return 'null';
  if (json) return `${quote(JSON.stringify(value))}::jsonb`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Non-finite number in seed: ${String(value)}`);
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return quote(value);
  if (Array.isArray(value)) return arrayLiteral(value);
  throw new Error(`Object value in a non-jsonb column: ${JSON.stringify(value)}`);
}

type Row = Record<string, unknown>;
const rowsOf = (seed: SeedData, t: TableName): Row[] => (seed[t] ?? []) as unknown as Row[];

function insertStatements(table: TableName, rows: Row[], deferred: Set<string>): string[] {
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]!);
  const json = new Set(JSON_COLUMNS[table] ?? []);
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    const values = chunk.map((r) => `(${cols.map((c) => {
      if (!(c in r)) throw new Error(`Row in ${table} is missing column ${c}`);
      return deferred.has(c) ? 'null' : sqlLiteral(r[c], json.has(c));
    }).join(', ')})`);
    out.push(`insert into public.${table} (${cols.join(', ')}) values\n  ${values.join(',\n  ')}\non conflict (id) do nothing;`);
  }
  return out;
}

function section(seed: SeedData, tables: readonly TableName[]): string[] {
  const out: string[] = [];
  for (const table of tables) {
    const rows = rowsOf(seed, table);
    if (!rows.length) continue;
    const deferredCols = DEFERRED_COLUMNS.filter((d) => d.table === table);
    out.push(`-- ${table} (${rows.length})`);
    out.push(...insertStatements(table, rows, new Set(deferredCols.map((d) => d.column))));
  }
  return out;
}

export interface SplitSeed { reference: SeedData }
export function splitSeed(now: Date): SplitSeed {
  return { reference: buildReferenceSeed(now) };
}

const REF_SECTION_ORDER: readonly TableName[] = INSERT_ORDER.filter((t) => REFERENCE_TABLES.includes(t));

export function renderSeedSql(now: Date, anchorLabel: string): string {
  const { reference } = splitSeed(now);
  const L: string[] = [];  L.push('-- =====================================================================================================');
  L.push('-- 12_seed_reference.sql');
  L.push('-- Purpose : real reference data only (organization, DISCOMs, rule_config, message templates, compliance calendar,');
  L.push('--           verify register, gate applicability, approval rules, segment forms, Gujarat pincodes, sales territories).');
  L.push('--           There is NO demo data in this file.');
  L.push('-- Run after: 01 - 11 (all tables, triggers, RLS, views and storage buckets must exist).');
  L.push(`-- Generated by: scripts/generate-seed-sql.ts  (npm run seed:sql)   anchor: ${anchorLabel}`);
  L.push('-- DO NOT EDIT BY HAND - change packages/shared/src/seed/** and regenerate.');
  L.push('-- Idempotent: every insert is "on conflict (id) do nothing", so the file can be run again safely.');
  L.push('-- Next: create your admin in Supabase Auth, then run 13_first_admin.sql.');
  L.push('-- =====================================================================================================', '');
  L.push('begin;', '');
  L.push(...section(reference, REF_SECTION_ORDER));
  L.push('', 'commit;', '');
  return L.join('\n');
}

export const ALL_TABLES: readonly TableName[] = TABLE_NAMES;
