import express, { Router } from 'express';
import { AppError } from '../http/errors';
import { wrap } from '../http/handler';
import { MemoryStorage, verifyFileToken } from '../providers/storage';
import type { AppDeps } from '../deps';

export const isPublicRouter = true;

/**
 * Demo-mode file server for signed URLs produced by MemoryStorage (`GET|PUT /files/:token`).
 * With Supabase Storage, signed URLs point at Supabase directly and this router is inert.
 * The token carries bucket, path, method and expiry and is HMAC-signed — no session is needed.
 */
export function createFilesRouter(deps: AppDeps): Router {
  const r = Router();
  const storage = deps.providers.storage;
  r.get('/files/:token', wrap(async (req, res) => {
    const p = verifyFileToken(String(req.params['token']));
    if (!p || p.m !== 'GET') throw new AppError(403, 'FORBIDDEN', 'This link has expired or is not valid');
    const buf = await storage.download({ bucket: p.b, path: p.p });
    if (!buf) throw new AppError(404, 'NOT_FOUND', 'File not found');
    res.setHeader('Content-Type', storage instanceof MemoryStorage ? storage.contentType(p.b, p.p) ?? 'application/octet-stream' : 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${p.p.split('/').pop()}"`);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(buf);
  }));
  r.put('/files/:token', express.raw({ type: '*/*', limit: '12mb' }), wrap(async (req, res) => {
    const p = verifyFileToken(String(req.params['token']));
    if (!p || p.m !== 'PUT') throw new AppError(403, 'FORBIDDEN', 'This link has expired or is not valid');
    await storage.upload({ bucket: p.b, path: p.p, content: req.body as Buffer, contentType: req.get('content-type') ?? 'application/octet-stream' });
    res.status(204).end();
  }));
  return r;
}
