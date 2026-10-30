import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { LEADERSHIP_ROLES, type AppRole } from '@solar/shared';
import { forbidden, unauthenticated } from '../http/errors';

/** Route guard: only these roles may call the endpoint. `admin` is always allowed. */
export function allow(...roles: AppRole[]): RequestHandler {
  const set = new Set<AppRole>([...roles, 'admin']);
  return (req: Request, _res: Response, next: NextFunction) => {
    const u = req.ctx?.user;
    if (!u) return next(unauthenticated());
    if (!set.has(u.role)) return next(forbidden(`Your role (${u.role.replace('_', ' ')}) cannot do this`));
    next();
  };
}

/** Same check, usable inside a handler. */
export function assertRole(role: AppRole, ...allowed: AppRole[]): void {
  if (role !== 'admin' && !allowed.includes(role)) throw forbidden(`Your role (${role.replace('_', ' ')}) cannot do this`);
}

export const hasRole = (role: AppRole, ...allowed: AppRole[]): boolean => role === 'admin' || allowed.includes(role);
export const isLeadership = (role: AppRole): boolean => LEADERSHIP_ROLES.includes(role);

export const INTERNAL_ONLY: AppRole[] = ['management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts', 'compliance_officer', 'dispatch', 'viewer'];
export const ALL_ROLES: AppRole[] = [...INTERNAL_ONLY, 'distributor_user', 'dealer_user'];
export const SALES_ROLES: AppRole[] = ['management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'distributor_user', 'dealer_user'];
