import { CheckCircle2, Info, TriangleAlert, X, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Tone = 'success' | 'error' | 'info' | 'warning';
interface ToastItem { id: number; tone: Tone; message: string; title?: string }
interface ToastApi { success(m: string, title?: string): void; error(m: string, title?: string): void; info(m: string, title?: string): void; warning(m: string, title?: string): void }

const Ctx = createContext<ToastApi | null>(null);

const ICON = { success: CheckCircle2, error: XCircle, info: Info, warning: TriangleAlert } as const;
const TONE = {
  success: 'border-success/40 text-success-text [&_svg]:text-success',
  error: 'border-danger/40 text-danger-text [&_svg]:text-danger',
  info: 'border-info/40 text-info-text [&_svg]:text-info',
  warning: 'border-warning/40 text-warning-text [&_svg]:text-warning',
} as const;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback((tone: Tone, message: string, title?: string) => {
    const id = ++seq.current;
    setItems((l) => [...l.slice(-3), { id, tone, message, title }]);
    window.setTimeout(() => dismiss(id), tone === 'error' ? 8000 : 4500);
  }, [dismiss]);
  const api = useMemo<ToastApi>(() => ({
    success: (m, t) => push('success', m, t), error: (m, t) => push('error', m, t), info: (m, t) => push('info', m, t), warning: (m, t) => push('warning', m, t),
  }), [push]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div aria-live="polite" role="status" className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(92vw,380px)] flex-col gap-2">
        {items.map((t) => {
          const Icon = ICON[t.tone];
          return (
            <div key={t.id} className={cn('pointer-events-auto flex animate-pop-in items-start gap-3 rounded-lg border bg-surface p-3 shadow-pop', TONE[t.tone])}>
              <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
              <div className="min-w-0 flex-1">
                {t.title && <p className="text-sm font-bold">{t.title}</p>}
                <p className="text-sm text-fg">{t.message}</p>
              </div>
              <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss" className="rounded p-0.5 text-muted hover:bg-surface-2"><X className="h-4 w-4" /></button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useToast must be used inside <ToastProvider>');
  return v;
}
