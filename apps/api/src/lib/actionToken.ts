import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Signed, expiring token for the link in a distributor's e-mail. It names one request (assignment) in one organisation and nothing else, so the
 * link can show that request and record its answer without a login. Set FILE_TOKEN_SECRET (shared by every function instance) in production.
 */
export interface RequestToken { o: string; a: string; e: number }

const fallbackSecret = randomBytes(32).toString('hex');
const secret = (): string => process.env['REQUEST_TOKEN_SECRET'] || process.env['FILE_TOKEN_SECRET'] || process.env['UNSUBSCRIBE_TOKEN_SECRET'] || fallbackSecret;
const sign = (body: string): string => createHmac('sha256', secret()).update(`lead-request:${body}`).digest('base64url');

export function signRequestToken(orgId: string, assignmentId: string, expiresAt: Date): string {
  const body = Buffer.from(JSON.stringify({ o: orgId, a: assignmentId, e: Math.floor(expiresAt.getTime() / 1000) })).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** The token's content when the signature is right and it has not expired, otherwise null. */
export function verifyRequestToken(token: string, now: Date = new Date()): RequestToken | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const good = sign(body);
  if (good.length !== sig.length || !timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<RequestToken>;
    if (typeof p.o !== 'string' || typeof p.a !== 'string' || typeof p.e !== 'number') return null;
    return p.e * 1000 >= now.getTime() ? { o: p.o, a: p.a, e: p.e } : null;
  } catch { return null; }
}
