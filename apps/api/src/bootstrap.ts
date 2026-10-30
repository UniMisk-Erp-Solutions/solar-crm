import { buildSeed } from '@solar/shared/seed';
import { loadConfig, type Config } from './config';
import { MemoryDb } from './db/memory';
import { SupabaseDb } from './db/supabase';
import type { Db } from './db/types';
import type { AppDeps } from './deps';
import { createLogger } from './lib/logger';
import { buildProviders } from './providers';

/** Assemble real dependencies from the environment: Supabase when configured, otherwise the in-memory demo store. */
export function createDeps(config: Config = loadConfig()): AppDeps {
  const log = createLogger(config.LOG_LEVEL, config.NODE_ENV === 'development');
  let db: Db;
  if (config.dataMode === 'supabase') {
    db = new SupabaseDb(config.SUPABASE_URL!, config.SUPABASE_SERVICE_ROLE_KEY!);
    log.info('Data store: Supabase');
  } else {
    db = new MemoryDb(buildSeed(new Date()));
    log.warn('Data store: IN-MEMORY DEMO (nothing is saved when the server stops). Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to go live.');
  }
  const providers = buildProviders(config, db, log);
  return { config, db, providers, log, now: () => new Date() };
}
