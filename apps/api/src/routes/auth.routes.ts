import { Router } from 'express';
import { z } from 'zod';
import { ROLE_LABEL, appRoleSchema, type Json } from '@solar/shared';
import { canSeeMobile } from '../auth/access';
import { demoToken } from '../auth/authenticate';
import type { AppDeps } from '../deps';
import { audit } from '../lib/audit';
import { AppError } from '../http/errors';
import { body, handle, wrap } from '../http/handler';

const profilePatch = z.object({
  full_name: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  language: z.enum(['en', 'hi', 'gu']).optional(),
});

/**
 * /auth — `demo-users` and `demo-login` are public and exist only in demo mode.
 * `me` and `profile` need a session (mounted a second time after authenticate()).
 */
export function createAuthRouter(deps: AppDeps, opts: { authenticated?: boolean } = {}): Router {
  const r = Router();

  if (!opts.authenticated) {
    r.get('/mode', (_req, res) => { res.json({ data: { demo: deps.config.demo, session_timeout_minutes: deps.config.SESSION_TIMEOUT_MINUTES } }); });

    r.get('/demo-users', wrap(async (_req, res) => {
      if (!deps.config.demo) throw new AppError(404, 'NOT_FOUND', 'That endpoint does not exist');
      const profiles = (await deps.db.table('profiles').all({ active: true }, { orderBy: { col: 'full_name' } }));
      const distributors = await deps.db.table('distributors').all();
      const dealers = await deps.db.table('dealers').all();
      res.json({
        data: profiles.map((p) => ({
          id: p.id, full_name: p.full_name, role: p.role, role_label: ROLE_LABEL[p.role], designation: p.designation,
          party: p.distributor_id ? distributors.find((d) => d.id === p.distributor_id)?.legal_name ?? null : p.dealer_id ? dealers.find((d) => d.id === p.dealer_id)?.legal_name ?? null : null,
        })),
      });
    }));

    r.post('/demo-login', wrap(async (req, res) => {
      if (!deps.config.demo) throw new AppError(404, 'NOT_FOUND', 'That endpoint does not exist');
      const { profile_id } = body(z.object({ profile_id: z.string().uuid() }), req);
      const p = await deps.db.table('profiles').get(profile_id);
      if (!p || !p.active) throw new AppError(404, 'NOT_FOUND', 'Profile not found');
      res.json({ data: { token: demoToken(p.id, deps.now().getTime()), profile: p } });
    }));
    return r;
  }

  r.get('/me', handle(async (ctx) => {
    const org = await ctx.db.table('organizations').get(ctx.org_id);
    return {
      profile: ctx.user, role_label: ROLE_LABEL[ctx.user.role], org: org ? { id: org.id, name: org.name } : null,
      permissions: { can_see_mobile: canSeeMobile(ctx.user.role) },
      session: { demo: ctx.config.demo, timeout_minutes: ctx.config.SESSION_TIMEOUT_MINUTES },
    };
  }));

  r.patch('/profile', handle(async (ctx, req) => {
    const patch = body(profilePatch, req);
    const before = ctx.user;
    const row = await ctx.db.table('profiles').update(ctx.user.id, patch);
    await audit(ctx, { action: 'profile.update', table: 'profiles', record_id: row.id, old: before as unknown as Json, new: row as unknown as Json });
    return row;
  }));

  r.get('/roles', handle(async () => appRoleSchema.options.map((r) => ({ role: r, label: ROLE_LABEL[r] }))));
  return r;
}
