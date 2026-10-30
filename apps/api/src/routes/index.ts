import type { Router } from 'express';
import admin from './admin.routes';
import approvals from './approvals.routes';
import channel from './channel.routes';
import commercial from './commercial.routes';
import compliance from './compliance.routes';
import customers from './customers.routes';
import dashboards from './dashboards.routes';
import documents from './documents.routes';
import leads from './leads.routes';
import lookups from './lookups.routes';
import opportunities from './opportunities.routes';
import platform from './platform.routes';
import postsale from './postsale.routes';
import privacy from './privacy.routes';
import quotes from './quotes.routes';
import reports from './reports.routes';
import search from './search.routes';
import skus from './skus.routes';

/**
 * Router registry. Each feature module exports a default express Router with full resource paths
 * (e.g. router.get('/leads', …)) and is mounted under /api/v1 after authentication.
 *
 * Importing a module here is also what registers its side effects at start-up:
 * clock handlers (lead acceptance, SOP, DISCOM…), approval handlers and nightly jobs.
 * Unauthenticated routers (public lead capture, webhooks, signed files, auth) are mounted directly in app.ts.
 */
export const publicRouters: Router[] = [];

export const authedRouters: Router[] = [
  leads, lookups, customers, opportunities,
  skus, quotes, approvals, compliance,
  commercial,
  postsale, channel,
  platform, admin, documents, privacy,
  dashboards, reports, search,
];
