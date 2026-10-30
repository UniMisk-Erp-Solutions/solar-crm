/**
 * Geo-tagged site-survey photos (bucket `site-photos`). Geo comes from the JPEG EXIF when present, otherwise from the
 * lat/lng fields the browser sends with the upload (the phone's location at capture time).
 */
import type { Request } from 'express';
import { detectAadhaar, isoDateTimeSchema, type Json, type SurveyPhoto } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { audit } from '../lib/audit';
import { AppError, invalidState, notFound } from '../http/errors';
import { assertFilenameAllowed } from '../http/guards';
import { filesOf, storeDocument } from '../http/upload';
import { invalidField, logLeadEvent } from './siteAccess';
import { loadSurvey } from './surveyService';

const PHOTO_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const FALLBACK_MAX_PHOTOS = 10;

export interface UploadedPhoto extends SurveyPhoto { index: number; document_id: string; file_name: string; geo_source: 'exif' | 'client' | 'none' }

/** Multipart text field value for file `i`: a repeated field gives one value per file, a single value applies to all files. */
function fieldFor(body: unknown, name: string, i: number): string | undefined {
  const raw = (body as Record<string, unknown> | undefined)?.[name];
  const v = Array.isArray(raw) ? raw[i] : raw;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function coord(v: string | undefined, min: number, max: number, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw invalidField(name, `${name} must be a number between ${min} and ${max}`);
  return n;
}

export async function maxPhotos(ctx: AppContext): Promise<number> {
  const v = await ctx.svc.rules.value<number>('survey.max_photos', undefined, FALLBACK_MAX_PHOTOS);
  return typeof v === 'number' && v > 0 ? Math.floor(v) : FALLBACK_MAX_PHOTOS;
}

export async function uploadSurveyPhotos(ctx: AppContext, surveyId: string, req: Request): Promise<{ uploaded: UploadedPhoto[]; photo_count: number; max_photos: number }> {
  const { survey, lead } = await loadSurvey(ctx, surveyId);
  if (lead.anonymised_at) throw invalidState('This lead has been anonymised');
  if (survey.status === 'cancelled') throw invalidState('This site visit was cancelled — photos cannot be added');
  const files = filesOf(req);
  if (!files.length) throw new AppError(400, 'BAD_REQUEST', 'Attach at least one photo in the "photos" field');
  const max = await maxPhotos(ctx);
  if (survey.photos.length + files.length > max) {
    throw new AppError(422, 'VALIDATION_ERROR', `A survey can hold ${max} photos — it has ${survey.photos.length}, so you can add ${Math.max(0, max - survey.photos.length)} more`, [{ path: 'photos', message: `Maximum ${max} photos per survey` }]);
  }

  // validate EVERYTHING before storing anything, so a bad file never leaves a half-finished upload behind
  const plan = files.map((f, i) => {
    if (!PHOTO_MIME.includes(f.mimetype)) throw new AppError(415, 'BAD_REQUEST', `"${f.originalname}" is not a JPG, PNG or WebP photo`);
    assertFilenameAllowed(f.originalname);
    const caption = fieldFor(req.body, 'caption', i);
    if (caption && detectAadhaar(caption).length) throw new AppError(422, 'AADHAAR_BLOCKED', 'An Aadhaar number was detected in the caption. We do not store Aadhaar numbers.');
    if (caption && caption.length > 200) throw invalidField('caption', 'Captions can be up to 200 characters');
    const lat = coord(fieldFor(req.body, 'lat', i), -90, 90, 'lat');
    const lng = coord(fieldFor(req.body, 'lng', i), -180, 180, 'lng');
    if ((lat === undefined) !== (lng === undefined)) throw invalidField(lat === undefined ? 'lat' : 'lng', 'Send lat and lng together');
    const takenRaw = fieldFor(req.body, 'taken_at', i);
    if (takenRaw && !isoDateTimeSchema.safeParse(takenRaw).success) throw invalidField('taken_at', 'taken_at must be an ISO date-time such as 2026-10-26T10:30:00+05:30');
    return { file: f, caption: caption ?? null, lat: lat ?? null, lng: lng ?? null, taken_at: takenRaw ? new Date(takenRaw).toISOString() : null };
  });

  const uploaded: UploadedPhoto[] = [];
  for (const item of plan) {
    const { document, exif } = await storeDocument(ctx, { file: item.file, bucket: 'site-photos', entity_type: 'survey', entity_id: survey.id, doc_type: 'site_photo' });
    const fromExif = exif.lat !== null && exif.lng !== null;
    const photo: SurveyPhoto = {
      path: document.path,
      lat: fromExif ? exif.lat : item.lat, lng: fromExif ? exif.lng : item.lng,
      taken_at: exif.taken_at ?? item.taken_at, caption: item.caption,
    };
    // re-read so two uploads racing on the same survey do not drop each other's photos
    const fresh = await ctx.db.table('site_surveys').getOrThrow(survey.id);
    const updated = await ctx.db.table('site_surveys').update(survey.id, { photos: [...fresh.photos, photo] });
    uploaded.push({ ...photo, index: updated.photos.length - 1, document_id: document.id, file_name: document.file_name, geo_source: fromExif ? 'exif' : photo.lat !== null ? 'client' : 'none' });
  }
  await logLeadEvent(ctx, lead.id, 'survey_photos_added', `${uploaded.length} site photo${uploaded.length === 1 ? '' : 's'} added`, { survey_id: survey.id, with_geo: uploaded.filter((u) => u.lat !== null).length });
  await audit(ctx, { action: 'survey.photo_upload', table: 'site_surveys', record_id: survey.id, detail: { count: uploaded.length, document_ids: uploaded.map((u) => u.document_id) } as Json });
  return { uploaded, photo_count: survey.photos.length + uploaded.length, max_photos: max };
}

export async function surveyPhotoUrl(ctx: AppContext, surveyId: string, index: number): Promise<{ url: string; expires_at: string; photo: SurveyPhoto; index: number }> {
  const { survey } = await loadSurvey(ctx, surveyId);
  const photo = survey.photos[index];
  if (!Number.isInteger(index) || index < 0 || !photo) throw notFound('Photo');
  // storage paths are always "<org_id>/…": never sign anything outside this organisation
  if (!photo.path.startsWith(`${ctx.org_id}/`)) throw notFound('Photo');
  const signed = await ctx.providers.storage.signedUrl({ bucket: 'site-photos', path: photo.path, method: 'GET', expiresInSec: 300 });
  return { url: signed.url, expires_at: signed.expires_at, photo, index };
}
