import { ZodError } from 'zod';

export type ErrorCode =
  | 'VALIDATION_ERROR' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'RATE_LIMITED' | 'BAD_REQUEST'
  | 'AADHAAR_BLOCKED' | 'GUARD_BLOCKED' | 'COMPLIANCE_BLOCKED' | 'CONSENT_BLOCKED' | 'INVALID_STATE' | 'INTERNAL';

export class AppError extends Error {
  constructor(public status: number, public code: ErrorCode | string, message: string, public details?: unknown) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details);
export const unauthenticated = (message = 'Please sign in to continue') => new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have access to this') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Record') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'CONFLICT', message, details);
/** Business rule refused the action (e.g. DB-guard equivalents: opportunity guard, credit limit). */
export const guardBlocked = (message: string, details?: unknown) => new AppError(422, 'GUARD_BLOCKED', message, details);
export const invalidState = (message: string, details?: unknown) => new AppError(409, 'INVALID_STATE', message, details);
export const complianceBlocked = (message: string, details?: unknown) => new AppError(422, 'COMPLIANCE_BLOCKED', message, details);

export function zodDetails(err: ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}
