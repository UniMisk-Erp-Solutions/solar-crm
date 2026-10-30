import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { Profile } from '@solar/shared';
import { SupabaseDb } from '../db/supabase';
import type { AppDeps } from '../deps';
import { buildContext } from '../deps';
import { AppError, forbidden, unauthenticated } from '../http/errors';

const verifyCache = new Map<string, { userId: string; iat: number; until: number }>();

function bearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  return null;
}

/** Demo-mode token: `demo.<profileId>.<issuedAtMs>` — only accepted when config.demo is true. */
export const demoToken = (profileId: string, now = Date.now()): string => `demo.${profileId}.${now}`;

function decodeJwtIat(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { iat?: number };
    return payload.iat ? payload.iat * 1000 : null;
  } catch { return null; }
}

async function resolveUserId(deps: AppDeps, token: string): Promise<{ userId: string; iat: number }> {
  if (deps.config.demo) {
    const m = /^demo\.([0-9a-f-]{36})\.(\d+)$/.exec(token);
    if (!m) throw unauthenticated('Invalid demo session — please sign in again');
    return { userId: m[1]!, iat: Number(m[2]) };
  }
  const hit = verifyCache.get(token);
  if (hit && hit.until > Date.now()) return { userId: hit.userId, iat: hit.iat };
  if (!(deps.db instanceof SupabaseDb)) throw new AppError(500, 'INTERNAL', 'Authentication is not configured');
  const { data, error } = await deps.db.client.auth.getUser(token);
  if (error || !data.user) throw unauthenticated('Your session has expired — please sign in again');
  const iat = decodeJwtIat(token) ?? Date.now();
  verifyCache.set(token, { userId: data.user.id, iat, until: Date.now() + 30_000 });
  if (verifyCache.size > 500) verifyCache.clear();
  return { userId: data.user.id, iat };
}

/** authenticate JWT → load profile → build the org-scoped AppContext. */
export function authenticate(deps: AppDeps) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = bearer(req);
      if (!token) throw unauthenticated();
      const { userId, iat } = await resolveUserId(deps, token);
      const timeoutMs = deps.config.SESSION_TIMEOUT_MINUTES * 60_000;
      if (deps.config.demo ? false : Date.now() - iat > timeoutMs) throw unauthenticated('Your session timed out — please sign in again');
      const profile: Profile | null = await deps.db.table('profiles').get(userId);
      if (!profile) throw forbidden('No CRM profile is linked to this account — ask an administrator to add you');
      if (!profile.active) throw forbidden('This account has been deactivated');
      req.requestId = req.requestId ?? randomUUID();
      req.ctx = buildContext(deps, profile.org_id, profile, {
        requestId: req.requestId, ip: (req.ip ?? null), userAgent: req.get('user-agent') ?? null,
      });
      res.setHeader('x-request-id', req.requestId);
      next();
    } catch (e) { next(e); }
  };
}
