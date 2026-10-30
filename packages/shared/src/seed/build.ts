import { TABLE_NAMES, type TableName } from '../enums';
import { buildDemoSeed } from './demo';
import { buildTerritories } from './demo.people';
import { buildReferenceSeed } from './reference';
import { makeEnv } from './util';
import type { SeedData } from './types';

export { buildDemoSeed, buildReferenceSeed };
export { buildRuleConfigRows } from './rules.build';

/** Merges seed fragments table by table (later fragments append after earlier ones). */
export function mergeSeeds(...parts: SeedData[]): SeedData {
  const out: Record<string, unknown[]> = {};
  for (const part of parts) {
    for (const t of TABLE_NAMES) {
      const rows = part[t as TableName] as { id?: string }[] | undefined;
      if (!rows || !rows.length) continue;
      const dst = (out[t] ??= []) as { id?: string }[];
      // a later fragment replaces an earlier row with the same id (demo territories gain their DSM)
      for (const r of rows) { const i = r.id ? dst.findIndex((x) => x.id === r.id) : -1; if (i >= 0) dst[i] = r; else dst.push(r); }
    }
  }
  return out as SeedData;
}

/** Reference data plus the demo dataset, all relative to `now` (default: the current time). Deterministic for a given `now`. */
export function buildSeed(now: Date = new Date()): SeedData {
  const merged = mergeSeeds(buildReferenceSeed(now, false), buildDemoSeed(now));
  // the real territories carry no DSM; in the in-memory demo the fictional DSMs are attached to them
  const dsm = new Map(buildTerritories(makeEnv(now), true).map((t) => [t.id, t.dsm_id]));
  merged.territories = (merged.territories ?? []).map((t) => ({ ...t, dsm_id: dsm.get(t.id) ?? t.dsm_id }));
  return merged;
}
