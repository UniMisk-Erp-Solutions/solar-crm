import type { AppContext } from '../auth/context';
import type { AppDeps } from '../deps';

/**
 * Process-wide handle to the real dependencies, for the few platform features that need the UNSCOPED database
 * (demo reset). `startJobs(deps)` binds it automatically; tests and the integrator may call `bindPlatformDeps` directly.
 */
let bound: AppDeps | null = null;
export function bindPlatformDeps(deps: AppDeps): void { bound = deps; }
export function getPlatformDeps(): AppDeps | null { return bound; }

/**
 * Dependencies reconstructed from a request context. The database stays pinned to the caller's organisation,
 * which is exactly what an admin-triggered job run should see.
 */
export function depsFromContext(ctx: AppContext): AppDeps {
  return { config: ctx.config, db: ctx.db, providers: ctx.providers, log: ctx.log, now: ctx.now };
}
