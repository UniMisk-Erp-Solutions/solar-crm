import { AlertCircle } from 'lucide-react';
import { cloneElement, forwardRef, isValidElement, useId, type InputHTMLAttributes, type ReactElement, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

const control =
  'w-full rounded-lg border border-border-strong bg-surface px-3.5 text-[15px] text-fg placeholder:text-subtle transition-colors hover:border-primary/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:opacity-70 aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/20';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input({ className, invalid, ...rest }, ref) {
  return <input ref={ref} aria-invalid={invalid || undefined} className={cn(control, 'h-11', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(function Textarea({ className, invalid, rows = 3, ...rest }, ref) {
  return <textarea ref={ref} rows={rows} aria-invalid={invalid || undefined} className={cn(control, 'py-2 leading-relaxed', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean; placeholder?: string }>(function Select({ className, invalid, placeholder, children, ...rest }, ref) {
  return (
    <select ref={ref} aria-invalid={invalid || undefined} className={cn(control, 'h-11 pr-8', className)} {...rest}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {children}
    </select>
  );
});

export const Checkbox = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode; hint?: ReactNode }>(function Checkbox({ className, label, hint, id, ...rest }, ref) {
  const gen = useId();
  const cid = id ?? gen;
  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      <input ref={ref} id={cid} type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 rounded border-border-strong accent-[rgb(var(--primary))]" {...rest} />
      {(label || hint) && (
        <label htmlFor={cid} className="cursor-pointer text-sm leading-snug">
          {label}
          {hint && <span className="mt-0.5 block text-xs text-muted">{hint}</span>}
        </label>
      )}
    </div>
  );
});

export function Switch({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; id?: string }) {
  const gen = useId();
  return (
    <label htmlFor={id ?? gen} className={cn('inline-flex items-center gap-2 text-sm', disabled ? 'opacity-60' : 'cursor-pointer')}>
      <button
        id={id ?? gen} type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
        className={cn('relative h-6 w-11 rounded-full transition-colors', checked ? 'bg-success' : 'bg-border-strong')}
      >
        <span className={cn('absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform', checked && 'translate-x-5')} />
      </button>
      {label}
    </label>
  );
}

/** Label + control + hint + error, wired with aria attributes. Pass a single form control as the child. */
export function Field({ label, htmlFor, hint, error, required, children, className, optional }: {
  label: ReactNode; htmlFor?: string; hint?: ReactNode; error?: string; required?: boolean; optional?: boolean; children: ReactNode; className?: string;
}) {
  const gen = useId();
  const id = htmlFor ?? gen;
  const msgId = `${id}-msg`;
  const child = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, { id: (children.props as { id?: string }).id ?? id, invalid: !!error || (children.props as { invalid?: boolean }).invalid, 'aria-describedby': error || hint ? msgId : undefined })
    : children;
  return (
    <div className={cn('space-y-2', className)}>
      <label htmlFor={id} className="flex items-center gap-1 text-sm font-semibold text-fg">
        {label}
        {required && <span className="text-danger" aria-hidden>*</span>}
        {optional && <span className="text-xs font-normal text-muted">(optional)</span>}
      </label>
      {child}
      {error ? (
        <p id={msgId} role="alert" className="flex items-start gap-1 text-xs text-danger-text"><AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />{error}</p>
      ) : hint ? (
        <p id={msgId} className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function FormGrid({ children, cols = 2, className }: { children: ReactNode; cols?: 1 | 2 | 3; className?: string }) {
  return <div className={cn('grid gap-5', cols === 1 ? 'grid-cols-1' : cols === 2 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3', className)}>{children}</div>;
}

export function FormSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-4 border-t border-border pt-5 first:border-0 first:pt-0">
      <legend className="sr-only">{title}</legend>
      <div>
        <h3 className="text-sm font-bold text-fg">{title}</h3>
        {description && <p className="text-xs text-muted">{description}</p>}
      </div>
      {children}
    </fieldset>
  );
}
