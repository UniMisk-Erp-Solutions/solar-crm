/**
 * Generates the seed SQL files and the two seed-derived docs. NEVER executes SQL — the owner runs the files by hand.
 *
 *   npm run seed:sql                       # anchor = today (12:00 IST)
 *   SEED_ANCHOR=2026-10-26T06:30:00Z npm run seed:sql
 *
 * Writes: supabase/sql/12_seed_reference.sql,
 *         docs/VERIFY_BEFORE_RELYING.md, docs/DEMO_SCENARIOS.md
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { istDateString } from '../packages/shared/src/format';
import { renderScenariosDoc, renderVerifyDoc } from '../packages/shared/src/seed/docs';
import { renderSeedSql } from '../packages/shared/src/seed/sql';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function anchor(): Date {
  const fromEnv = process.env['SEED_ANCHOR'];
  if (fromEnv) {
    const d = new Date(fromEnv);
    if (Number.isNaN(d.getTime())) throw new Error(`SEED_ANCHOR is not a valid date: ${fromEnv}`);
    return d;
  }
  return new Date(`${istDateString(new Date())}T06:30:00Z`); // 12:00 IST today
}

function write(rel: string, text: string): void {
  const file = resolve(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
  console.log(`wrote ${rel} (${text.length.toLocaleString('en-IN')} characters)`);
}

const now = anchor();
const label = now.toISOString();
write('supabase/sql/12_seed_reference.sql', renderSeedSql(now, label));
write('docs/VERIFY_BEFORE_RELYING.md', renderVerifyDoc());
write('docs/DEMO_SCENARIOS.md', renderScenariosDoc());
