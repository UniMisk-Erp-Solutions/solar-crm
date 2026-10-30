/** multer middleware wrappers for the site module: friendly 4xx errors instead of the default 500 for wrong field names / counts. */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError, badRequest } from '../http/errors';
import { uploader } from '../http/upload';

function translate(err: unknown, next: NextFunction, hint: string): void {
  const code = (err as { code?: string } | null)?.code;
  if (code === 'LIMIT_UNEXPECTED_FILE') return next(badRequest(hint));
  if (code === 'LIMIT_FILE_COUNT') return next(new AppError(422, 'VALIDATION_ERROR', 'Too many files in one upload (10 at most)'));
  next(err); // LIMIT_FILE_SIZE and AppError (wrong type) are rendered by the app error handler (413 / 415)
}

/** Up to 10 photos in the multipart field "photos". */
export const photosUpload: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  uploader(req.ctx!.config).array('photos', 10)(req, res, (err?: unknown) => (err ? translate(err, next, 'Attach the photos in the "photos" field (up to 10 per upload)') : next()));
};

/** One file in the multipart field "file" (the DISCOM bill). */
export const billUpload: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  uploader(req.ctx!.config).single('file')(req, res, (err?: unknown) => (err ? translate(err, next, 'Attach the bill in the "file" field') : next()));
};
