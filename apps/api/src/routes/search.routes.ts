import { Router } from 'express';
import { searchQuerySchema } from '@solar/shared';
import { ALL_ROLES, allow } from '../auth/authorize';
import { handle, query } from '../http/handler';
import { globalSearch } from '../services/searchService';

const router = Router();

/** GET /search?q=… — grouped, scope-aware global search (≤ 5 hits per group, personal data masked per role). */
router.get('/search', allow(...ALL_ROLES), handle((ctx, req) => {
  const { q, limit } = query(searchQuerySchema, req);
  return globalSearch(ctx, q, limit);
}));

export default router;
