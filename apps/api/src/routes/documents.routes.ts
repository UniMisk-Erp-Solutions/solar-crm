/**
 * /documents — upload bound to an entity, list, short-lived signed download URL, direct-upload URL and delete.
 * Visibility is the parent entity's: whoever may read the lead / quote / order may list and open its documents.
 */
import { Router, type RequestHandler } from 'express';
import { platformDocumentListQuerySchema, platformDocumentUploadFieldsSchema, platformDocumentUploadUrlSchema } from '@solar/shared';
import { allow, ALL_ROLES } from '../auth/authorize';
import { body, handle, param, query, respondPage, wrap } from '../http/handler';
import { uploader } from '../http/upload';
import { createUploadUrl, deleteDocument, listDocuments, signedDownload, uploadDocument } from '../services/documentService';

const router = Router();
/** Every signed-in role except the read-only viewer may add documents (the parent-entity check still applies). */
const WRITERS = allow(...ALL_ROLES.filter((r) => r !== 'viewer'));
const READERS = allow(...ALL_ROLES);

/** multer sized from the request's own configuration (MAX_UPLOAD_MB), memory storage, images and PDF only. */
const receiveFile: RequestHandler = (req, res, next) => {
  const cfg = req.ctx!.config;
  uploader(cfg).single('file')(req, res, next);
};

router.post('/documents/upload-url', WRITERS, handle(async (ctx, req, res) => {
  res.status(201).json({ data: await createUploadUrl(ctx, body(platformDocumentUploadUrlSchema, req)) });
}));

router.post('/documents', WRITERS, receiveFile, handle(async (ctx, req, res) => {
  const fields = body(platformDocumentUploadFieldsSchema, req);
  res.status(201).json({ data: await uploadDocument(ctx, { file: (req as typeof req & { file?: Express.Multer.File }).file, ...fields }) });
}));

router.get('/documents', READERS, wrap(async (req, res) => {
  const q = query(platformDocumentListQuerySchema, req);
  const { rows, total } = await listDocuments(req.ctx!, q);
  respondPage(res, rows, total, q.limit, q.offset);
}));

router.get('/documents/:id/url', READERS, handle(async (ctx, req) => signedDownload(ctx, param(req, 'id'))));
router.delete('/documents/:id', WRITERS, handle(async (ctx, req) => deleteDocument(ctx, param(req, 'id'))));

export default router;
