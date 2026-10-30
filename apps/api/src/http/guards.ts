import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { looksLikeAadhaarFilename, scanForAadhaar } from '@solar/shared';
import type { Config } from '../config';
import { AppError } from './errors';
import { audit } from '../lib/audit';

/** Gate G14 at the edge: refuse any JSON body that contains a Verhoeff-valid Aadhaar number. */
export function aadhaarGuard(req: Request, _res: Response, next: NextFunction): void {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method) || !req.body || typeof req.body !== 'object') return next();
  const hits = scanForAadhaar(req.body);
  if (!hits.length) return next();
  const done = () => next(new AppError(422, 'AADHAAR_BLOCKED', 'An Aadhaar number was detected. We do not store Aadhaar numbers — please remove it (you may enter the last four digits only).', { fields: hits }));
  if (req.ctx) audit(req.ctx, { action: 'aadhaar.blocked', detail: { path: req.path, fields: hits } }).finally(done); else done();
}

/** Throws for file names such as "aadhaar_front.jpg". Image CONTENT cannot be inspected here — see the virus-scan/AV hook in documents. */
export function assertFilenameAllowed(name: string): void {
  if (looksLikeAadhaarFilename(name)) throw new AppError(422, 'AADHAAR_BLOCKED', 'This file looks like an Aadhaar document. We do not store Aadhaar numbers or images.', { file: name });
}

const limiterMessage = { error: { code: 'RATE_LIMITED', message: 'Too many requests — please wait a moment and try again.' } };

/** Strict limiter for unauthenticated endpoints (public lead forms, webhooks). */
export const publicLimiter = (config: Config) =>
  rateLimit({ windowMs: 60_000, limit: config.NODE_ENV === 'test' ? 10_000 : config.PUBLIC_RATE_LIMIT_PER_MIN, standardHeaders: true, legacyHeaders: false, message: limiterMessage });

export const authLimiter = (config: Config) =>
  rateLimit({ windowMs: 15 * 60_000, limit: config.NODE_ENV === 'test' ? 10_000 : config.AUTH_RATE_LIMIT_PER_15MIN, standardHeaders: true, legacyHeaders: false, message: limiterMessage,
    // the app asks who is signed in (/me) and which mode it runs in (/mode) on every page load; only credential-style calls are limited
    skip: (req) => req.method === 'GET' && (req.path === '/me' || req.path === '/mode') });

export const generalLimiter = (config: Config) =>
  rateLimit({ windowMs: 60_000, limit: config.NODE_ENV === 'test' ? 100_000 : 600, standardHeaders: true, legacyHeaders: false, message: limiterMessage });
