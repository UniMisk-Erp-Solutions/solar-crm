/** Thin typed fetch client for the Node API. Every call carries the user JWT; errors are normalised to ApiError. */
export interface ApiErrorBody { error?: { code?: string; message?: string; details?: unknown } }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
  /** field-level messages from a VALIDATION_ERROR, keyed by dotted path */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (Array.isArray(this.details)) for (const d of this.details as { path?: string; message?: string }[]) if (d?.path) out[d.path] = d.message ?? 'Invalid value';
    return out;
  }
}

export interface Paged<T> { data: T[]; total: number; limit: number; offset: number }
export interface One<T> { data: T }

const REGION = (import.meta.env.VITE_API_REGION as string | undefined) ?? '';
const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const PREFIX = `${BASE}/api/v1`;

let tokenProvider: () => Promise<string | null> | string | null = () => null;
let unauthorizedHandler: () => void = () => undefined;
export const setTokenProvider = (fn: typeof tokenProvider): void => { tokenProvider = fn; };
export const setUnauthorizedHandler = (fn: () => void): void => { unauthorizedHandler = fn; };

export type Query = Record<string, string | number | boolean | null | undefined | (string | number)[]>;

export function toQueryString(q?: Query): string {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

interface ReqOpts { query?: Query; body?: unknown; form?: FormData; signal?: AbortSignal; raw?: boolean; auth?: boolean; headers?: Record<string, string> }

async function toError(res: Response): Promise<ApiError> {
  try {
    const j = (await res.json()) as ApiErrorBody;
    return new ApiError(res.status, j.error?.code ?? 'ERROR', j.error?.message ?? `Request failed (${res.status})`, j.error?.details);
  } catch {
    return new ApiError(res.status, 'ERROR', `Request failed (${res.status})`);
  }
}

async function request<T>(method: string, path: string, opts: ReqOpts = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? {}) };
  // run the API function in the region of the database (Supabase Edge Functions otherwise start nearest to the visitor, far from the data)
  if (BASE && REGION) headers['x-region'] = REGION;
  if (opts.auth !== false) {
    const token = await tokenProvider();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
  let res: Response;
  try {
    res = await fetch(`${PREFIX}${path}${toQueryString(opts.query)}`, { method, headers, body, signal: opts.signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection and try again.');
  }
  if (opts.raw) {
    if (!res.ok) throw await toError(res);
    return res as unknown as T;
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    if (res.status === 401 && opts.auth !== false) unauthorizedHandler();
    const e = (json as ApiErrorBody | undefined)?.error;
    throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>('GET', path, { query, signal }),
  post: <T>(path: string, body?: unknown, query?: Query) => request<T>('POST', path, { body: body ?? {}, query }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body: body ?? {} }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body: body ?? {} }),
  del: <T>(path: string) => request<T>('DELETE', path),
  upload: <T>(path: string, form: FormData) => request<T>('POST', path, { form }),
  /** unauthenticated (public) call */
  anon: <T>(method: string, path: string, body?: unknown, headers?: Record<string, string>) => request<T>(method, path, { body, auth: false, headers }),
  /** download a file (xlsx / pdf) and trigger a browser save */
  download: async (path: string, query?: Query, filename?: string): Promise<void> => {
    const res = await request<Response>('GET', path, { query, raw: true });
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') ?? '';
    const name = filename ?? /filename="?([^";]+)"?/.exec(cd)?.[1] ?? 'download';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },
  /** open a PDF (or any blob) in a new tab */
  openBlob: async (path: string, query?: Query): Promise<void> => {
    const res = await request<Response>('GET', path, { query, raw: true });
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
};

export const errorMessage = (e: unknown): string => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong');
