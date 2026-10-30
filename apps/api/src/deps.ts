import type { Profile } from '@solar/shared';
import { randomUUID } from 'node:crypto';
import type { AppContext } from './auth/context';
import { SYSTEM_USER_ID } from './auth/context';
import type { Config } from './config';
import { scopeDb } from './db/scoped';
import type { Db } from './db/types';
import type { Logger } from './lib/logger';
import type { Providers } from './providers/types';
import { createServices, type ServiceOverrides } from './services';

/** Process-wide dependencies. Tests build these with MemoryDb + fake providers. */
export interface AppDeps {
  config: Config;
  /** UNSCOPED database handle. Request code must only use ctx.db (org-scoped). */
  db: Db;
  providers: Providers;
  log: Logger;
  now: () => Date;
  serviceOverrides?: ServiceOverrides;
}

export function systemUser(orgId: string): Profile {
  const iso = new Date(0).toISOString();
  return {
    id: SYSTEM_USER_ID, org_id: orgId, full_name: 'System', email: 'system@futuresolar.local', phone: null, role: 'admin', designation: 'Automation', distributor_id: null, dealer_id: null,
    territory_ids: [], reports_to: null, language: 'en', active: true, created_at: iso, updated_at: iso, created_by: null,
  };
}

export function buildContext(
  deps: AppDeps, orgId: string, user: Profile,
  extra: Partial<Pick<AppContext, 'requestId' | 'ip' | 'userAgent' | 'system' | 'now'>> = {},
): AppContext {
  const ctx = {
    org_id: orgId, user, db: scopeDb(deps.db, orgId), providers: deps.providers, config: deps.config, log: deps.log,
    requestId: extra.requestId ?? randomUUID(), ip: extra.ip ?? null, userAgent: extra.userAgent ?? null, now: extra.now ?? deps.now, system: extra.system ?? false,
  } as AppContext;
  ctx.svc = createServices(ctx, deps.serviceOverrides);
  return ctx;
}
