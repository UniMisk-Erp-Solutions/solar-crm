import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import { ROLE_LABEL, type AppRole, type Profile } from '@solar/shared';
import { ToastProvider } from '@/components/ui/toast';
import { AuthProvider } from '@/lib/auth';
import '@/lib/i18n';

type Json = unknown;
export type Handler = Json | ((req: { url: URL; method: string; body: unknown }) => Json | { status: number; body: Json });
/** Keys look like "GET /leads" (path only, no /api/v1 prefix, no query string). */
export type Handlers = Record<string, Handler>;

export function fakeProfile(role: AppRole, over: Partial<Profile> = {}): Profile {
  const iso = '2026-10-26T05:00:00.000Z';
  return {
    id: '11111111-1111-4111-8111-111111111111', org_id: '22222222-2222-4222-8222-222222222222', full_name: `Test ${ROLE_LABEL[role]}`, email: `${role}@test.local`, phone: null, role, designation: null,
    distributor_id: null, dealer_id: null, territory_ids: [], reports_to: null, language: 'en', active: true, created_at: iso, updated_at: iso, created_by: null, ...over,
  };
}

/** Replace global fetch with an in-memory API. Unmatched calls return 404 so a test fails loudly instead of hanging. */
export function mockApi(handlers: Handlers, role: AppRole = 'dsm') {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const all: Handlers = {
    'GET /auth/mode': { data: { demo: true, session_timeout_minutes: 480 } },
    'GET /auth/me': { data: { profile: fakeProfile(role), role_label: ROLE_LABEL[role], org: { id: 'o', name: 'Future Solar' }, permissions: { can_see_mobile: true }, session: { demo: true, timeout_minutes: 480 } } },
    'GET /notifications/unread-count': { data: { count: 0 } },
    'GET /calendar': { data: [] },
    'GET /approvals/summary': { data: { mine: 0 } },
    ...handlers,
  };
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const h = all[`${method} ${path}`];
    if (h === undefined) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: `No mock for ${method} ${path}` } }), { status: 404 });
    const out = typeof h === 'function' ? h({ url, method, body }) : h;
    if (out && typeof out === 'object' && 'status' in (out as object) && 'body' in (out as object)) {
      const o = out as { status: number; body: Json };
      return new Response(JSON.stringify(o.body), { status: o.status });
    }
    return new Response(JSON.stringify(out), { status: 200 });
  });
  vi.stubGlobal('fetch', fn);
  try { sessionStorage.setItem('fs-demo-token', 'demo.test'); } catch { /* ignore */ }
  return { calls, fetch: fn };
}

export interface RenderOpts { route?: string; path?: string; role?: AppRole; handlers?: Handlers }

/** Render a page inside router, query client, toasts, theme and the real AuthProvider (backed by the mocked API). */
export function renderPage(ui: ReactElement, opts: RenderOpts = {}): RenderResult & { api: ReturnType<typeof mockApi> } {
  const api = mockApi(opts.handlers ?? {}, opts.role ?? 'dsm');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  const result = render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <AuthProvider>
            <MemoryRouter initialEntries={[opts.route ?? '/']}>
              <Routes><Route path={opts.path ?? '*'} element={ui} /></Routes>
            </MemoryRouter>
          </AuthProvider>
        </ToastProvider>
      </QueryClientProvider>
  );
  return Object.assign(result, { api });
}

export const page = <T,>(rows: T[], total = rows.length) => ({ data: rows, total, limit: 25, offset: 0 });
