import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { api, errorMessage, type ApiError, type One, type Paged, type Query } from './api';
import { useToast } from '@/components/ui/toast';

export const queryKey = (path: string, query?: Query) => ['api', path, query ?? {}] as const;

/** GET /path -> unwrapped `data`. Pass `null` to disable. */
export function useGet<T>(path: string | null, query?: Query, opts: Partial<UseQueryOptions<T, ApiError>> = {}) {
  return useQuery<T, ApiError>({
    queryKey: queryKey(path ?? '', query),
    queryFn: async ({ signal }) => (await api.get<One<T>>(path!, query, signal)).data,
    enabled: path !== null && (opts.enabled ?? true),
    ...opts,
  });
}

/** Paginated list endpoint -> { data, total, limit, offset }. The previous page stays visible while the next one loads. */
export function useList<T>(path: string | null, query?: Query, opts: Partial<UseQueryOptions<Paged<T>, ApiError>> = {}) {
  return useQuery<Paged<T>, ApiError>({
    queryKey: queryKey(path ?? '', query),
    queryFn: ({ signal }) => api.get<Paged<T>>(path!, query, signal),
    enabled: path !== null && (opts.enabled ?? true),
    placeholderData: keepPreviousData,
    ...opts,
  });
}

/** Invalidate every cached GET whose path starts with one of the prefixes (e.g. '/leads'). */
export function invalidatePaths(qc: QueryClient, prefixes: string[]): Promise<void> {
  return qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'api' && typeof q.queryKey[1] === 'string' && prefixes.some((p) => (q.queryKey[1] as string).startsWith(p)) });
}

interface ActionOpts<TIn, TOut> {
  method?: 'post' | 'patch' | 'put' | 'del';
  path: string | ((input: TIn) => string);
  /** cache prefixes to refresh after success */
  invalidate?: string[];
  successMessage?: string | ((out: TOut) => string);
  /** set false to handle errors yourself (a toast is shown by default) */
  toastError?: boolean;
  onSuccess?: (out: TOut, input: TIn) => void;
}

/** Mutation with toast feedback and cache invalidation. `mutateAsync(input)` sends `input` as the JSON body. */
export function useAction<TIn = unknown, TOut = unknown>(o: ActionOpts<TIn, TOut>) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<TOut, ApiError, TIn>({
    mutationFn: async (input) => {
      const path = typeof o.path === 'function' ? o.path(input) : o.path;
      const method = o.method ?? 'post';
      const res = method === 'del' ? await api.del<One<TOut>>(path) : await api[method]<One<TOut>>(path, input);
      return (res as One<TOut> | undefined)?.data as TOut;
    },
    onSuccess: async (out, input) => {
      if (o.invalidate?.length) await invalidatePaths(qc, o.invalidate);
      if (o.successMessage) toast.success(typeof o.successMessage === 'function' ? o.successMessage(out) : o.successMessage);
      o.onSuccess?.(out, input);
    },
    onError: (e) => { if (o.toastError !== false) toast.error(errorMessage(e)); },
  });
}
