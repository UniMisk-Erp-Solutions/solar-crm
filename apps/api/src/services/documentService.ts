/**
 * Documents: upload bound to an entity, listing, short-lived signed URLs, direct-to-storage upload URLs and deletion.
 * Access is always decided by the PARENT entity's visibility (assertCanRead on the owning row), and every storage path
 * must sit under `<org_id>/`.
 */
import { randomUUID } from 'node:crypto';
import { LEADERSHIP_ROLES, type DocumentBucket, type DocumentRow, type Json, type TableName } from '@solar/shared';
import type { z } from 'zod';
import type { platformDocumentUploadUrlSchema } from '@solar/shared';
import { assertCanRead, isInternal } from '../auth/access';
import type { AppContext } from '../auth/context';
import { AppError, badRequest, forbidden, notFound } from '../http/errors';
import { assertFilenameAllowed } from '../http/guards';
import { storeDocument, type StoredDocument } from '../http/upload';
import { audit } from '../lib/audit';

/** entity_type (as stored on documents.entity_type) → the table that owns the row. Unlisted types are internal-users-only. */
export const ENTITY_TABLE: Record<string, TableName> = {
  lead: 'leads', customer: 'customers', site: 'sites', survey: 'site_surveys', site_survey: 'site_surveys', opportunity: 'opportunities',
  quotation: 'quotations', quote: 'quotations', proforma_invoice: 'proforma_invoices', pi: 'proforma_invoices', sales_order: 'sales_orders', dispatch: 'dispatches',
  installation: 'installations', loan: 'loans', discom_application: 'discom_applications', subsidy_claim: 'subsidy_claims', warranty_ticket: 'warranty_tickets',
  dealer: 'dealers', distributor: 'distributors', vendor_registration: 'vendor_registrations', sku: 'skus', sop_case: 'sop_cases', breach_incident: 'breach_incidents',
};

/** Bucket by entity and document type (private buckets from supabase/sql/11_storage_buckets.sql). */
export function defaultBucket(entityType: string, docType: string): DocumentBucket {
  if (['survey', 'site_survey', 'installation'].includes(entityType) || /photo|geo_tag|image/.test(docType)) return 'site-photos';
  if (['quotation', 'quote'].includes(entityType)) return 'quote-pdfs';
  if (['proforma_invoice', 'pi', 'sales_order', 'dispatch'].includes(entityType)) return 'invoices';
  if (['sku', 'dealer', 'distributor', 'vendor_registration', 'discom_application', 'subsidy_claim', 'sop_case', 'breach_incident'].includes(entityType)) return 'compliance-docs';
  return 'lead-docs';
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(n)));
const safeName = (n: string): string => n.replace(/[^\w.-]+/g, '_').slice(-80);

/** Refuses any path that is not strictly inside the caller's organisation folder. */
export function assertOrgPath(ctx: AppContext, path: string): void {
  if (!path.startsWith(`${ctx.org_id}/`) || path.split('/').some((seg) => seg === '..' || seg === '')) throw forbidden('This file is outside your organisation');
}

/** Throws unless the caller may see (and, for writes, change) documents attached to this entity. */
export async function assertEntityAccess(ctx: AppContext, entityType: string, entityId: string, mode: 'read' | 'write'): Promise<void> {
  if (mode === 'write' && ctx.user.role === 'viewer') throw forbidden('Your role is read-only');
  const table = ENTITY_TABLE[entityType];
  if (!table) {
    if (!isInternal(ctx.user.role)) throw forbidden();
    return;
  }
  const row = await ctx.db.table(table).get(entityId);
  if (!row) throw notFound(entityType.replace(/_/g, ' '));
  await assertCanRead(ctx, table, row);
}

export type DocumentView = Omit<DocumentRow, 'path'> & { uploaded_by_name: string | null };

async function toViews(ctx: AppContext, docs: DocumentRow[]): Promise<DocumentView[]> {
  const ids = [...new Set(docs.map((d) => d.uploaded_by).filter((x): x is string => !!x))];
  const people = ids.length ? await ctx.db.table('profiles').all({ id: ids }) : [];
  return docs.map(({ path: _p, ...d }) => ({ ...d, uploaded_by_name: people.find((p) => p.id === d.uploaded_by)?.full_name ?? null }));
}

export async function uploadDocument(
  ctx: AppContext, input: { file: Express.Multer.File | undefined; entity_type: string; entity_id: string; doc_type: string; bucket?: DocumentBucket },
): Promise<DocumentView & { exif: StoredDocument['exif'] }> {
  if (!input.file) throw badRequest('Attach a file in the "file" field');
  await assertEntityAccess(ctx, input.entity_type, input.entity_id, 'write');
  const stored = await storeDocument(ctx, { file: input.file, bucket: input.bucket ?? defaultBucket(input.entity_type, input.doc_type), entity_type: input.entity_type, entity_id: input.entity_id, doc_type: input.doc_type });
  const [view] = await toViews(ctx, [stored.document]);
  return { ...view!, exif: stored.exif };
}

export async function listDocuments(ctx: AppContext, q: { entity_type: string; entity_id: string; doc_type?: string; limit: number; offset: number }): Promise<{ rows: DocumentView[]; total: number }> {
  await assertEntityAccess(ctx, q.entity_type, q.entity_id, 'read');
  const { rows, total } = await ctx.db.table('documents').list({
    where: { entity_type: q.entity_type, entity_id: q.entity_id, ...(q.doc_type ? { doc_type: q.doc_type } : {}) }, orderBy: { col: 'created_at', dir: 'desc' }, limit: q.limit, offset: q.offset,
  });
  return { rows: await toViews(ctx, rows), total };
}

async function loadDocument(ctx: AppContext, id: string): Promise<DocumentRow> {
  const doc = await ctx.db.table('documents').get(id);
  if (!doc) throw notFound('Document');
  assertOrgPath(ctx, doc.path);
  return doc;
}

export interface SignedDownload { url: string; expires_at: string; expires_in_seconds: number; file_name: string; mime: string | null; size_bytes: number | null }

/** 5-minute (rule documents.signed_url_seconds) signed download URL for a document the caller may see. */
export async function signedDownload(ctx: AppContext, id: string): Promise<SignedDownload> {
  const doc = await loadDocument(ctx, id);
  await assertEntityAccess(ctx, doc.entity_type, doc.entity_id, 'read');
  const ttl = clamp((await ctx.svc.rules.value<number>('documents.signed_url_seconds', undefined, 300)) ?? 300, 30, 900);
  const signed = await ctx.providers.storage.signedUrl({ bucket: doc.bucket, path: doc.path, method: 'GET', expiresInSec: ttl });
  await audit(ctx, { action: 'document.access', table: 'documents', record_id: id, detail: { entity_type: doc.entity_type, entity_id: doc.entity_id, doc_type: doc.doc_type, ttl_seconds: ttl } });
  return { url: signed.url, expires_at: signed.expires_at, expires_in_seconds: ttl, file_name: doc.file_name, mime: doc.mime, size_bytes: doc.size_bytes };
}

export interface UploadTicket { document: DocumentView; upload: { url: string; method: 'PUT'; expires_at: string; headers: Record<string, string> }; max_bytes: number }

/** Pre-creates the documents row and returns a signed PUT URL so the browser can upload straight to storage. */
export async function createUploadUrl(ctx: AppContext, input: z.output<typeof platformDocumentUploadUrlSchema>): Promise<UploadTicket> {
  await assertEntityAccess(ctx, input.entity_type, input.entity_id, 'write');
  assertFilenameAllowed(input.file_name);
  const maxBytes = ctx.config.MAX_UPLOAD_MB * 1024 * 1024;
  if (input.size_bytes && input.size_bytes > maxBytes) throw new AppError(413, 'BAD_REQUEST', `Files must be ${ctx.config.MAX_UPLOAD_MB} MB or smaller`);
  const bucket = input.bucket ?? defaultBucket(input.entity_type, input.doc_type);
  const path = `${ctx.org_id}/${input.entity_type}/${input.entity_id}/${randomUUID()}-${safeName(input.file_name)}`;
  assertOrgPath(ctx, path);
  const ttl = clamp((await ctx.svc.rules.value<number>('documents.upload_url_seconds', undefined, 600)) ?? 600, 60, 1800);
  const signed = await ctx.providers.storage.signedUrl({ bucket, path, method: 'PUT', expiresInSec: ttl });
  const doc = await ctx.db.table('documents').insert({
    entity_type: input.entity_type, entity_id: input.entity_id, bucket, path, doc_type: input.doc_type, file_name: input.file_name, mime: input.content_type, size_bytes: input.size_bytes ?? null,
    uploaded_by: ctx.user.id, created_by: ctx.user.id,
  });
  await audit(ctx, { action: 'document.upload_url', table: 'documents', record_id: doc.id, detail: { entity_type: input.entity_type, entity_id: input.entity_id, doc_type: input.doc_type, bucket } as Json });
  const [view] = await toViews(ctx, [doc]);
  return { document: view!, upload: { url: signed.url, method: 'PUT', expires_at: signed.expires_at, headers: { 'content-type': input.content_type } }, max_bytes: maxBytes };
}

/** The uploader, leadership, and compliance may delete; the file is removed from storage first so a failure leaves the row to retry. */
export async function deleteDocument(ctx: AppContext, id: string): Promise<{ id: string }> {
  const doc = await loadDocument(ctx, id);
  await assertEntityAccess(ctx, doc.entity_type, doc.entity_id, 'write');
  const mayDelete = doc.uploaded_by === ctx.user.id || LEADERSHIP_ROLES.includes(ctx.user.role) || ctx.user.role === 'compliance_officer';
  if (!mayDelete) throw forbidden('Only the uploader, a manager or the compliance officer can delete this document');
  await ctx.providers.storage.remove({ bucket: doc.bucket, path: doc.path });
  await ctx.db.table('documents').delete(id);
  await audit(ctx, { action: 'document.delete', table: 'documents', record_id: id, detail: { entity_type: doc.entity_type, entity_id: doc.entity_id, doc_type: doc.doc_type, file_name: doc.file_name } });
  return { id };
}
