import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { AppError, zodDetails } from './errors';
import type { AppContext } from '../auth/context';

/** Wrap an async express handler so rejections reach the error middleware. */
export const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { fn(req, res, next).catch(next); };

/** Route handler that receives the per-request AppContext. */
export const handle = (fn: (ctx: AppContext, req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  wrap(async (req, res) => {
    const ctx = req.ctx;
    if (!ctx) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in to continue');
    const result = await fn(ctx, req, res);
    if (!res.headersSent && result !== undefined) res.json({ data: result });
  });

/** Parse and validate; throws a VALIDATION_ERROR with field paths. */
export function parse<S extends ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new AppError(422, 'VALIDATION_ERROR', 'Please check the highlighted fields', zodDetails(r.error));
  return r.data;
}

export const body = <S extends ZodTypeAny>(schema: S, req: Request): z.output<S> => parse(schema, req.body);
export const query = <S extends ZodTypeAny>(schema: S, req: Request): z.output<S> => parse(schema, req.query);
export const param = (req: Request, name: string): string => {
  const v = req.params[name];
  if (!v) throw new AppError(400, 'BAD_REQUEST', `Missing parameter ${name}`);
  return v;
};

export const respondPage = <T>(res: Response, rows: T[], total: number, limit: number, offset: number) => {
  res.json({ data: rows, total, limit, offset });
};
