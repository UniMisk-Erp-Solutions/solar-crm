import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DocumentBucket } from '@solar/shared';
import type { FileStorage, SignedUrl } from './types';

const secret = process.env['FILE_TOKEN_SECRET'] || randomBytes(32).toString('hex');

interface TokenPayload { b: DocumentBucket; p: string; m: 'GET' | 'PUT'; e: number }
export function signFileToken(p: TokenPayload): string {
  const body = Buffer.from(JSON.stringify(p)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
export function verifyFileToken(token: string): TokenPayload | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const good = createHmac('sha256', secret).update(body).digest('base64url');
  if (good.length !== sig.length || !timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
  return p.e > Date.now() ? p : null;
}

/** Demo-mode storage: bytes live in process memory; signed URLs point at GET/PUT /files/:token (routes/files.routes.ts). */
export class MemoryStorage implements FileStorage {
  readonly name = 'memory-storage';
  readonly files = new Map<string, { content: Buffer; contentType: string }>();
  constructor(private publicApiUrl: string) {}
  async upload(i: { bucket: DocumentBucket; path: string; content: Buffer; contentType: string }) { this.files.set(`${i.bucket}/${i.path}`, { content: i.content, contentType: i.contentType }); }
  async signedUrl(i: { bucket: DocumentBucket; path: string; method: 'GET' | 'PUT'; expiresInSec: number }): Promise<SignedUrl> {
    const e = Date.now() + i.expiresInSec * 1000;
    return { url: `${this.publicApiUrl}/api/v1/files/${signFileToken({ b: i.bucket, p: i.path, m: i.method, e })}`, expires_at: new Date(e).toISOString(), method: i.method };
  }
  async download(i: { bucket: DocumentBucket; path: string }) { return this.files.get(`${i.bucket}/${i.path}`)?.content ?? null; }
  contentType(bucket: DocumentBucket, path: string): string | null { return this.files.get(`${bucket}/${path}`)?.contentType ?? null; }
  async remove(i: { bucket: DocumentBucket; path: string }) { this.files.delete(`${i.bucket}/${i.path}`); }
}

/** Live storage on private Supabase buckets (see supabase/sql/11_storage_buckets.sql). Server-side only. */
export class SupabaseStorage implements FileStorage {
  readonly name = 'supabase-storage';
  constructor(private client: SupabaseClient) {}
  async upload(i: { bucket: DocumentBucket; path: string; content: Buffer; contentType: string }) {
    const { error } = await this.client.storage.from(i.bucket).upload(i.path, i.content, { contentType: i.contentType, upsert: false });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
  }
  async signedUrl(i: { bucket: DocumentBucket; path: string; method: 'GET' | 'PUT'; expiresInSec: number }): Promise<SignedUrl> {
    const expires_at = new Date(Date.now() + i.expiresInSec * 1000).toISOString();
    if (i.method === 'GET') {
      const { data, error } = await this.client.storage.from(i.bucket).createSignedUrl(i.path, i.expiresInSec);
      if (error || !data) throw new Error(`Could not sign URL: ${error?.message}`);
      return { url: data.signedUrl, expires_at, method: 'GET' };
    }
    const { data, error } = await this.client.storage.from(i.bucket).createSignedUploadUrl(i.path);
    if (error || !data) throw new Error(`Could not sign upload URL: ${error?.message}`);
    return { url: data.signedUrl, expires_at, method: 'PUT' };
  }
  async download(i: { bucket: DocumentBucket; path: string }) {
    const { data, error } = await this.client.storage.from(i.bucket).download(i.path);
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  }
  async remove(i: { bucket: DocumentBucket; path: string }) { await this.client.storage.from(i.bucket).remove([i.path]); }
}
