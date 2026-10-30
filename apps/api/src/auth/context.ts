import type { Profile } from '@solar/shared';
import type { Config } from '../config';
import type { Db } from '../db/types';
import type { Logger } from '../lib/logger';
import type { Providers } from '../providers/types';
import type { Services } from '../services/contracts';

/** Per-request context handed to every service. `db` is already pinned to the user's organisation. */
export interface AppContext {
  org_id: string;
  user: Profile;
  db: Db;
  svc: Services;
  providers: Providers;
  config: Config;
  log: Logger;
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  now(): Date;
  /** true for cron/system-initiated work (no human actor) */
  system: boolean;
}

export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx?: AppContext;
      requestId?: string;
    }
  }
}
