import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = window.setTimeout(() => setV(value), ms); return () => window.clearTimeout(t); }, [value, ms]);
  return v;
}

/**
 * Filter state kept in the URL (shareable, survives refresh and the back button).
 * `defaults` define the known keys; empty values are removed from the address bar.
 */
export function useUrlState<T extends Record<string, string>>(defaults: T): [T, (patch: Partial<T>, opts?: { keepOffset?: boolean }) => void, () => void] {
  const [params, setParams] = useSearchParams();
  const keys = Object.keys(defaults);
  const state = useMemo(() => {
    const s = { ...defaults } as Record<string, string>;
    for (const k of keys) { const v = params.get(k); if (v !== null) s[k] = v; }
    return s as T;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  const set = useCallback((patch: Partial<T>, opts?: { keepOffset?: boolean }) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) { if (v === undefined || v === '' || v === defaults[k]) next.delete(k); else next.set(k, String(v)); }
      if (!opts?.keepOffset && !('offset' in patch)) next.delete('offset');
      return next;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setParams]);
  const reset = useCallback(() => setParams(new URLSearchParams(), { replace: true }), [setParams]);
  return [state, set, reset];
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : initial; } catch { return initial; }
  });
  const set = useCallback((n: T) => { setV(n); try { localStorage.setItem(key, JSON.stringify(n)); } catch { /* storage unavailable */ } }, [key]);
  return [v, set];
}

export function useKeyboardShortcut(combo: { key: string; ctrlOrMeta?: boolean }, handler: (e: KeyboardEvent) => void): void {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName) || (e.target as HTMLElement)?.isContentEditable;
      if (combo.ctrlOrMeta ? (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === combo.key : !typing && e.key === combo.key) handler(e);
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [combo.key, combo.ctrlOrMeta, handler]);
}
