import { randomUUID } from 'node:crypto';
import multer from 'multer';
import type { Request, RequestHandler } from 'express';
import type { DocumentBucket, DocumentRow } from '@solar/shared';
import type { AppContext } from '../auth/context';
import type { Config } from '../config';
import { audit } from '../lib/audit';
import { readExif, type ExifInfo } from '../lib/exif';
import { AppError } from './errors';
import { assertFilenameAllowed } from './guards';

export const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

/** multer (memory storage) — images and PDF only, size limit from MAX_UPLOAD_MB. Use as route middleware: `upload.single('file')`. */
export function uploader(config: Config): { single(field: string): RequestHandler; array(field: string, max?: number): RequestHandler } {
  const m = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 10 },
    fileFilter: (_req, file, cb) => {
      if (!ALLOWED_MIME.includes(file.mimetype)) return cb(new AppError(415, 'BAD_REQUEST', 'Only JPG, PNG, WebP images and PDF files are accepted'));
      cb(null, true);
    },
  });
  return { single: (f) => m.single(f), array: (f, max = 10) => m.array(f, max) };
}

/**
 * Virus-scan extension point. Replace the body with a call to ClamAV / a cloud scanner and throw to reject.
 * Called for every uploaded file BEFORE it is stored. Documented in docs/RUNBOOK.md.
 */
export let scanFile: (file: { buffer: Buffer; originalname: string; mimetype: string }) => Promise<void> = async () => { /* no scanner configured */ };
export function setScanHook(fn: typeof scanFile): void { scanFile = fn; }

const safeName = (n: string): string => n.replace(/[^\w.-]+/g, '_').slice(-80);

export interface StoreDocumentInput {
  file: Express.Multer.File;
  bucket: DocumentBucket;
  entity_type: string;
  entity_id: string;
  doc_type: string;
}
export interface StoredDocument { document: DocumentRow; exif: ExifInfo }

/**
 * Validate (type, size, Aadhaar file-name guard G14, scan hook), upload to the private bucket under `<org_id>/…`,
 * record a `documents` row, audit, and return the row plus EXIF geo (JPEG only).
 */
export async function storeDocument(ctx: AppContext, input: StoreDocumentInput): Promise<StoredDocument> {
  const f = input.file;
  if (!f) throw new AppError(400, 'BAD_REQUEST', 'No file was uploaded');
  if (!ALLOWED_MIME.includes(f.mimetype)) throw new AppError(415, 'BAD_REQUEST', 'Only JPG, PNG, WebP images and PDF files are accepted');
  if (f.size > ctx.config.MAX_UPLOAD_MB * 1024 * 1024) throw new AppError(413, 'BAD_REQUEST', `Files must be ${ctx.config.MAX_UPLOAD_MB} MB or smaller`);
  assertFilenameAllowed(f.originalname);
  await scanFile(f);
  const path = `${ctx.org_id}/${input.entity_type}/${input.entity_id}/${randomUUID()}-${safeName(f.originalname)}`;
  await ctx.providers.storage.upload({ bucket: input.bucket, path, content: f.buffer, contentType: f.mimetype });
  const document = await ctx.db.table('documents').insert({
    entity_type: input.entity_type, entity_id: input.entity_id, bucket: input.bucket, path, doc_type: input.doc_type, file_name: f.originalname,
    mime: f.mimetype, size_bytes: f.size, uploaded_by: ctx.system ? null : ctx.user.id, created_by: ctx.system ? null : ctx.user.id,
  });
  await audit(ctx, { action: 'document.upload', table: 'documents', record_id: document.id, detail: { entity_type: input.entity_type, entity_id: input.entity_id, doc_type: input.doc_type, bucket: input.bucket } });
  return { document, exif: f.mimetype === 'image/jpeg' ? readExif(f.buffer) : { lat: null, lng: null, taken_at: null } };
}

/** Files from multer for the given request field (works with .single and .array). */
export function filesOf(req: Request): Express.Multer.File[] {
  const anyReq = req as Request & { file?: Express.Multer.File; files?: Express.Multer.File[] | Record<string, Express.Multer.File[]> };
  if (anyReq.files) return Array.isArray(anyReq.files) ? anyReq.files : Object.values(anyReq.files).flat();
  return anyReq.file ? [anyReq.file] : [];
}
