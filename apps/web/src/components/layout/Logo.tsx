import { cn } from '@/lib/cn';

export function SunMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('h-9 w-9 shrink-0', className)} aria-hidden>
      <rect width="32" height="32" rx="9" fill="rgb(var(--primary))" />
      <circle cx="16" cy="16" r="5.5" fill="#fff" />
      <g stroke="#fff" strokeWidth="2" strokeLinecap="round"><path d="M16 4.5v3M16 24.5v3M4.5 16h3M24.5 16h3M7.9 7.9l2.1 2.1M22 22l2.1 2.1M7.9 24.1L10 22M22 10l2.1-2.1" /></g>
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-3', className)}>
      <SunMark />
      <span className="leading-none">
        <span className="display block text-[19px] font-semibold tracking-tight text-fg">Future Solar</span>
        <span className="mt-1 block text-[10px] font-bold uppercase tracking-[0.2em] text-primary-text">Lead to order</span>
      </span>
    </span>
  );
}
