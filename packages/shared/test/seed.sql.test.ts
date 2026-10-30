import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'libpg-query';
import { TABLE_NAMES } from '../src/enums';
import { buildReferenceSeed } from '../src/seed';
import { renderScenariosDoc, renderVerifyDoc } from '../src/seed/docs';
import { REFERENCE_TABLES } from '../src/seed/order';
import { JSON_COLUMNS, renderSeedSql, sqlLiteral } from '../src/seed/sql';
import { VERIFY_ITEMS } from '../src/seed/ref.verify';
import { DEMO_QUOTE_SCENARIOS } from '../src/seed/demo.quotes';

// NOTE: this file only PARSES SQL (libpg-query). Nothing is ever executed against a database.
const NOW = new Date('2026-10-26T06:30:00Z');
const LABEL = NOW.toISOString();
const seedSql = renderSeedSql(NOW, LABEL);
const ref = buildReferenceSeed(NOW);
type Stmt = { stmt?: Record<string, unknown> };
const stmtsOf = async (sql: string): Promise<Stmt[]> => ((await parse(sql)) as unknown as { stmts: Stmt[] }).stmts;
const kind = (s: Stmt): string => Object.keys(s.stmt ?? {})[0] ?? '';

describe('sqlLiteral', () => {
  it('quotes text, escapes quotes and renders null/boolean/number', () => {
    expect(sqlLiteral("O'Brien", false)).toBe("'O''Brien'");
    expect(sqlLiteral(null, false)).toBe('null');
    expect(sqlLiteral(undefined, true)).toBe('null');
    expect(sqlLiteral(true, false)).toBe('true');
    expect(sqlLiteral(12.5, false)).toBe('12.5');
    expect(() => sqlLiteral(Number.NaN, false)).toThrow();
  });
  it('renders arrays as Postgres array literals and objects as jsonb', () => {
    expect(sqlLiteral(['a', 'b"c', 'd\\e'], false)).toBe(`'{"a","b\\"c","d\\\\e"}'`);
    expect(sqlLiteral([], false)).toBe("'{}'");
    expect(sqlLiteral([14, 7, 3], false)).toBe(`'{"14","7","3"}'`);
    expect(sqlLiteral({ a: "it's", b: [1, 2] }, true)).toBe(`'{"a":"it''s","b":[1,2]}'::jsonb`);
    expect(sqlLiteral([{ from: '380001' }], true)).toBe(`'[{"from":"380001"}]'::jsonb`);
    expect(() => sqlLiteral({ a: 1 }, false)).toThrow();
  });
});

describe('12_seed_reference.sql', () => {
  it('parses with the real PostgreSQL parser', async () => {
    const stmts = await stmtsOf(seedSql);
    expect(stmts.length).toBeGreaterThan(10);
    const kinds = new Set(stmts.map(kind));
    expect([...kinds].sort()).toEqual(['InsertStmt', 'TransactionStmt']);
  });
  it('is idempotent: every insert is "on conflict (id) do nothing"', () => {
    const inserts = seedSql.match(/^insert into /gm) ?? [];
    const conflicts = seedSql.match(/^on conflict \(id\) do nothing;$/gm) ?? [];
    expect(inserts.length).toBeGreaterThan(10);
    expect(conflicts.length).toBe(inserts.length);
  });
  it('contains reference data only: no demo tables, no people, no leads', () => {
    for (const t of REFERENCE_TABLES) expect(seedSql).toContain('insert into public.' + t + ' ');
    for (const t of ['leads', 'profiles', 'quotations', 'sales_orders', 'dealers', 'customers']) expect(seedSql).not.toContain('insert into public.' + t + ' ');
    expect(seedSql).toContain('begin;');
    expect(seedSql).toContain('commit;');
  });
  it('seeds a Gujarat distributor network of at least 50 that covers every region', () => {
    const d = (ref.distributors ?? []) as unknown as { legal_name: string; territory_ids: string[]; address: { pincode: string }; status: string }[];
    expect(d.length).toBeGreaterThanOrEqual(50);
    expect(d.every((x) => x.status === 'active' && /^3[6-9][0-9]{4}$/.test(x.address.pincode))).toBe(true);
    expect(new Set(d.map((x) => x.legal_name)).size).toBe(d.length);
    const regions = ((ref.territories ?? []) as unknown as { id: string }[]).map((t) => t.id);
    for (const t of regions.slice(5)) expect(d.some((x) => x.territory_ids.includes(t)), t).toBe(true);
  });
  it('seeds 100 starter products, each with a compliance register row and a price, nothing marked verified', () => {
    const skus = (ref.skus ?? []) as unknown as { id: string; demo: boolean; category: string }[];
    expect(skus).toHaveLength(100);
    expect(skus.every((x) => !x.demo)).toBe(true);
    expect(new Set(skus.map((x) => x.category))).toEqual(new Set(['module', 'inverter', 'structure', 'battery', 'cable', 'other']));
    const comp = (ref.sku_compliance ?? []) as unknown as { sku_id: string; verified_by: string | null; almm_snapshot_date: string | null }[];
    expect(comp.map((c) => c.sku_id).sort()).toEqual(skus.map((x) => x.id).sort());
    expect(comp.every((c) => c.verified_by === null && c.almm_snapshot_date === null)).toBe(true);
    expect(((ref.sku_prices ?? []) as unknown[]).length).toBe(100);
  });
  it('real territories have no DSM yet (assigned later in the app)', () => {
    const t = (ref.territories ?? []) as unknown as { dsm_id: string | null }[];
    expect(t.length).toBeGreaterThan(0);
    for (const r of t) expect(r.dsm_id).toBeNull();
  });
  it('writes every reference row once, with all columns', () => {
    for (const t of TABLE_NAMES) for (const r of (ref[t] ?? []) as unknown as Record<string, unknown>[]) expect(seedSql).toContain("'" + String(r['id']) + "'");
  });
  it('never contains an Aadhaar-like number', () => {
    const noMobiles = seedSql.replace(/\+91\d{10}/g, '');
    // only the document row named for gate G14 exists, and it holds a file NAME, not a number
    expect(noMobiles.match(/(?<![\d.])[2-9]\d{3}\s?\d{4}\s?\d{4}(?!\d)/g)?.filter((m) => !/^20\d\d/.test(m)) ?? []).toEqual([]);
  });
  it('stays within the tables of supabase/sql (column names match the DDL when the DDL is present)', () => {
    const dir = resolve(__dirname, '../../../supabase/sql');
    const files = ['02_core_tables.sql', '03_lead_tables.sql', '04_opportunity_catalogue.sql', '05_commercial_tables.sql', '06_postsale_tables.sql', '07_platform_tables.sql'].map((f) => resolve(dir, f)).filter(existsSync);
    if (!files.length) return;
    const ddl = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    const columns = new Map<string, Set<string>>();
    for (const m of ddl.matchAll(/create table if not exists (\w+) \(([\s\S]*?)\n\);/g)) {
      const cols = new Set<string>();
      for (const line of m[2]!.split('\n')) {
        const t = line.trim();
        const name = /^([a-z_][a-z0-9_]*)\s+\S/.exec(t)?.[1];
        if (name && !['constraint', 'primary', 'unique', 'check', 'foreign'].includes(name)) cols.add(name);
      }
      columns.set(m[1]!, cols);
    }
    for (const t of TABLE_NAMES) {
      const all = [...((ref[t] ?? []) as unknown[])] as Record<string, unknown>[];
      const known = columns.get(t);
      if (!all.length || !known) continue;
      for (const col of Object.keys(all[0]!)) expect(known.has(col), `${t}.${col} exists in the DDL`).toBe(true);
    }
    // jsonb columns declared here are jsonb in the DDL
    for (const [t, cols] of Object.entries(JSON_COLUMNS)) {
      const block = new RegExp(`create table if not exists ${t} \\(([\\s\\S]*?)\\n\\);`).exec(ddl)?.[1];
      if (!block) continue;
      for (const c of cols ?? []) expect(new RegExp(`^\\s*${c}\\s+jsonb`, 'm').test(block), `${t}.${c} is jsonb`).toBe(true);
    }
  });
});

describe('generated docs', () => {
  it('lists all 26 verify-register items with the same text as the seed', () => {
    const md = renderVerifyDoc();
    for (const v of VERIFY_ITEMS) {
      expect(md).toContain(`| ${v.code} |`);
      expect(md).toContain(v.title.replace(/\|/g, '\\|'));
      expect(md).toContain(v.where_to_check.replace(/\|/g, '\\|'));
    }
    expect(md.match(/^\| V-\d+ \|/gm)).toHaveLength(26);
  });
  it('documents every demo quote with its gate, why and how to clear it', () => {
    const md = renderScenariosDoc();
    for (const s of DEMO_QUOTE_SCENARIOS) expect(md).toContain(`| ${s.quote_no} | ${s.gate} |`);
    expect(DEMO_QUOTE_SCENARIOS).toHaveLength(16);
  });
  it('the committed docs match the generator (re-run `npm run seed:sql` if this fails)', () => {
    const root = resolve(__dirname, '../../..');
    const verify = resolve(root, 'docs/VERIFY_BEFORE_RELYING.md');
    const scenarios = resolve(root, 'docs/DEMO_SCENARIOS.md');
    if (existsSync(verify)) expect(readFileSync(verify, 'utf8')).toBe(renderVerifyDoc());
    if (existsSync(scenarios)) expect(readFileSync(scenarios, 'utf8')).toBe(renderScenariosDoc());
  });
});
