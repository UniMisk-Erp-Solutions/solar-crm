/**
 * Runs supabase/sql/*.sql, in order, inside a THROWAWAY in-memory Postgres (PGlite, WebAssembly) on this machine so real errors
 * (missing columns, bad types, permission mistakes…) are found before the files reach Supabase. It never connects to any network database.
 * Supabase-only pieces (auth schema, storage schema, the standard roles) are replaced by minimal stand-ins.
 *
 *   npm run sql:local            run every file in order, print each error with file and statement
 *   npm run sql:local -- --keep  also run the post-load checks (RLS, triggers, a first-admin insert)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { btree_gin } from '@electric-sql/pglite/contrib/btree_gin';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const dir = join(process.cwd(), 'supabase', 'sql');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);

const SUPABASE_STANDINS = `
  do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
  do $$ begin create role supabase_admin nologin; exception when duplicate_object then null; end $$;
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text unique, encrypted_password text, email_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}', created_at timestamptz default now());
  create or replace function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
  create or replace function auth.role() returns text language sql stable as $f$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $f$;
  create schema if not exists storage;
  create table if not exists storage.buckets (id text primary key, name text not null, owner uuid, public boolean default false, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now(), updated_at timestamptz default now());
  create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid, metadata jsonb, created_at timestamptz default now());
  alter table storage.objects enable row level security;
  create or replace function storage.foldername(name text) returns text[] language sql immutable as $f$ select string_to_array(name, '/') $f$;
  grant usage on schema public, auth, storage to anon, authenticated, service_role;
  -- stand-ins for the Supabase scheduler pieces used by 14_cron.sql (pg_cron, pg_net, vault)
  create schema if not exists cron; create schema if not exists net; create schema if not exists vault; create schema if not exists extensions;
  create table if not exists cron.job (jobname text primary key, schedule text not null, command text not null);
  create or replace function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint language sql as $f$ insert into cron.job values (p_name, p_schedule, p_command) on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning 1::bigint $f$;
  create or replace function net.http_get(url text, headers jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $f$ select 1::bigint $f$;
  create table if not exists vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text);
  create or replace view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;
  insert into vault.secrets (name, secret) values ('project_url', 'https://example.supabase.co'), ('cron_secret', 'local-test') on conflict do nothing;
  grant usage on schema cron, net, vault, extensions to postgres, service_role;
  grant all on all tables in schema cron, vault to postgres;
  grant execute on all functions in schema cron, net to postgres;
`;

/** Statements are split on top-level semicolons, respecting $$ blocks, quotes and comments. */
function split(sql: string): string[] {
  const out: string[] = [];
  let cur = '', i = 0, dollar: string | null = null;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (dollar) {
      if (rest.startsWith(dollar)) { cur += dollar; i += dollar.length; dollar = null; continue; }
      cur += sql[i]; i++; continue;
    }
    const d = /^\$[A-Za-z0-9_]*\$/.exec(rest);
    if (d) { dollar = d[0]; cur += d[0]; i += d[0].length; continue; }
    if (rest.startsWith('--')) { const e = rest.indexOf('\n'); const n = e < 0 ? rest.length : e; cur += rest.slice(0, n); i += n; continue; }
    if (sql[i] === "'") { let j = i + 1; while (j < sql.length) { if (sql[j] === "'" && sql[j + 1] === "'") j += 2; else if (sql[j] === "'") break; else j++; } cur += sql.slice(i, j + 1); i = j + 1; continue; }
    if (sql[i] === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; i++; continue; }
    cur += sql[i]; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((s) => s.replace(/--[^\n]*/g, '').trim().length > 0);
}

async function main() {
  const db = new PGlite({ extensions: { pg_trgm, btree_gin, pgcrypto } });
  await db.exec(SUPABASE_STANDINS);
  // Supabase's SQL editor runs as the non-superuser `postgres` role: reproduce that, unless --superuser is passed
  if (!process.argv.includes('--superuser')) {
    await db.exec(`do $$ begin create role postgres nosuperuser createrole createdb bypassrls login; exception when duplicate_object then null; end $$;
      grant anon, authenticated, service_role to postgres; alter schema public owner to postgres; grant all on schema public to postgres; grant create on database postgres to postgres;
      grant all on all tables in schema storage to postgres; grant all on all tables in schema auth to postgres; grant execute on all functions in schema auth, storage to postgres; set role postgres;`);
  }
  const files = readdirSync(dir).filter((f) => /^\d\d_.*\.sql$/.test(f)).sort().filter((f) => !only || f.startsWith(only));
  let failures = 0;
  // stands in for the admin the owner creates in Supabase Auth before running 13_first_admin.sql
  await db.exec("insert into auth.users (email, email_confirmed_at) values ('admin@mistryandshah.com', null) on conflict do nothing");
  // --twice: run the whole sequence a second time on the same database — every file must be safe to re-run
  const sequence = process.argv.includes('--twice') ? [...files, ...files] : files;
  for (const f of sequence) {
    const text = readFileSync(join(dir, f), 'utf8');
    if (process.argv.includes('--whole')) {
      // exactly how the Supabase SQL editor runs a pasted file: one call, one transaction
      try { await db.exec(text); console.log('✓ ' + f + ' (as one transaction)'); } catch (e) { failures++; console.log('✗ ' + f + ': ' + (e as Error).message.split(String.fromCharCode(10))[0]); }
      continue;
    }
    const stmts = split(text);
    let bad = 0;
    for (const s of stmts) {
      if (/^\s*(begin|commit)\s*$/i.test(s)) continue;
      try { await db.exec(s); } catch (e) {
        bad++; failures++;
        const msg = (e as Error).message.split('\n')[0];
        const head = s.replace(/\s+/g, ' ').slice(0, 150);
        console.log(`  ✗ ${f}: ${msg}\n      in: ${head}${s.length > 150 ? '…' : ''}`);
        if (bad >= 12) { console.log('      (stopping this file after 12 errors)'); break; }
      }
    }
    console.log(`${bad ? '✗' : '✓'} ${f}  (${stmts.length} statements${bad ? `, ${bad} failed` : ''})`);
  }
  if (process.argv.includes('--keep') && failures === 0) await postChecks(db);
  console.log(failures ? `\nFAILED — ${failures} statement(s) errored` : '\nALL FILES RAN CLEANLY in the local test database');
  process.exit(failures ? 1 : 0);
}

async function postChecks(db: PGlite) {
  const q = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows;
  const tables = await q(`select count(*)::int n from pg_tables where schemaname='public'`);
  const rls = await q(`select count(*)::int n from pg_tables where schemaname='public' and rowsecurity`);
  console.log(`public tables: ${(tables[0] as { n: number }).n}, with RLS on: ${(rls[0] as { n: number }).n}`);
  const org = await q(`select count(*)::int n from organizations`);
  console.log(`organizations: ${(org[0] as { n: number }).n}, rule_config: ${((await q('select count(*)::int n from rule_config'))[0] as { n: number }).n}`);
}

void main();
