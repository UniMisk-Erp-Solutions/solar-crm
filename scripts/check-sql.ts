/**
 * check-sql.ts - static validation of supabase/sql/*.sql.   Run:  npm run check:sql
 *
 * This script NEVER connects to a database and NEVER executes SQL. It only PARSES the files with libpg-query (the real
 * PostgreSQL parser compiled to WASM), including a PL/pgSQL compile pass over every function body, and then cross-checks
 * the resulting syntax trees against the TypeScript data contract:
 *
 *   1. Syntax        every file parses; every PL/pgSQL function and DO block compiles; embedded SQL parses
 *   2. Safety        files 01-11 contain no destructive statements (drop table / truncate / delete ...)
 *   3. Enums         every enum array in packages/shared/src/enums.ts exists in SQL with identical values and order
 *   4. Contract      for every table in TableRowMap (packages/shared/src/rows.ts): same column set, `| null` <=> nullable,
 *                    and a compatible SQL type (uuid, timestamptz, date, text, numeric, boolean, jsonb, arrays, enums,
 *                    string-literal unions as text + CHECK ... IN (...))
 *   5. Structure     org_id foreign keys and org-leading indexes, required unique indexes, GIN on array columns,
 *                    trigram index and partial index on leads, no FK on user-reference columns, forward FKs deferrable
 *   6. Triggers      updated_at on every table that has the column, audit trigger on every AUDITED_TABLES entry (and on
 *                    nothing else), ledger immutability, guards, lead-status events
 *   7. RLS           every table has RLS enabled in file 09 and at least one policy; helper functions exist
 *   8. Semantics     column references in policies, views, indexes, constraints and function bodies resolve against the
 *                    tables declared in the SQL (catches typos that a pure syntax check cannot see)
 *   9. Objects       required functions, views and storage buckets exist; FK dependency order is acyclic
 *
 * Exit code 0 = clean, 1 = at least one failure.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse, parsePlPgSQL } from 'libpg-query';
import * as ENUMS from '../packages/shared/src/enums';

/* ──────────────────────────────── generic helpers ──────────────────────────────── */

type Node = Record<string, unknown>;
const isObj = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** `{ TypeName: {...} }` -> [`TypeName`, {...}] */
function unwrap(v: unknown): [string, Node] | null {
  if (!isObj(v)) return null;
  const keys = Object.keys(v);
  const k = keys[0];
  if (keys.length !== 1 || k === undefined) return null;
  const inner = v[k];
  return isObj(inner) ? [k, inner] : null;
}

/** List of `{ String: { sval } }` (or a `List` wrapper) -> string[] ; A_Star -> '*'. */
function strList(v: unknown): string[] {
  const items = isObj(v) && isObj(v['List']) ? asArr((v['List'] as Node)['items']) : asArr(v);
  const out: string[] = [];
  for (const it of items) {
    const u = unwrap(it);
    if (!u) continue;
    if (u[0] === 'String') out.push(str(u[1]['sval']) ?? '');
    else if (u[0] === 'A_Star') out.push('*');
  }
  return out;
}

/** Depth-first walk over every `{ NodeType: {...} }` in an AST. Return false from `fn` to skip that node's children. */
function walk(v: unknown, fn: (type: string, node: Node) => boolean | void): void {
  if (Array.isArray(v)) {
    for (const x of v) walk(x, fn);
    return;
  }
  if (!isObj(v)) return;
  for (const [k, val] of Object.entries(v)) {
    if (/^[A-Z]/.test(k) && isObj(val)) {
      if (fn(k, val) === false) continue;
    }
    walk(val, fn);
  }
}

function relName(rv: unknown): { schema: string | undefined; name: string } {
  const n = isObj(rv) ? rv : {};
  return { schema: str(n['schemaname']), name: str(n['relname']) ?? '' };
}

const setEq = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');

/* ──────────────────────────────── report ──────────────────────────────── */

class Report {
  errors = 0;
  warnings = 0;
  private lines: string[] = [];
  section(title: string): void {
    this.lines.push('', `== ${title}`);
  }
  ok(msg: string): void {
    this.lines.push(`   ok    ${msg}`);
  }
  info(msg: string): void {
    this.lines.push(`   info  ${msg}`);
  }
  warn(msg: string): void {
    this.warnings++;
    this.lines.push(`   WARN  ${msg}`);
  }
  fail(msg: string): void {
    this.errors++;
    this.lines.push(`   FAIL  ${msg}`);
  }
  /** Section result helper: prints ok(summary) when `count` failures were added since `before`. */
  print(): void {
    for (const l of this.lines) console.log(l);
  }
}
const R = new Report();

/* ──────────────────────────────── load files ──────────────────────────────── */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SQL_DIR = join(ROOT, 'supabase', 'sql');
const ROWS_TS = join(ROOT, 'packages', 'shared', 'src', 'rows.ts');
const ENUMS_TS = join(ROOT, 'packages', 'shared', 'src', 'enums.ts');

interface SqlFile { name: string; num: number; text: string; buf: Buffer }
const CORE_RE = /^(0[1-9]|1[01])_.*\.sql$/;
const sqlFiles: SqlFile[] = readdirSync(SQL_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => {
    const text = readFileSync(join(SQL_DIR, f), 'utf8');
    return { name: f, num: Number(f.slice(0, 2)), text, buf: Buffer.from(text, 'utf8') };
  });

const lineAt = (f: SqlFile, byteOffset: number): number => {
  let n = 1;
  for (let i = 0; i < Math.min(byteOffset, f.buf.length); i++) if (f.buf[i] === 10) n++;
  return n;
};

/* ──────────────────────────────── SQL model ──────────────────────────────── */

interface Origin { file: string; line: number; core: boolean }
interface Col { name: string; type: string; isArray: boolean; notNull: boolean; hasDefault: boolean; pk: boolean; checkIn: string[] | null; origin: Origin }
interface Fk { table: string; cols: string[]; refTable: string; refCols: string[]; onDelete: string; deferrable: boolean; initDeferred: boolean; origin: Origin }
interface Tbl { name: string; cols: Map<string, Col>; origin: Origin; uniques: string[][]; pk: string[]; checks: unknown[] }
interface Idx { name: string; table: string; cols: string[]; hasExpr: boolean; unique: boolean; partial: boolean; method: string; opclasses: string[]; origin: Origin }
interface Trg { name: string; table: string; fn: string; events: number; before: boolean; row: boolean; origin: Origin }
interface Pol { name: string; table: string; schema: string | undefined; cmd: string; origin: Origin }
interface FnParam { name: string; variadic: boolean; hasDefault: boolean }
interface Fn { schema: string; name: string; params: FnParam[]; returns: string; lang: string; body: string; origin: Origin; stmtText: string; security: boolean; searchPath: boolean }
interface Vw { name: string; origin: Origin; query: unknown; options: string[] }

const M = {
  enums: new Map<string, { values: string[]; origin: Origin }>(),
  tables: new Map<string, Tbl>(),
  fks: [] as Fk[],
  indexes: [] as Idx[],
  triggers: [] as Trg[],
  policies: [] as Pol[],
  functions: [] as Fn[],
  views: new Map<string, Vw>(),
  rls: new Set<string>(),
  statements: [] as { type: string; node: Node; origin: Origin }[],
  buckets: new Set<string>(),
};

const typeLast = (names: unknown): string => {
  const l = strList(names);
  return l[l.length - 1] ?? '';
};

function checkInOf(expr: unknown): { col: string; values: string[] } | null {
  const u = unwrap(expr);
  if (!u || u[0] !== 'A_Expr' || u[1]['kind'] !== 'AEXPR_IN') return null;
  const l = unwrap(u[1]['lexpr']);
  if (!l || l[0] !== 'ColumnRef') return null;
  const f = strList(l[1]['fields']);
  if (f.length !== 1) return null;
  const right = unwrap(u[1]['rexpr']);
  if (!right || right[0] !== 'List') return null;
  const values: string[] = [];
  for (const it of asArr(right[1]['items'])) {
    const c = unwrap(it);
    if (!c || c[0] !== 'A_Const' || !isObj(c[1]['sval'])) return null;
    values.push(str((c[1]['sval'] as Node)['sval']) ?? '');
  }
  return { col: f[0] ?? '', values };
}

function ingestColumn(table: Tbl, def: Node, origin: Origin): void {
  const name = str(def['colname']) ?? '';
  const tn = isObj(def['typeName']) ? (def['typeName'] as Node) : {};
  const col: Col = {
    name,
    type: typeLast(tn['names']),
    isArray: asArr(tn['arrayBounds']).length > 0,
    notNull: false,
    hasDefault: false,
    pk: false,
    checkIn: null,
    origin,
  };
  let lastFk: Fk | undefined;
  for (const c of asArr(def['constraints'])) {
    const u = unwrap(c);
    if (!u) continue;
    const n = u[1];
    switch (n['contype']) {
      case 'CONSTR_NOTNULL': col.notNull = true; break;
      case 'CONSTR_DEFAULT': col.hasDefault = true; break;
      case 'CONSTR_PRIMARY': col.pk = true; col.notNull = true; table.pk = [name]; break;
      case 'CONSTR_UNIQUE': table.uniques.push([name]); break;
      case 'CONSTR_CHECK': {
        table.checks.push(n['raw_expr']);
        const ci = checkInOf(n['raw_expr']);
        if (ci && ci.col === name) col.checkIn = ci.values;
        break;
      }
      case 'CONSTR_FOREIGN':
        M.fks.push({
          table: table.name, cols: [name], refTable: relName(n['pktable']).name, refCols: strList(n['pk_attrs']),
          onDelete: str(n['fk_del_action']) ?? 'a', deferrable: n['deferrable'] === true, initDeferred: n['initdeferred'] === true, origin,
        });
        lastFk = M.fks[M.fks.length - 1];
        break;
      // column-level DEFERRABLE / INITIALLY DEFERRED arrive as separate attribute constraints in the raw parse tree
      case 'CONSTR_ATTR_DEFERRABLE': if (lastFk) lastFk.deferrable = true; break;
      case 'CONSTR_ATTR_DEFERRED': if (lastFk) lastFk.initDeferred = true; break;
      default: break;
    }
  }
  table.cols.set(name, col);
}

function ingestTableConstraint(table: Tbl, n: Node, origin: Origin): void {
  switch (n['contype']) {
    case 'CONSTR_PRIMARY': {
      const keys = strList(n['keys']);
      table.pk = keys;
      for (const k of keys) { const c = table.cols.get(k); if (c) { c.pk = true; c.notNull = true; } }
      break;
    }
    case 'CONSTR_UNIQUE': table.uniques.push(strList(n['keys'])); break;
    case 'CONSTR_CHECK': {
      table.checks.push(n['raw_expr']);
      const ci = checkInOf(n['raw_expr']);
      const c = ci ? table.cols.get(ci.col) : undefined;
      if (ci && c) c.checkIn = ci.values;
      break;
    }
    case 'CONSTR_FOREIGN':
      M.fks.push({
        table: table.name, cols: strList(n['fk_attrs']), refTable: relName(n['pktable']).name, refCols: strList(n['pk_attrs']),
        onDelete: str(n['fk_del_action']) ?? 'a', deferrable: n['deferrable'] === true, initDeferred: n['initdeferred'] === true, origin,
      });
      break;
    default: break;
  }
}

function ingest(type: string, node: Node, origin: Origin): void {
  M.statements.push({ type, node, origin });
  switch (type) {
    case 'CreateEnumStmt': {
      const nm = typeLast(node['typeName']);
      M.enums.set(nm, { values: strList(node['vals']), origin });
      break;
    }
    case 'CreateStmt': {
      const nm = relName(node['relation']).name;
      const t: Tbl = { name: nm, cols: new Map(), origin, uniques: [], pk: [], checks: [] };
      M.tables.set(nm, t);
      for (const el of asArr(node['tableElts'])) {
        const u = unwrap(el);
        if (!u) continue;
        if (u[0] === 'ColumnDef') ingestColumn(t, u[1], origin);
      }
      for (const el of asArr(node['tableElts'])) {
        const u = unwrap(el);
        if (u && u[0] === 'Constraint') ingestTableConstraint(t, u[1], origin);
      }
      break;
    }
    case 'AlterTableStmt': {
      const nm = relName(node['relation']).name;
      const t = M.tables.get(nm);
      for (const c of asArr(node['cmds'])) {
        const cu = unwrap(c);
        if (!cu) continue;
        const sub = str(cu[1]['subtype']);
        if (sub === 'AT_EnableRowSecurity') M.rls.add(nm);
        else if (sub === 'AT_AddConstraint' && t) {
          const d = unwrap(cu[1]['def']);
          if (d && d[0] === 'Constraint') ingestTableConstraint(t, d[1], origin);
        } else if (sub === 'AT_AddColumn' && t) {
          const d = unwrap(cu[1]['def']);
          if (d && d[0] === 'ColumnDef') ingestColumn(t, d[1], origin);
        }
      }
      break;
    }
    case 'IndexStmt': {
      const cols: string[] = [];
      let hasExpr = false;
      const opclasses: string[] = [];
      for (const p of asArr(node['indexParams'])) {
        const u = unwrap(p);
        if (!u) continue;
        const nm = str(u[1]['name']);
        if (nm) cols.push(nm);
        else { hasExpr = true; cols.push('<expr>'); }
        const oc = strList(u[1]['opclass']);
        if (oc.length) opclasses.push(oc[oc.length - 1] ?? '');
      }
      M.indexes.push({
        name: str(node['idxname']) ?? '', table: relName(node['relation']).name, cols, hasExpr, unique: node['unique'] === true,
        partial: node['whereClause'] !== undefined, method: str(node['accessMethod']) ?? 'btree', opclasses, origin,
      });
      break;
    }
    case 'CreateTrigStmt': {
      const ev = typeof node['events'] === 'number' ? (node['events'] as number) : 0;
      const timing = typeof node['timing'] === 'number' ? (node['timing'] as number) : 0;
      const fnames = strList(node['funcname']);
      M.triggers.push({
        name: str(node['trigname']) ?? '', table: relName(node['relation']).name, fn: fnames[fnames.length - 1] ?? '',
        events: ev, before: (timing & 2) === 2, row: node['row'] === true, origin,
      });
      break;
    }
    case 'CreatePolicyStmt': {
      const rv = relName(node['table']);
      M.policies.push({ name: str(node['policy_name']) ?? '', table: rv.name, schema: rv.schema, cmd: str(node['cmd_name']) ?? 'all', origin });
      break;
    }
    case 'CreateFunctionStmt': {
      const fnames = strList(node['funcname']);
      const params: FnParam[] = [];
      for (const p of asArr(node['parameters'])) {
        const u = unwrap(p);
        if (!u || u[1]['mode'] === 'FUNC_PARAM_TABLE') continue; // RETURNS TABLE columns are outputs, not arguments
        params.push({ name: str(u[1]['name']) ?? '', variadic: u[1]['mode'] === 'FUNC_PARAM_VARIADIC', hasDefault: u[1]['defexpr'] !== undefined });
      }
      let lang = '';
      let body = '';
      let security = false;
      let searchPath = false;
      for (const o of asArr(node['options'])) {
        const u = unwrap(o);
        if (!u || u[0] !== 'DefElem') continue;
        const dn = str(u[1]['defname']);
        const arg = u[1]['arg'];
        if (dn === 'language') lang = str((unwrap(arg)?.[1] ?? {})['sval']) ?? '';
        else if (dn === 'as') body = strList(arg).join('\n');
        else if (dn === 'security') security = true;
        else if (dn === 'set') searchPath = true;
      }
      const rt = isObj(node['returnType']) ? typeLast((node['returnType'] as Node)['names']) : '';
      const setof = isObj(node['returnType']) && (node['returnType'] as Node)['setof'] === true;
      const returns = node['returnType'] === undefined ? 'table' : setof ? `setof ${rt}` : rt;
      M.functions.push({
        schema: fnames.length > 1 ? (fnames[0] ?? '') : 'public', name: fnames[fnames.length - 1] ?? '', params, returns,
        lang, body, origin, stmtText: '', security, searchPath,
      });
      break;
    }
    case 'ViewStmt': {
      const nm = relName(node['view']).name;
      const options = asArr(node['options']).map((o) => {
        const u = unwrap(o);
        return u ? `${str(u[1]['defname']) ?? ''}=${str((unwrap(u[1]['arg'])?.[1] ?? {})['sval']) ?? ''}` : '';
      });
      M.views.set(nm, { name: nm, origin, query: node['query'], options });
      break;
    }
    default: break;
  }
}

/* ──────────────────────────────── 1. SYNTAX ──────────────────────────────── */

function posToLine(f: SqlFile, cursor1: number): number {
  // cursorPosition is a 1-based character offset into the parsed string
  return f.text.slice(0, Math.max(0, cursor1 - 1)).split('\n').length;
}

/** All PLpgSQL_expr queries and variable declarations of a compiled function. */
function plCollect(pl: unknown): { exprs: { query: string; mode: number }[]; vars: Map<string, string> } {
  const exprs: { query: string; mode: number }[] = [];
  const vars = new Map<string, string>();
  walk(pl, (t, n) => {
    if (t === 'PLpgSQL_expr' && typeof n['query'] === 'string') exprs.push({ query: n['query'] as string, mode: typeof n['parseMode'] === 'number' ? (n['parseMode'] as number) : 0 });
    if (t === 'PLpgSQL_var' && isObj(n['datatype'])) {
      const dt = unwrap(n['datatype']);
      const tn = dt ? str(dt[1]['typname']) : undefined;
      const rn = str(n['refname']);
      if (tn && rn && tn.endsWith('%rowtype')) vars.set(rn, tn.replace(/^public\./, '').replace(/%rowtype$/, ''));
    }
  });
  return { exprs, vars };
}

/** SQL text for a PL/pgSQL expression (parseMode: 0 statement, 1 type name, 2 expression, 3+ assignment). */
function exprToSql(query: string, mode: number): string | null {
  if (mode === 1) return null;
  if (mode === 2) return `select ${query}`;
  if (mode >= 3) return `select ${query.replace(/^[\s\S]*?:=\s*/, '')}`;
  return query;
}

const fnPl = new Map<Fn, { exprs: { query: string; mode: number }[]; vars: Map<string, string> }>();
const embedded: { fn: Fn | null; label: string; ast: unknown; origin: Origin; vars: Map<string, string> }[] = [];

async function syntaxPass(): Promise<void> {
  R.section('1. Syntax (libpg-query parse + PL/pgSQL compile)');
  let stmtCount = 0;
  let fnCount = 0;
  let doCount = 0;
  let embeddedCount = 0;
  for (const f of sqlFiles) {
    const core = CORE_RE.test(f.name);
    let result;
    try {
      result = await parse(f.text);
    } catch (e) {
      const err = e as Error & { sqlDetails?: { cursorPosition?: number } };
      const pos = err.sqlDetails?.cursorPosition;
      R.fail(`${f.name}${pos ? `:${posToLine(f, pos)}` : ''} syntax error: ${err.message}`);
      continue;
    }
    if (core && [...f.text].some((ch) => ch.charCodeAt(0) > 127)) R.warn(`${f.name} contains non-ASCII characters (line offsets in this report may be approximate)`);
    for (const s of result.stmts) {
      const u = unwrap(s.stmt);
      if (!u) continue;
      stmtCount++;
      const start = s.stmt_location ?? 0;
      const len = s.stmt_len ?? 0;
      const origin: Origin = { file: f.name, line: lineAt(f, start), core };
      ingest(u[0], u[1], origin);
      const text = f.buf.subarray(start, len > 0 ? start + len : undefined).toString('utf8');

      if (u[0] === 'CreateFunctionStmt') {
        const fn = M.functions[M.functions.length - 1];
        if (!fn) continue;
        fn.stmtText = text;
        fnCount++;
        if (fn.lang === 'plpgsql') {
          try {
            const pl = await parsePlPgSQL(text);
            fnPl.set(fn, plCollect(pl));
          } catch (e) {
            R.fail(`${f.name}:${origin.line} function ${fn.schema}.${fn.name}: ${(e as Error).message}`);
          }
        } else if (fn.lang === 'sql') {
          try {
            const ast = await parse(fn.body);
            embedded.push({ fn, label: `${fn.schema}.${fn.name}`, ast, origin, vars: new Map() });
            embeddedCount++;
          } catch (e) {
            R.fail(`${f.name}:${origin.line} function ${fn.schema}.${fn.name} (sql body): ${(e as Error).message}`);
          }
        }
      }

      if (u[0] === 'DoStmt') {
        doCount++;
        const arg = asArr(u[1]['args'])
          .map((a) => unwrap(a))
          .find((a) => a && a[0] === 'DefElem' && a[1]['defname'] === 'as');
        const body = arg ? str((unwrap(arg[1]['arg'])?.[1] ?? {})['sval']) : undefined;
        if (body === undefined) { R.fail(`${f.name}:${origin.line} DO block without a body`); continue; }
        try {
          const pl = await parsePlPgSQL(`create function pg_temp.__do() returns void language plpgsql as $do_body$${body}$do_body$;`);
          const { exprs } = plCollect(pl);
          for (const ex of exprs) {
            const sql = exprToSql(ex.query, ex.mode);
            if (sql === null) continue;
            try {
              const sub = await parse(sql);
              for (const ss of sub.stmts) {
                const su = unwrap(ss.stmt);
                if (su) ingest(su[0], su[1], origin);
              }
            } catch (e) {
              R.fail(`${f.name}:${origin.line} DO block statement does not parse (${(e as Error).message}): ${ex.query.slice(0, 80)}`);
            }
          }
        } catch (e) {
          R.fail(`${f.name}:${origin.line} DO block: ${(e as Error).message}`);
        }
      }
    }
  }
  // embedded SQL inside PL/pgSQL function bodies
  for (const [fn, info] of fnPl) {
    for (const ex of info.exprs) {
      const sql = exprToSql(ex.query, ex.mode);
      if (sql === null) continue;
      try {
        const ast = await parse(sql);
        embedded.push({ fn, label: `${fn.schema}.${fn.name}`, ast, origin: fn.origin, vars: info.vars });
        embeddedCount++;
      } catch (e) {
        R.fail(`${fn.origin.file}:${fn.origin.line} function ${fn.schema}.${fn.name}: embedded SQL does not parse (${(e as Error).message}): ${ex.query.slice(0, 90).replace(/\s+/g, ' ')}`);
      }
    }
  }
  const names = sqlFiles.map((f) => f.name).join(', ');
  R.info(`files: ${names}`);
  R.ok(`${stmtCount} top-level statements, ${fnCount} functions compiled, ${doCount} DO blocks, ${embeddedCount} embedded SQL snippets parsed`);
  const present = new Set(sqlFiles.map((f) => f.num));
  for (let n = 1; n <= 11; n++) if (!present.has(n)) R.fail(`file ${String(n).padStart(2, '0')}_*.sql is missing`);
  for (const f of sqlFiles) {
    if (CORE_RE.test(f.name) && !/^--[^\n]*\n(?:--[^\n]*\n)*/.test(f.text)) R.fail(`${f.name} has no header comment`);
    if (CORE_RE.test(f.name) && !/Run after:/i.test(f.text.slice(0, 3000))) R.fail(`${f.name} header does not say "Run after"`);
  }
}

/* ──────────────────────────────── 2. SAFETY ──────────────────────────────── */

function safetyPass(): void {
  R.section('2. Safety (files 01-11 are additive and idempotent)');
  let bad = 0;
  for (const s of M.statements) {
    if (!s.origin.core) continue;
    const where = `${s.origin.file}:${s.origin.line}`;
    if (s.type === 'DropStmt') {
      const rt = str(s.node['removeType']) ?? '';
      if (!['OBJECT_TRIGGER', 'OBJECT_POLICY'].includes(rt)) { R.fail(`${where} destructive ${rt} drop`); bad++; }
    } else if (s.type === 'TruncateStmt' || s.type === 'DeleteStmt') {
      R.fail(`${where} ${s.type} is not allowed in schema files`); bad++;
    } else if (s.type === 'InsertStmt' || s.type === 'UpdateStmt') {
      const rv = relName(s.node['relation']);
      if (!(rv.schema === 'storage' && rv.name === 'buckets' && s.origin.file.startsWith('11_'))) { R.fail(`${where} data statement on ${rv.schema ?? 'public'}.${rv.name}`); bad++; }
    } else if (s.type === 'AlterTableStmt') {
      for (const c of asArr(s.node['cmds'])) {
        const sub = str(unwrap(c)?.[1]['subtype']);
        if (sub === 'AT_DropColumn' || sub === 'AT_DropNotNull') { R.fail(`${where} destructive ALTER (${sub})`); bad++; }
      }
    }
  }
  if (!bad) R.ok('no drop table/schema/type/column, truncate, delete or data-changing statement (except storage.buckets in file 11)');
  // idempotency
  let nonIdem = 0;
  for (const s of M.statements) {
    if (!s.origin.core) continue;
    const where = `${s.origin.file}:${s.origin.line}`;
    if (s.type === 'CreateStmt' && s.node['if_not_exists'] !== true) { R.fail(`${where} create table without IF NOT EXISTS`); nonIdem++; }
    if (s.type === 'IndexStmt' && s.node['if_not_exists'] !== true) { R.fail(`${where} create index without IF NOT EXISTS`); nonIdem++; }
    if (s.type === 'CreateFunctionStmt' && s.node['replace'] !== true) { R.fail(`${where} create function without OR REPLACE`); nonIdem++; }
    if (s.type === 'ViewStmt' && s.node['replace'] !== true) { R.fail(`${where} create view without OR REPLACE`); nonIdem++; }
  }
  if (!nonIdem) R.ok('tables, indexes, functions and views are all created idempotently');
}

/* ──────────────────────────────── 3. ENUMS ──────────────────────────────── */

const ENUM_SQL_OVERRIDE: Record<string, string> = { EINVOICE_STATUSES: 'einvoice_state' };
function enumSqlName(constName: string): string {
  const o = ENUM_SQL_OVERRIDE[constName];
  if (o) return o;
  const b = constName.toLowerCase();
  if (b.endsWith('statuses')) return b.slice(0, -2);
  if (b.endsWith('ies')) return `${b.slice(0, -3)}y`;
  return b.slice(0, -1);
}
const NOT_ENUM = new Set(['TABLE_NAMES', 'IMMUTABLE_TABLES', 'AUDITED_TABLES']);
const tsEnums = new Map<string, readonly string[]>(); // sql enum name -> values
const tsTypeToEnum = new Map<string, string>(); // TS type alias (AppRole) -> sql enum name

function enumsPass(): void {
  R.section('3. Enums (enums.ts <-> 01_extensions_enums.sql)');
  for (const [k, v] of Object.entries(ENUMS as Record<string, unknown>)) {
    if (NOT_ENUM.has(k) || !/^[A-Z][A-Z_]*$/.test(k) || !Array.isArray(v) || !v.every((x) => typeof x === 'string')) continue;
    tsEnums.set(enumSqlName(k), v as string[]);
  }
  const src = readFileSync(ENUMS_TS, 'utf8');
  for (const m of src.matchAll(/export type (\w+) = \(typeof ([A-Z_]+)\)\[number\];/g)) {
    const [, tname, cname] = m;
    if (tname && cname && !NOT_ENUM.has(cname)) tsTypeToEnum.set(tname, enumSqlName(cname));
  }
  let good = 0;
  for (const [name, values] of tsEnums) {
    const e = M.enums.get(name);
    if (!e) { R.fail(`enum ${name} is missing in SQL (${values.length} values in enums.ts)`); continue; }
    if (e.values.join('|') !== values.join('|')) {
      const missing = values.filter((v) => !e.values.includes(v));
      const extra = e.values.filter((v) => !values.includes(v));
      R.fail(`enum ${name} differs from enums.ts - missing: [${missing.join(', ')}] extra: [${extra.join(', ')}]${missing.length + extra.length === 0 ? ' (order differs)' : ''}`);
      continue;
    }
    good++;
  }
  for (const name of M.enums.keys()) if (!tsEnums.has(name)) R.fail(`enum ${name} exists in SQL but has no matching array in enums.ts`);
  if (good === tsEnums.size) R.ok(`${good}/${tsEnums.size} enums identical (values and order)`);
  else R.info(`${good}/${tsEnums.size} enums identical`);
}

/* ──────────────────────────────── 4. CONTRACT ──────────────────────────────── */

type Kind =
  | { k: 'uuid' | 'timestamptz' | 'date' | 'text' | 'numeric' | 'boolean' | 'jsonb' }
  | { k: 'enum'; name: string }
  | { k: 'textcheck'; values: string[] }
  | { k: 'array'; of: Kind };

interface TsMember { name: string; nullable: boolean; kind: Kind; tsText: string }

const describe = (k: Kind): string => {
  switch (k.k) {
    case 'enum': return `enum ${k.name}`;
    case 'textcheck': return `text CHECK IN (${k.values.join(', ')})`;
    case 'array': return `${describe(k.of)}[]`;
    default: return k.k;
  }
};

function parseRows(): Map<string, TsMember[]> {
  const sf = ts.createSourceFile(ROWS_TS, readFileSync(ROWS_TS, 'utf8'), ts.ScriptTarget.ES2022, true);
  const interfaces = new Map<string, ts.InterfaceDeclaration>();
  sf.forEachChild((n) => { if (ts.isInterfaceDeclaration(n)) interfaces.set(n.name.text, n); });

  const classify = (node: ts.TypeNode): { nullable: boolean; kind: Kind } => {
    if (ts.isParenthesizedTypeNode(node)) return classify(node.type);
    if (ts.isUnionTypeNode(node)) {
      const nullable = node.types.some((t) => t.kind === ts.SyntaxKind.LiteralType && (t as ts.LiteralTypeNode).literal.kind === ts.SyntaxKind.NullKeyword);
      const rest = node.types.filter((t) => !(t.kind === ts.SyntaxKind.LiteralType && (t as ts.LiteralTypeNode).literal.kind === ts.SyntaxKind.NullKeyword));
      if (rest.length === 1 && rest[0]) return { nullable, kind: classify(rest[0]).kind };
      const lits: string[] = [];
      for (const t of rest) {
        if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) lits.push(t.literal.text);
        else throw new Error(`unsupported union member: ${t.getText(sf)}`);
      }
      return { nullable, kind: { k: 'textcheck', values: lits } };
    }
    if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return { nullable: false, kind: { k: 'textcheck', values: [node.literal.text] } };
    if (node.kind === ts.SyntaxKind.StringKeyword) return { nullable: false, kind: { k: 'text' } };
    if (node.kind === ts.SyntaxKind.NumberKeyword) return { nullable: false, kind: { k: 'numeric' } };
    if (node.kind === ts.SyntaxKind.BooleanKeyword) return { nullable: false, kind: { k: 'boolean' } };
    if (ts.isTypeLiteralNode(node)) return { nullable: false, kind: { k: 'jsonb' } };
    if (ts.isArrayTypeNode(node)) {
      const el = classify(node.elementType).kind;
      if (el.k === 'uuid' || el.k === 'text' || el.k === 'numeric' || el.k === 'enum') return { nullable: false, kind: { k: 'array', of: el } };
      return { nullable: false, kind: { k: 'jsonb' } };
    }
    if (ts.isTypeReferenceNode(node)) {
      const name = node.typeName.getText(sf);
      if (name === 'Uuid') return { nullable: false, kind: { k: 'uuid' } };
      if (name === 'Iso') return { nullable: false, kind: { k: 'timestamptz' } };
      if (name === 'DateOnly') return { nullable: false, kind: { k: 'date' } };
      if (name === 'Json') return { nullable: false, kind: { k: 'jsonb' } };
      const en = tsTypeToEnum.get(name);
      if (en) return { nullable: false, kind: { k: 'enum', name: en } };
      if (interfaces.has(name)) return { nullable: false, kind: { k: 'jsonb' } };
      throw new Error(`unknown type reference ${name}`);
    }
    throw new Error(`unsupported type node: ${node.getText(sf)}`);
  };

  const membersOf = (name: string, seen = new Set<string>()): TsMember[] => {
    const decl = interfaces.get(name);
    if (!decl || seen.has(name)) return [];
    seen.add(name);
    const out: TsMember[] = [];
    for (const h of decl.heritageClauses ?? []) for (const t of h.types) out.push(...membersOf(t.expression.getText(sf), seen));
    for (const m of decl.members) {
      if (!ts.isPropertySignature(m) || !m.type || !ts.isIdentifier(m.name)) continue;
      const c = classify(m.type);
      out.push({ name: m.name.text, nullable: c.nullable, kind: c.kind, tsText: m.type.getText(sf) });
    }
    return out;
  };

  const map = new Map<string, TsMember[]>();
  const trm = interfaces.get('TableRowMap');
  if (!trm) throw new Error('TableRowMap not found in rows.ts');
  for (const m of trm.members) {
    if (!ts.isPropertySignature(m) || !m.type || !ts.isIdentifier(m.name)) continue;
    map.set(m.name.text, membersOf(m.type.getText(sf)));
  }
  return map;
}

function sqlKind(c: Col): Kind {
  const base = ((): Kind => {
    switch (c.type) {
      case 'uuid': return { k: 'uuid' };
      case 'timestamptz': return { k: 'timestamptz' };
      case 'date': return { k: 'date' };
      case 'text': case 'varchar': case 'bpchar': return { k: 'text' };
      case 'int2': case 'int4': case 'int8': case 'numeric': case 'float4': case 'float8': return { k: 'numeric' };
      case 'bool': return { k: 'boolean' };
      case 'jsonb': return { k: 'jsonb' };
      default: return { k: 'enum', name: c.type };
    }
  })();
  return c.isArray ? { k: 'array', of: base } : base;
}

function kindMatches(expected: Kind, c: Col): boolean {
  const actual = sqlKind(c);
  if (expected.k === 'textcheck') return actual.k === 'text' && c.checkIn !== null && setEq(c.checkIn, expected.values);
  if (expected.k === 'array') return actual.k === 'array' && JSON.stringify(actual.of) === JSON.stringify(expected.of);
  return JSON.stringify(actual) === JSON.stringify(expected);
}

let tsTables = new Map<string, TsMember[]>();

function contractPass(): void {
  R.section('4. Contract (rows.ts TableRowMap <-> CREATE TABLE)');
  tsTables = parseRows();
  const tableNames = ENUMS.TABLE_NAMES as readonly string[];
  if (!setEq([...tsTables.keys()], tableNames)) R.fail(`TableRowMap keys differ from TABLE_NAMES: ${[...tsTables.keys()].filter((k) => !tableNames.includes(k)).join(', ')} / ${tableNames.filter((k) => !tsTables.has(k)).join(', ')}`);
  let tablesOk = 0;
  let colsTotal = 0;
  for (const tn of tableNames) {
    const members = tsTables.get(tn);
    const t = M.tables.get(tn);
    if (!t) { R.fail(`table ${tn} is not created in SQL`); continue; }
    if (!members) continue;
    let ok = true;
    const tsNames = members.map((m) => m.name);
    for (const m of members) if (!t.cols.has(m.name)) { R.fail(`${tn}: column "${m.name}" (rows.ts) is missing in SQL [${t.origin.file}]`); ok = false; }
    for (const c of t.cols.keys()) if (!tsNames.includes(c)) { R.fail(`${tn}: extra column "${c}" in SQL that rows.ts does not have [${t.origin.file}:${t.cols.get(c)?.origin.line ?? '?'}]`); ok = false; }
    for (const m of members) {
      const c = t.cols.get(m.name);
      if (!c) continue;
      colsTotal++;
      const sqlNullable = !c.notNull;
      if (m.nullable !== sqlNullable) {
        R.fail(`${tn}.${m.name}: rows.ts says ${m.nullable ? 'nullable (| null)' : 'NOT NULL'} but SQL is ${sqlNullable ? 'nullable' : 'NOT NULL'} (${t.origin.file}:${c.origin.line})`);
        ok = false;
      }
      if (!kindMatches(m.kind, c)) {
        const actual = describe(sqlKind(c)) + (c.checkIn ? ` check in (${c.checkIn.join(', ')})` : '');
        R.fail(`${tn}.${m.name}: rows.ts type \`${m.tsText}\` expects ${describe(m.kind)} but SQL has ${actual} (${t.origin.file}:${c.origin.line})`);
        ok = false;
      }
    }
    // standard columns
    const hasId = t.cols.get('id');
    if (!hasId || !hasId.pk || hasId.type !== 'uuid' || !hasId.hasDefault) { R.fail(`${tn}: id must be "uuid primary key default gen_random_uuid()"`); ok = false; }
    if (ok) tablesOk++;
  }
  for (const name of M.tables.keys()) if (!tableNames.includes(name)) R.fail(`table ${name} exists in SQL but not in TABLE_NAMES`);
  if (tablesOk === tableNames.length) R.ok(`${tablesOk}/${tableNames.length} tables match rows.ts exactly (${colsTotal} columns: names, nullability and types)`);
  else R.info(`${tablesOk}/${tableNames.length} tables match rows.ts`);
}

/* ──────────────────────────────── 5. STRUCTURE ──────────────────────────────── */

const USER_REF_COLS = /^(created_by|updated_by|actor_id|uploaded_by|owner_id|approver_id|approved_by|requested_by|decided_by|logged_by|completed_by|verified_by|withdrawn_by|recorded_by|surveyor_id|assigned_to|reports_to|dsm_id|tax_approved_by|user_id)$/;

function structurePass(): void {
  R.section('5. Structure (keys, indexes, conventions)');
  const tableNames = ENUMS.TABLE_NAMES as readonly string[];
  const ledgers = new Set<string>(ENUMS.IMMUTABLE_TABLES as readonly string[]);

  // org_id
  let orgOk = 0;
  for (const tn of tableNames) {
    if (tn === 'organizations') continue;
    const fk = M.fks.find((f) => f.table === tn && f.cols.length === 1 && f.cols[0] === 'org_id');
    const c = M.tables.get(tn)?.cols.get('org_id');
    if (!c || !c.notNull || c.type !== 'uuid') { R.fail(`${tn}: org_id must be "uuid not null"`); continue; }
    if (!fk || fk.refTable !== 'organizations') { R.fail(`${tn}: org_id must reference organizations(id)`); continue; }
    orgOk++;
  }
  R.ok(`${orgOk}/${tableNames.length - 1} tables have org_id uuid NOT NULL -> organizations(id)`);

  // indexes leading with org_id
  let idxOk = 0;
  for (const tn of tableNames) {
    if (tn === 'organizations') continue;
    const has = M.indexes.some((i) => i.table === tn && i.cols[0] === 'org_id');
    if (has) idxOk++;
    else R.fail(`${tn}: no index leads with org_id`);
  }
  R.ok(`${idxOk}/${tableNames.length - 1} tables have an index that leads with org_id`);

  // timestamps per rows.ts are covered by the contract check; ledgers must not have updated_at
  for (const tn of ledgers) if (M.tables.get(tn)?.cols.has('updated_at')) R.fail(`${tn}: immutable ledger must not have updated_at`);

  // user-reference columns carry no FK
  let userFk = 0;
  for (const fk of M.fks) {
    for (const c of fk.cols) {
      if (USER_REF_COLS.test(c) && !(fk.table === 'user_territories' && c === 'user_id')) { R.fail(`${fk.table}.${c} is a user-reference column and must not have a foreign key (${fk.origin.file}:${fk.origin.line})`); userFk++; }
    }
  }
  if (!userFk) R.ok('no foreign keys on created_by / owner_id / actor_id / uploaded_by ... (only user_territories.user_id -> profiles)');

  // required unique indexes
  const uniqueNeeded: { table: string; cols: string[] }[] = [
    { table: 'quotations', cols: ['org_id', 'quote_no', 'version'] }, { table: 'proforma_invoices', cols: ['org_id', 'pi_no'] },
    { table: 'sales_orders', cols: ['org_id', 'so_no'] }, { table: 'dispatches', cols: ['org_id', 'dispatch_no'] },
    { table: 'warranty_tickets', cols: ['org_id', 'ticket_no'] }, { table: 'inventory_serials', cols: ['org_id', 'serial'] },
    { table: 'rule_config', cols: ['org_id', 'category', 'key', 'effective_from'] }, { table: 'pincodes', cols: ['org_id', 'pincode'] },
    { table: 'sku_compliance', cols: ['sku_id'] }, { table: 'segment_form_config', cols: ['org_id', 'segment', 'version'] },
    { table: 'gate_applicability', cols: ['org_id', 'gate', 'segment'] }, { table: 'message_templates', cols: ['org_id', 'key', 'language', 'version'] },
  ];
  let uOk = 0;
  for (const u of uniqueNeeded) {
    const t = M.tables.get(u.table);
    const found = M.indexes.some((i) => i.unique && i.table === u.table && !i.hasExpr && !i.partial && i.cols.join(',') === u.cols.join(','))
      || (t?.uniques.some((x) => x.join(',') === u.cols.join(',')) ?? false);
    if (found) uOk++;
    else R.fail(`${u.table}: missing unique constraint/index on (${u.cols.join(', ')})`);
  }
  R.ok(`${uOk}/${uniqueNeeded.length} required unique indexes present`);

  // GIN on array columns
  let arrays = 0;
  let arraysOk = 0;
  for (const [tn, t] of M.tables) {
    for (const c of t.cols.values()) {
      if (!c.isArray) continue;
      arrays++;
      if (M.indexes.some((i) => i.table === tn && i.method === 'gin' && i.cols.length === 1 && i.cols[0] === c.name)) arraysOk++;
      else R.fail(`${tn}.${c.name}: array column without a GIN index`);
    }
  }
  R.ok(`${arraysOk}/${arrays} array columns have a GIN index`);

  // leads specifics
  if (!M.indexes.some((i) => i.table === 'leads' && i.method === 'gin' && i.cols[0] === 'name' && i.opclasses.includes('gin_trgm_ops'))) R.fail('leads: missing pg_trgm GIN index on name');
  else R.ok('leads.name has a pg_trgm GIN index');
  if (!M.indexes.some((i) => i.table === 'leads' && i.partial)) R.fail('leads: missing partial index (deleted_at is null)');
  else R.ok('leads has partial (deleted_at is null) indexes');
  const softDelete = [...M.tables.values()].filter((t) => t.cols.has('deleted_at')).map((t) => t.name);
  if (softDelete.join(',') !== 'leads') R.fail(`soft delete (deleted_at) must exist only on leads, found: ${softDelete.join(', ')}`);
  else R.ok('soft delete exists only on leads');

  // forward FKs (relative to TABLE_NAMES order) must be deferrable so a transactional seed in TABLE_NAMES order works
  const order = new Map(tableNames.map((n, i) => [n, i] as const));
  let fwd = 0;
  let fwdBad = 0;
  for (const fk of M.fks) {
    const a = order.get(fk.table);
    const b = order.get(fk.refTable);
    if (a === undefined || b === undefined || fk.table === fk.refTable) continue;
    if (b > a) {
      fwd++;
      if (!(fk.deferrable && fk.initDeferred)) { R.fail(`FK ${fk.table}(${fk.cols.join(',')}) -> ${fk.refTable} points at a table that comes LATER in TABLE_NAMES, so it must be DEFERRABLE INITIALLY DEFERRED (${fk.origin.file}:${fk.origin.line})`); fwdBad++; }
    }
  }
  if (!fwdBad) R.ok(`${fwd} foreign keys point forward in TABLE_NAMES order and are all DEFERRABLE INITIALLY DEFERRED (seed can run in TABLE_NAMES order inside one transaction)`);

  // FK targets and columns exist
  let fkOk = 0;
  for (const fk of M.fks) {
    const parent = M.tables.get(fk.refTable);
    const child = M.tables.get(fk.table);
    if (!parent) { R.fail(`FK ${fk.table}(${fk.cols.join(',')}) references unknown table ${fk.refTable}`); continue; }
    if (!child) continue;
    const refCols = fk.refCols.length ? fk.refCols : parent.pk;
    let good = true;
    for (const c of fk.cols) if (!child.cols.has(c)) { R.fail(`FK on ${fk.table}: unknown column ${c}`); good = false; }
    for (const c of refCols) if (!parent.cols.has(c)) { R.fail(`FK ${fk.table} -> ${fk.refTable}: unknown referenced column ${c}`); good = false; }
    if (good) for (let i = 0; i < fk.cols.length; i++) {
      const a = child.cols.get(fk.cols[i] ?? '');
      const b = parent.cols.get(refCols[i] ?? '');
      if (a && b && (a.type !== b.type || a.isArray !== b.isArray)) { R.fail(`FK ${fk.table}.${fk.cols[i]} (${a.type}) and ${fk.refTable}.${refCols[i]} (${b.type}) have different types`); good = false; }
    }
    if (good) fkOk++;
  }
  R.ok(`${fkOk}/${M.fks.length} foreign keys resolve (tables, columns and types)`);

  // FK dependency order (immediate edges only)
  const deps = new Map<string, Set<string>>();
  for (const tn of tableNames) deps.set(tn, new Set());
  for (const fk of M.fks) if (fk.table !== fk.refTable && !(fk.deferrable && fk.initDeferred)) deps.get(fk.table)?.add(fk.refTable);
  const done: string[] = [];
  const remaining = new Set<string>(tableNames);
  let progress = true;
  while (remaining.size && progress) {
    progress = false;
    for (const tn of tableNames) {
      if (!remaining.has(tn)) continue;
      const d = deps.get(tn) ?? new Set<string>();
      if ([...d].every((x) => !remaining.has(x))) { remaining.delete(tn); done.push(tn); progress = true; }
    }
  }
  if (remaining.size) R.fail(`cycle in immediate foreign keys among: ${[...remaining].join(', ')}`);
  else {
    R.ok('immediate foreign keys are acyclic');
    R.info(`insert order for a NON-transactional load: ${done.join(' > ')}`);
  }

  // ON DELETE behaviour of references from immutable ledgers must not be CASCADE / SET NULL
  for (const fk of M.fks) {
    if (ledgers.has(fk.table) && (fk.onDelete === 'c' || fk.onDelete === 'n')) R.fail(`${fk.table}(${fk.cols.join(',')}) -> ${fk.refTable}: ledgers must use RESTRICT / NO ACTION (cascade or set null would UPDATE/DELETE immutable rows)`);
  }
}

/* ──────────────────────────────── 6. TRIGGERS ──────────────────────────────── */

function triggersPass(): void {
  R.section('6. Triggers (updated_at, audit, ledgers, guards)');
  const tableNames = ENUMS.TABLE_NAMES as readonly string[];
  const audited = new Set<string>(ENUMS.AUDITED_TABLES as readonly string[]);
  const ledgers = new Set<string>(ENUMS.IMMUTABLE_TABLES as readonly string[]);

  // updated_at
  const needUpdated = tableNames.filter((t) => tsTables.get(t)?.some((m) => m.name === 'updated_at'));
  let u = 0;
  for (const tn of needUpdated) {
    const ok = M.triggers.some((t) => t.table === tn && t.fn === 'set_updated_at' && t.before && t.row && (t.events & 16) === 16);
    if (ok) u++;
    else R.fail(`${tn}: no BEFORE UPDATE trigger calling app.set_updated_at()`);
  }
  for (const t of M.triggers) {
    if (t.fn === 'set_updated_at' && !M.tables.get(t.table)?.cols.has('updated_at')) R.fail(`trigger ${t.name} attaches set_updated_at to ${t.table}, which has no updated_at`);
  }
  R.ok(`${u}/${needUpdated.length} tables with updated_at have the set_updated_at trigger`);

  // audit
  let a = 0;
  for (const tn of audited) {
    const ok = M.triggers.some((t) => t.table === tn && t.fn === 'audit_row' && !t.before && t.row && t.events === 28);
    if (ok) a++;
    else R.fail(`${tn}: no AFTER INSERT OR UPDATE OR DELETE row trigger calling app.audit_row() (AUDITED_TABLES)`);
  }
  for (const t of M.triggers) if (t.fn === 'audit_row' && !audited.has(t.table)) R.fail(`trigger ${t.name}: ${t.table} is not in AUDITED_TABLES but has an audit trigger`);
  R.ok(`${a}/${audited.size} AUDITED_TABLES entries have an audit trigger; none on audit_log / lead_events / message_log / job_runs / kpi_snapshots / notifications / clocks / dnd_register / lead_scores / organizations`);

  // ledgers
  for (const tn of ledgers) {
    const has = M.triggers.some((t) => t.table === tn && (t.fn === 'block_ledger_mutation' || (tn === 'message_log' && t.fn === 'message_log_redaction_only')) && t.before && t.row && (t.events & 24) === 24);
    if (!has) R.fail(`${tn}: missing BEFORE UPDATE OR DELETE immutability trigger`);
  }
  if (!M.triggers.some((t) => t.table === 'lead_consents' && t.fn === 'guard_consent_change' && t.before)) R.fail('lead_consents: missing consent guard trigger');
  R.ok('immutability triggers present on audit_log, lead_events, message_log, distributor_score_history; consent guard on lead_consents');

  const need: { table: string; fn: string; label: string }[] = [
    { table: 'opportunities', fn: 'guard_opportunity', label: 'opportunity guard (3 confirmations)' },
    { table: 'sales_orders', fn: 'guard_sales_order', label: 'sales-order guard (G11)' },
    { table: 'dispatches', fn: 'guard_dispatch', label: 'dispatch guard' },
    { table: 'dispatch_serials', fn: 'guard_dispatch_serial', label: 'dispatch serial guard' },
    { table: 'rule_config', fn: 'guard_rule_source', label: 'rule source_ref guard' },
    { table: 'leads', fn: 'lead_status_event', label: 'lead status -> lead_events' },
  ];
  for (const n of need) {
    if (!M.triggers.some((t) => t.table === n.table && t.fn === n.fn)) R.fail(`${n.table}: missing trigger for ${n.label}`);
  }
  R.ok('guard triggers present: opportunities, sales_orders, dispatches, dispatch_serials, rule_config, leads status event');

  // trigger -> function existence and return type
  for (const t of M.triggers) {
    const f = M.functions.find((x) => x.schema === 'app' && x.name === t.fn);
    if (!f) R.fail(`trigger ${t.name} on ${t.table}: function app.${t.fn} is not defined`);
    else if (f.returns !== 'trigger') R.fail(`trigger ${t.name}: app.${t.fn} does not return trigger`);
  }

  // security-definer functions need a pinned search_path
  for (const f of M.functions) if (f.security && !f.searchPath) R.fail(`${f.origin.file}:${f.origin.line} SECURITY DEFINER function ${f.schema}.${f.name} has no SET search_path`);
  R.ok('every SECURITY DEFINER function pins its search_path');

  // guard functions raise P0001 with a message
  for (const name of ['guard_opportunity', 'guard_sales_order', 'guard_dispatch', 'guard_dispatch_serial', 'guard_rule_source', 'block_ledger_mutation', 'guard_consent_change']) {
    const f = M.functions.find((x) => x.name === name);
    if (!f) { R.fail(`function app.${name} is missing`); continue; }
    if (!/errcode\s*=\s*'P0001'/i.test(f.body)) R.fail(`app.${name} does not raise with errcode 'P0001'`);
  }
  R.ok("guard functions raise SQLSTATE 'P0001' (API maps it to GUARD_BLOCKED)");
}

/* ──────────────────────────────── 7. RLS ──────────────────────────────── */

function rlsPass(): void {
  R.section('7. Row level security');
  const tableNames = ENUMS.TABLE_NAMES as readonly string[];
  const rlsOn = new Set<string>();
  for (const s of M.statements) {
    if (s.type !== 'AlterTableStmt' || !s.origin.file.startsWith('09_')) continue;
    for (const c of asArr(s.node['cmds'])) if (str(unwrap(c)?.[1]['subtype']) === 'AT_EnableRowSecurity') rlsOn.add(relName(s.node['relation']).name);
  }
  let r = 0;
  let p = 0;
  for (const tn of tableNames) {
    if (rlsOn.has(tn)) r++;
    else R.fail(`${tn}: row level security is not enabled in 09_rls_policies.sql`);
    const pols = M.policies.filter((x) => x.table === tn && x.schema !== 'storage' && x.origin.file.startsWith('09_'));
    if (pols.length) p++;
    else R.fail(`${tn}: RLS is enabled but no policy is defined (table would be unreadable)`);
  }
  R.ok(`${r}/${tableNames.length} tables have RLS enabled in 09; ${p}/${tableNames.length} have at least one policy`);

  // insert-only ledgers: no update/delete/all policy
  for (const tn of ['audit_log', 'lead_events', 'message_log', 'distributor_score_history']) {
    const bad = M.policies.filter((x) => x.table === tn && ['update', 'delete', 'all'].includes(x.cmd));
    if (bad.length) R.fail(`${tn}: ledger must be insert-only but has ${bad.map((b) => `${b.name}(${b.cmd})`).join(', ')}`);
  }
  R.ok('audit_log, lead_events, message_log, distributor_score_history have no update/delete policy');
  const f09 = sqlFiles.find((f) => f.name.startsWith('09_'))?.text ?? '';
  if (!/revoke\s+update,\s*delete,\s*truncate\s+on\s+public\.audit_log,\s*public\.lead_events,\s*public\.message_log/i.test(f09)) R.fail('09: missing REVOKE update, delete, truncate on the insert-only ledgers');
  else R.ok('UPDATE/DELETE/TRUNCATE revoked on the ledgers');

  // every policy is dropped before it is created
  const drops = new Set<string>();
  for (const s of M.statements) if (s.type === 'DropStmt' && str(s.node['removeType']) === 'OBJECT_POLICY') {
    const objs = asArr(s.node['objects']);
    const names = objs.map((o) => strList(o));
    for (const n of names) drops.add(n.slice(-2).join('.'));
    // DROP POLICY name ON table => objects = [[table..., policy]]
  }
  let undropped = 0;
  for (const pol of M.policies) if (!drops.has(`${pol.table}.${pol.name}`)) { R.fail(`policy ${pol.name} on ${pol.table} has no preceding "drop policy if exists" (${pol.origin.file}:${pol.origin.line})`); undropped++; }
  if (!undropped) R.ok(`all ${M.policies.length} policies are preceded by drop policy if exists`);

  // helper functions
  for (const fnName of ['current_org', 'current_role', 'current_distributor', 'current_dealer']) {
    const f = M.functions.find((x) => x.schema === 'app' && x.name === fnName);
    if (!f) R.fail(`app.${fnName}() is not defined`);
    else if (!f.security) R.fail(`app.${fnName}() must be SECURITY DEFINER`);
  }
  R.ok('app.current_org(), current_role(), current_distributor(), current_dealer() are defined as SECURITY DEFINER');
}

/* ──────────────────────────────── 8. SEMANTIC LINT ──────────────────────────────── */

function fnArity(name: string): { min: number; max: number }[] {
  return M.functions.filter((f) => f.schema === 'app' && f.name === name).map((f) => ({
    min: f.params.filter((p) => !p.hasDefault && !p.variadic).length,
    max: f.params.some((p) => p.variadic) ? Number.POSITIVE_INFINITY : f.params.length,
  }));
}

interface LintCtx { label: string; origin: Origin; newOldTables: string[]; recVars: Map<string, string>; bareTable?: string }

function lint(root: unknown, ctx: LintCtx): void {
  const where = `${ctx.origin.file}:${ctx.origin.line} ${ctx.label}`;
  const cteNames = new Set<string>();
  walk(root, (t, n) => { if (t === 'CommonTableExpr') { const nm = str(n['ctename']); if (nm) cteNames.add(nm); } });
  const alias = new Map<string, string | null>();
  const reg = (a: string, target: string | null): void => {
    if (alias.has(a) && alias.get(a) !== target) alias.set(a, '?');
    else alias.set(a, target);
  };
  const reported = new Set<string>();
  const once = (msg: string): void => { if (!reported.has(msg)) { reported.add(msg); R.fail(`${where}: ${msg}`); } };

  walk(root, (t, n) => {
    if (t === 'RangeVar') {
      const schema = str(n['schemaname']);
      const name = str(n['relname']) ?? '';
      const a = isObj(n['alias']) ? str((n['alias'] as Node)['aliasname']) : undefined;
      const key = a ?? name;
      if (schema && schema !== 'public') { reg(key, null); return; }
      if (!schema && cteNames.has(name)) { reg(key, null); return; }
      if (M.tables.has(name)) reg(key, name);
      else if (M.views.has(name)) reg(key, null);
      else { once(`unknown relation "${name}"`); reg(key, null); }
    } else if (t === 'RangeSubselect' || t === 'RangeFunction') {
      const a = isObj(n['alias']) ? str((n['alias'] as Node)['aliasname']) : undefined;
      if (a) reg(a, null);
    }
  });

  const checkCol = (table: string, col: string, ref: string): void => {
    const tb = M.tables.get(table);
    if (tb && col !== '*' && !tb.cols.has(col)) once(`unknown column ${ref} (table ${table} has no "${col}")`);
  };

  // Column (if resolvable) behind a ColumnRef node
  const colOf = (node: unknown): Col | undefined => {
    const u = unwrap(node);
    if (!u || u[0] !== 'ColumnRef') return undefined;
    const f = strList(u[1]['fields']);
    let table: string | undefined;
    let col: string | undefined;
    if (f.length === 2) {
      const q = f[0] ?? '';
      const target = alias.get(q);
      if (typeof target === 'string' && target !== '?') table = target;
      else if (target === undefined) table = ctx.recVars.get(q) ?? ((q === 'new' || q === 'old') && ctx.newOldTables.length === 1 ? ctx.newOldTables[0] : undefined);
      col = f[1];
    } else if (f.length === 1 && ctx.bareTable) {
      table = ctx.bareTable;
      col = f[0];
    }
    return table && col ? M.tables.get(table)?.cols.get(col) : undefined;
  };
  // String constants behind an A_Const or a list of them
  const constsOf = (node: unknown): string[] | null => {
    const u = unwrap(node);
    if (!u) return null;
    if (u[0] === 'A_Const' && isObj(u[1]['sval'])) return [str((u[1]['sval'] as Node)['sval']) ?? ''];
    if (u[0] === 'List') {
      const out: string[] = [];
      for (const it of asArr(u[1]['items'])) { const c = constsOf(it); if (!c) return null; out.push(...c); }
      return out;
    }
    return null;
  };
  // A literal compared with an enum / CHECK-constrained column must be one of its values
  const checkLiterals = (c: Col | undefined, vals: string[] | null, ref: string): void => {
    if (!c || !vals) return;
    const allowed = M.enums.get(c.type)?.values ?? c.checkIn ?? null;
    if (!allowed) return;
    for (const v of vals) if (!allowed.includes(v)) once(`'${v}' is not a valid value for ${ref} (${c.isArray ? 'array of ' : ''}${M.enums.has(c.type) ? `enum ${c.type}` : 'CHECK list'}: ${allowed.join(', ')})`);
  };

  walk(root, (t, n) => {
    if (t === 'A_Expr') {
      const kind = str(n['kind']);
      const op = strList(n['name'])[0] ?? '';
      if (kind === 'AEXPR_IN') checkLiterals(colOf(n['lexpr']), constsOf(n['rexpr']), 'IN list');
      else if (kind === 'AEXPR_OP' && (op === '=' || op === '<>' || op === '!=')) {
        checkLiterals(colOf(n['lexpr']), constsOf(n['rexpr']), `comparison ${op}`);
        checkLiterals(colOf(n['rexpr']), constsOf(n['lexpr']), `comparison ${op}`);
      } else if (kind === 'AEXPR_OP_ANY') checkLiterals(colOf(n['rexpr']), constsOf(n['lexpr']), 'ANY()');
    } else if (t === 'CaseExpr') {
      const c = colOf(n['arg']);
      for (const w of asArr(n['args'])) { const wu = unwrap(w); if (wu) checkLiterals(c, constsOf(wu[1]['expr']), 'CASE WHEN'); }
    }
  });

  walk(root, (t, n) => {
    if (t === 'ColumnRef') {
      const f = strList(n['fields']);
      if (f.length >= 2 && f.length <= 2) {
        const q = f[0] ?? '';
        const c = f[1] ?? '';
        const target = alias.get(q);
        if (typeof target === 'string' && target !== '?') checkCol(target, c, `${q}.${c}`);
        else if (target === undefined) {
          const rv = ctx.recVars.get(q);
          if (rv) checkCol(rv, c, `${q}.${c}`);
          else if ((q === 'new' || q === 'old') && ctx.newOldTables.length) for (const tb of ctx.newOldTables) checkCol(tb, c, `${q}.${c} (trigger table ${tb})`);
        }
      }
    } else if (t === 'FuncCall') {
      const fn = strList(n['funcname']);
      if (fn.length === 2 && fn[0] === 'app') {
        const ar = fnArity(fn[1] ?? '');
        const nargs = asArr(n['args']).length;
        if (!ar.length) once(`call to undefined function app.${fn[1]}()`);
        else if (!ar.some((a) => nargs >= a.min && nargs <= a.max)) once(`app.${fn[1]}() called with ${nargs} argument(s); signature allows ${ar.map((a) => `${a.min}-${a.max === Number.POSITIVE_INFINITY ? 'n' : a.max}`).join(' or ')}`);
      }
    } else if (t === 'InsertStmt') {
      const rv = relName(n['relation']);
      if ((!rv.schema || rv.schema === 'public') && M.tables.has(rv.name)) for (const c of asArr(n['cols'])) { const u = unwrap(c); const nm = u ? str(u[1]['name']) : undefined; if (nm) checkCol(rv.name, nm, `insert column ${nm}`); }
    } else if (t === 'UpdateStmt') {
      const rv = relName(n['relation']);
      if ((!rv.schema || rv.schema === 'public') && M.tables.has(rv.name)) for (const c of asArr(n['targetList'])) { const u = unwrap(c); const nm = u ? str(u[1]['name']) : undefined; if (nm) checkCol(rv.name, nm, `update column ${nm}`); }
    }
  });

  if (ctx.bareTable && M.tables.has(ctx.bareTable)) {
    const tb = M.tables.get(ctx.bareTable);
    const visit = (v: unknown): void => {
      if (Array.isArray(v)) { v.forEach(visit); return; }
      if (!isObj(v)) return;
      for (const [k, val] of Object.entries(v)) {
        if (k === 'SubLink') continue; // bare names inside a sub-select belong to its own FROM
        if (k === 'ColumnRef' && isObj(val)) {
          const f = strList(val['fields']);
          if (f.length === 1 && tb && f[0] !== undefined && !tb.cols.has(f[0])) once(`unknown column "${f[0]}" (table ${ctx.bareTable})`);
        }
        visit(val);
      }
    };
    visit(root);
  }
}

function semanticPass(): void {
  R.section('8. Semantic lint (column references, relations, helper-function calls)');
  const before = R.errors;
  let units = 0;

  // trigger functions -> tables they are attached to
  const attached = new Map<string, string[]>();
  for (const t of M.triggers) attached.set(t.fn, [...(attached.get(t.fn) ?? []), t.table]);

  for (const e of embedded) {
    units++;
    const tabs = e.fn ? [...new Set(attached.get(e.fn.name) ?? [])] : [];
    lint(e.ast, { label: `function ${e.label}`, origin: e.origin, newOldTables: tabs, recVars: e.vars });
  }
  for (const s of M.statements) {
    const where = `${s.origin.file}:${s.origin.line}`;
    if (s.type === 'ViewStmt') {
      units++;
      lint(s.node['query'], { label: `view ${relName(s.node['view']).name}`, origin: s.origin, newOldTables: [], recVars: new Map() });
    } else if (s.type === 'CreatePolicyStmt') {
      units++;
      const rv = relName(s.node['table']);
      if (rv.schema === 'storage') { lint([s.node['qual'], s.node['with_check']], { label: `policy ${str(s.node['policy_name'])}`, origin: s.origin, newOldTables: [], recVars: new Map() }); continue; }
      if (!M.tables.has(rv.name)) { R.fail(`${where} policy on unknown table ${rv.name}`); continue; }
      lint([s.node['qual'], s.node['with_check']], { label: `policy ${str(s.node['policy_name'])} on ${rv.name}`, origin: s.origin, newOldTables: [], recVars: new Map(), bareTable: rv.name });
    } else if (s.type === 'IndexStmt') {
      units++;
      const tn = relName(s.node['relation']).name;
      const tb = M.tables.get(tn);
      if (!tb) { R.fail(`${where} index ${str(s.node['idxname'])} on unknown table ${tn}`); continue; }
      for (const p of asArr(s.node['indexParams'])) {
        const u = unwrap(p);
        const nm = u ? str(u[1]['name']) : undefined;
        if (nm && !tb.cols.has(nm)) R.fail(`${where} index ${str(s.node['idxname'])}: unknown column ${tn}.${nm}`);
      }
      lint([asArr(s.node['indexParams']).map((p) => unwrap(p)?.[1]['expr']), s.node['whereClause']], { label: `index ${str(s.node['idxname'])}`, origin: s.origin, newOldTables: [], recVars: new Map(), bareTable: tn });
    } else if (s.type === 'CreateTrigStmt') {
      units++;
      const tn = relName(s.node['relation']).name;
      if (!M.tables.has(tn)) { R.fail(`${where} trigger on unknown table ${tn}`); continue; }
      lint(s.node['whenClause'], { label: `trigger ${str(s.node['trigname'])}`, origin: s.origin, newOldTables: [tn], recVars: new Map() });
      for (const c of strList(s.node['columns'])) if (!M.tables.get(tn)?.cols.has(c)) R.fail(`${where} trigger ${str(s.node['trigname'])}: unknown column ${tn}.${c}`);
    } else if (s.type === 'AlterTableStmt' || s.type === 'CreateStmt') {
      const tn = relName(s.node['relation']).name;
      if (s.type === 'AlterTableStmt' && !M.tables.has(tn)) R.fail(`${where} ALTER TABLE on unknown table ${tn}`);
      // CHECK / DEFAULT expressions only reference the table's own columns
      const t = M.tables.get(tn);
      if (t) {
        walk(s.node, (nt, nn) => {
          if (nt === 'Constraint' && nn['contype'] === 'CONSTR_CHECK') {
            units++;
            lint(nn['raw_expr'], { label: `check on ${tn}`, origin: s.origin, newOldTables: [], recVars: new Map(), bareTable: tn });
          }
        });
      }
    }
  }
  if (R.errors === before) R.ok(`${units} policies/views/indexes/triggers/functions/checks resolved against the declared tables and helper functions`);
}

/* ──────────────────────────────── 9. OBJECTS ──────────────────────────────── */

function objectsPass(): void {
  R.section('9. Required objects');
  const fnNeeded: { name: string; nargs?: number }[] = [
    { name: 'set_updated_at' }, { name: 'audit_row' }, { name: 'normalize_mobile', nargs: 1 }, { name: 'find_lead_duplicates', nargs: 7 },
    { name: 'compute_lead_score', nargs: 1 }, { name: 'next_working_time' }, { name: 'rule_value' }, { name: 'current_uid' },
    { name: 'current_org' }, { name: 'current_role' }, { name: 'current_distributor' }, { name: 'current_dealer' },
  ];
  for (const n of fnNeeded) {
    const f = M.functions.find((x) => x.schema === 'app' && x.name === n.name);
    if (!f) R.fail(`function app.${n.name} is missing`);
    else if (n.nargs !== undefined && f.params.length !== n.nargs) R.fail(`app.${n.name} should take ${n.nargs} parameters, has ${f.params.length}`);
  }
  const dup = M.functions.find((x) => x.name === 'find_lead_duplicates');
  if (dup) {
    const want = ['p_org', 'p_mobile', 'p_email', 'p_consumer_no', 'p_name', 'p_pincode', 'p_exclude'];
    if (dup.params.map((p) => p.name).join(',') !== want.join(',')) R.fail(`app.find_lead_duplicates parameters must be (${want.join(', ')})`);
    if (!/\breason\b/.test(dup.stmtText.split(/\bas\s*\$/i)[0] ?? '')) R.fail('app.find_lead_duplicates must return a "reason" column');
  }
  const nwt = M.functions.find((x) => x.name === 'next_working_time');
  if (nwt && nwt.params.filter((p) => !p.hasDefault).length !== 2) R.fail('app.next_working_time must have exactly two required parameters (ts, hours)');
  R.ok('functions: normalize_mobile, find_lead_duplicates(7), compute_lead_score, next_working_time, rule_value, session and RLS helpers');

  const views = ['v_funnel', 'v_lead_sla_breaches', 'v_followup_overdue', 'v_discom_stage_ageing', 'v_cfa_pending', 'v_dealer_exposure', 'v_stock_exposure_non_list2', 'v_compliance_block_rate', 'v_consent_coverage'];
  for (const v of views) {
    const vw = M.views.get(v);
    if (!vw) R.fail(`view ${v} is missing`);
    else if (!vw.options.includes('security_invoker=true')) R.fail(`view ${v} must be created WITH (security_invoker = true)`);
  }
  R.ok(`${views.length} views present, all security_invoker`);
  const f10 = sqlFiles.find((f) => f.name.startsWith('10_'))?.text ?? '';
  if (!/percentile_cont\(0\.5\)/.test(f10) || !/percentile_cont\(0\.9\)/.test(f10)) R.fail('v_discom_stage_ageing must use percentile_cont for median and p90');
  if (!/Node API computes the same KPIs/i.test(f10)) R.fail('10_views.sql must document that the Node API computes the same KPIs (parity note)');

  const f11 = sqlFiles.find((f) => f.name.startsWith('11_'))?.text ?? '';
  const buckets = ENUMS.DOCUMENT_BUCKETS as readonly string[];
  for (const b of buckets) {
    if (!new RegExp(`\\('${b}',\\s*'${b}',\\s*false,\\s*10485760`).test(f11)) R.fail(`11: bucket ${b} must be inserted as private (public=false) with a 10 MB limit`);
  }
  if (!/on conflict \(id\) do nothing/i.test(f11)) R.fail('11: buckets must be inserted with ON CONFLICT DO NOTHING');
  const storagePols = M.policies.filter((p) => p.schema === 'storage' && p.table === 'objects');
  if (storagePols.length < 3) R.fail('11: expected policies on storage.objects');
  if (!/storage\.foldername\(name\)\)\[1\]\s*=\s*\(select app\.current_org\(\)\)::text/.test(f11)) R.fail('11: policies must scope by (storage.foldername(name))[1] = app.current_org()::text');
  R.ok(`${buckets.length} private buckets (${buckets.join(', ')}) + ${storagePols.length} org-scoped storage.objects policies`);

  const runOrder = join(SQL_DIR, 'RUN_ORDER.md');
  if (!existsSync(runOrder)) R.fail('RUN_ORDER.md is missing');
  else {
    const md = readFileSync(runOrder, 'utf8');
    for (const must of ['12_seed_reference', '13_first_admin', 'service_role']) {
      if (!md.includes(must)) R.fail(`RUN_ORDER.md does not mention "${must}"`);
    }
    R.ok('RUN_ORDER.md present and covers seed (12), first admin (13), key rotation');
  }
}

/* ──────────────────────────────── main ──────────────────────────────── */

/* ──────────────────────────────── 10. SEED vs SCHEMA ──────────────────────────────── */

type Cell = string | number | boolean | null | undefined;

function cellOf(v: unknown): Cell {
  const u = unwrap(v);
  if (!u) return undefined;
  const [t, n] = u;
  if (t === 'TypeCast') return cellOf(n['arg']);
  if (t !== 'A_Const') return undefined;
  if (n['isnull'] === true) return null;
  if (isObj(n['sval'])) return str((n['sval'] as Node)['sval']);
  if (isObj(n['ival'])) return typeof (n['ival'] as Node)['ival'] === 'number' ? ((n['ival'] as Node)['ival'] as number) : 0;
  if (isObj(n['fval'])) return Number(str((n['fval'] as Node)['fval']));
  if (isObj(n['boolval'])) return (n['boolval'] as Node)['boolval'] === true;
  return undefined;
}

/** Tiny evaluator for the CHECK expressions used in the schema. Returns undefined when it cannot decide (treated as pass). */
function evalCheck(expr: unknown, row: Record<string, Cell>): boolean | undefined {
  const val = (e: unknown): Cell => {
    const u = unwrap(e);
    if (!u) return undefined;
    if (u[0] === 'ColumnRef') return row[strList(u[1]['fields'])[0] ?? ''];
    if (u[0] === 'FuncCall') {
      const fn = strList(u[1]['funcname']).pop();
      const a = asArr(u[1]['args']).map(val);
      if (fn === 'btrim') return typeof a[0] === 'string' ? a[0].trim() : a[0];
      if (fn === 'coalesce') return a.find((x) => x !== null && x !== undefined);
      return undefined;
    }
    if (u[0] === 'CoalesceExpr') return asArr(u[1]['args']).map(val).find((x) => x !== null && x !== undefined);
    return cellOf(e);
  };
  const u = unwrap(expr);
  if (!u) return undefined;
  switch (u[0]) {
    case 'BoolExpr': {
      const parts = asArr(u[1]['args']).map((a) => evalCheck(a, row));
      const op = u[1]['boolop'];
      if (op === 'AND_EXPR') return parts.some((p) => p === false) ? false : parts.every((p) => p === true) ? true : undefined;
      if (op === 'OR_EXPR') return parts.some((p) => p === true) ? true : parts.every((p) => p === false) ? false : undefined;
      return parts[0] === undefined ? undefined : !parts[0];
    }
    case 'NullTest': {
      const v = val(u[1]['arg']);
      if (v === undefined) return undefined;
      return u[1]['nulltesttype'] === 'IS_NULL' ? v === null : v !== null;
    }
    case 'A_Expr': {
      const kind = str(u[1]['kind']);
      const op = strList(u[1]['name'])[0] ?? '';
      const l = val(u[1]['lexpr']);
      if (l === undefined) return undefined;
      if (l === null) return true; // SQL: a NULL operand makes a CHECK pass
      if (kind === 'AEXPR_IN') {
        const items = asArr((unwrap(u[1]['rexpr'])?.[1] ?? {})['items']).map(cellOf);
        return items.includes(l);
      }
      const r = val(u[1]['rexpr']);
      if (r === undefined) return undefined;
      if (r === null) return true;
      switch (op) {
        case '=': return l === r;
        case '<>': return l !== r;
        case '>=': return l >= r;
        case '<=': return l <= r;
        case '>': return l > r;
        case '<': return l < r;
        case '~': return typeof l === 'string' && typeof r === 'string' ? new RegExp(r).test(l) : undefined;
        default: return undefined;
      }
    }
    default: return undefined;
  }
}

async function seedPass(): Promise<void> {
  const seed = sqlFiles.find((f) => f.name.startsWith('12_'));
  if (!seed) return;
  R.section('10. Seed file vs schema (12_seed_reference.sql is read, never executed)');
  const rows = new Map<string, Record<string, Cell>[]>();
  let ast;
  try {
    ast = await parse(seed.text);
  } catch {
    return;
  }
  for (const st of ast.stmts) {
    const u = unwrap(st.stmt);
    if (!u || u[0] !== 'InsertStmt') continue;
    const rv = relName(u[1]['relation']);
    const cols = asArr(u[1]['cols']).map((c) => str(unwrap(c)?.[1]['name']) ?? '');
    const sel = unwrap(u[1]['selectStmt']);
    for (const lst of asArr(sel?.[1]['valuesLists'])) {
      const items = asArr((unwrap(lst)?.[1] ?? {})['items']);
      const row: Record<string, Cell> = {};
      cols.forEach((c, i) => { row[c] = cellOf(items[i]); });
      const arr = rows.get(rv.name) ?? [];
      arr.push(row);
      rows.set(rv.name, arr);
    }
    if (!M.tables.has(rv.name)) R.fail(`12:${lineAt(seed, st.stmt_location ?? 0)} insert into unknown table ${rv.name}`);
  }
  let total = 0;
  const problems = new Set<string>();
  const bad = (m: string): void => {
    if (!problems.has(m)) { problems.add(m); R.fail(m); }
  };
  for (const [tn, list] of rows) {
    const t = M.tables.get(tn);
    if (!t) continue;
    total += list.length;
    const given = new Set(Object.keys(list[0] ?? {}));
    for (const c of given) if (!t.cols.has(c)) bad(`seed ${tn}: column "${c}" does not exist`);
    for (const c of t.cols.values()) if (c.notNull && !c.hasDefault && !given.has(c.name)) bad(`seed ${tn}: required column "${c.name}" (NOT NULL, no default) is not supplied`);
    const uniq: { cols: string[]; seen: Set<string> }[] = [];
    if (t.cols.has('id')) uniq.push({ cols: ['id'], seen: new Set() });
    for (const i of M.indexes) if (i.table === tn && i.unique && !i.partial && !i.hasExpr) uniq.push({ cols: i.cols, seen: new Set() });
    list.forEach((row, ix) => {
      for (const c of t.cols.values()) {
        const v = row[c.name];
        if (c.notNull && v === null) bad(`seed ${tn} row ${ix + 1}: NULL in NOT NULL column "${c.name}"`);
        if (typeof v === 'string' && !c.isArray) {
          const allowed = M.enums.get(c.type)?.values ?? c.checkIn;
          if (allowed && !allowed.includes(v)) bad(`seed ${tn}.${c.name}: '${v}' is not allowed (${allowed.join(', ')})`);
        }
      }
      for (const chk of t.checks) if (evalCheck(chk, row) === false) bad(`seed ${tn} row ${ix + 1}: violates a CHECK constraint (${JSON.stringify(row).slice(0, 120)}...)`);
      for (const u of uniq) {
        const key = u.cols.map((c) => row[c]);
        if (key.some((k) => k === null || k === undefined)) continue;
        const k = JSON.stringify(key);
        if (u.seen.has(k)) bad(`seed ${tn}: duplicate key (${u.cols.join(', ')}) = ${k}`);
        u.seen.add(k);
      }
    });
  }
  // referential integrity inside the seed (single-column foreign keys)
  for (const fk of M.fks) {
    if (fk.cols.length !== 1) continue;
    const list = rows.get(fk.table);
    if (!list) continue;
    const col = fk.cols[0] ?? '';
    const parentIds = new Set((rows.get(fk.refTable) ?? []).map((r) => r[fk.refCols[0] ?? 'id']));
    for (const row of list) {
      const v = row[col];
      if (typeof v === 'string' && !parentIds.has(v)) bad(`seed ${fk.table}.${col} = ${v} has no matching ${fk.refTable} row in the seed`);
    }
  }
  if (!problems.size) R.ok(`${total} seed rows in ${rows.size} tables: columns exist, NOT NULL satisfied, enum/CHECK values valid, unique keys distinct, foreign keys resolve inside the seed`);
}

async function main(): Promise<void> {
  console.log('Future Solar CRM - SQL static check (parse only; nothing is executed)');
  await syntaxPass();
  if (R.errors === 0 || M.tables.size > 0) {
    safetyPass();
    enumsPass();
    try { contractPass(); } catch (e) { R.fail(`contract check crashed: ${(e as Error).message}`); }
    structurePass();
    triggersPass();
    rlsPass();
    semanticPass();
    objectsPass();
    await seedPass();
  }
  R.print();
  console.log('');
  console.log(R.errors === 0 ? `RESULT: PASS (${R.warnings} warning(s))` : `RESULT: FAIL - ${R.errors} problem(s), ${R.warnings} warning(s)`);
  process.exit(R.errors === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
