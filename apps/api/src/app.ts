import cors from 'cors';
import express, { type ErrorRequestHandler, type Express, type Router } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { authenticate } from './auth/authenticate';
import type { AppDeps } from './deps';
import { AppError, zodDetails } from './http/errors';
import { aadhaarGuard, authLimiter, generalLimiter } from './http/guards';
import { authedRouters, publicRouters } from './routes';
import { createAuthRouter } from './routes/auth.routes';
import { createFilesRouter } from './routes/files.routes';
import { createPublicRouter } from './routes/public.routes';

/** CORS allow-list: exact origins, or one wildcard label such as https://*.vercel.app (the * matches a single host label). */
export function originAllowed(list: string[], origin: string | undefined): boolean {
  if (!origin) return true; // same-origin or non-browser callers (cron, curl)
  return list.some((entry) => {
    if (!entry.includes('*')) return entry === origin;
    const re = new RegExp('^' + entry.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[a-z0-9-]+') + '$', 'i');
    return re.test(origin);
  });
}

export interface CreateAppOptions {
  /** Routers needing a signed-in user (mounted under /api/v1 after authentication). Defaults to routes/index. */
  authed?: Router[];
  /** Routers for unauthenticated traffic (public lead forms, webhooks). Defaults to routes/index. */
  public?: Router[];
}

export function createApp(deps: AppDeps, opts: CreateAppOptions = {}): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, _res, next) => { req.requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID(); next(); });
  app.use(helmet());
  app.use(cors({ origin: (origin, cb) => cb(null, originAllowed(deps.config.corsOrigins, origin)), credentials: true, allowedHeaders: ['authorization', 'content-type', 'x-api-key', 'x-request-id'] }));
  app.use(pinoHttp({ logger: deps.log, genReqId: (req) => (req as express.Request).requestId ?? randomUUID(), autoLogging: { ignore: (req) => req.url === '/health' } }));
  app.use(express.json({ limit: '2mb' }));
  app.use(generalLimiter(deps.config));

  app.get('/health', (_req, res) => { res.json({ ok: true, mode: deps.config.demo ? 'demo' : 'live', time: deps.now().toISOString() }); });

  const api = express.Router();
  // 1) unauthenticated: login helpers, public lead capture, webhooks
  api.use('/auth', authLimiter(deps.config), createAuthRouter(deps));
  api.use(createFilesRouter(deps));
  for (const r of opts.public ?? [createPublicRouter(deps), ...publicRouters]) api.use(r);
  // 2) everything else needs a user
  api.use(authenticate(deps));
  api.use(aadhaarGuard);
  api.use('/auth', createAuthRouter(deps, { authenticated: true }));
  for (const r of opts.authed ?? authedRouters) api.use(r);
  app.use('/api/v1', api);

  app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'That endpoint does not exist')));

  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details ?? null } });
      return;
    }
    if (err instanceof ZodError) {
      res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Please check the highlighted fields', details: zodDetails(err) } });
      return;
    }
    const e = err as { type?: string; code?: string; message?: string };
    if (e.type === 'entity.parse.failed') { res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'The request body is not valid JSON', details: null } }); return; }
    if (e.type === 'entity.too.large') { res.status(413).json({ error: { code: 'BAD_REQUEST', message: 'The request is too large', details: null } }); return; }
    if (e.code === 'LIMIT_FILE_SIZE') { res.status(413).json({ error: { code: 'BAD_REQUEST', message: `Files must be ${deps.config.MAX_UPLOAD_MB} MB or smaller`, details: null } }); return; }
    deps.log.error({ err, requestId: req.requestId }, 'unhandled error');
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.', details: { requestId: req.requestId } } });
  };
  app.use(onError);
  return app;
}
