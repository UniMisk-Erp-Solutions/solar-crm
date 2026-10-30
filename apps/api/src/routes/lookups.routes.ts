import { Router } from 'express';
import { PINCODE_RE } from '@solar/shared';
import { AppError } from '../http/errors';
import { handle } from '../http/handler';
import { resolveGeo } from '../services/routing';

const router = Router();

/** Signed-in version of /public/pincode/:pin (that one needs a lead-source API key). Used by the internal lead form to auto-fill city, district and state. */
router.get('/lookups/pincode/:pin', handle(async (ctx, req) => {
  const pin = String(req.params['pin'] ?? '');
  if (!PINCODE_RE.test(pin)) throw new AppError(422, 'VALIDATION_ERROR', 'Enter a valid 6-digit pincode', [{ path: 'pin', message: 'Invalid pincode' }]);
  const geo = await resolveGeo(ctx, pin);
  if (geo.source === 'none') throw new AppError(404, 'NOT_FOUND', 'We could not find that pincode');
  return { pincode: pin, city: geo.city, district: geo.district, state: geo.state, serviceable: !!geo.territory_id };
}));

export default router;
