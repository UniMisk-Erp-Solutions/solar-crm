import { cva, type VariantProps } from 'class-variance-authority';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

const badge = cva('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold leading-5', {
  variants: {
    tone: {
      neutral: 'border-border bg-surface-2 text-muted',
      primary: 'border-primary/20 bg-primary-soft text-primary-text',
      accent: 'border-accent/40 bg-accent-soft text-accent-text',
      success: 'border-success/30 bg-success-soft text-success-text',
      warning: 'border-warning/40 bg-warning-soft text-warning-text',
      danger: 'border-danger/30 bg-danger-soft text-danger-text',
      info: 'border-info/30 bg-info-soft text-info-text',
    },
  },
  defaultVariants: { tone: 'neutral' },
});
export type Tone = NonNullable<VariantProps<typeof badge>['tone']>;

export function Badge({ tone, className, children, dot, title }: { tone?: Tone; className?: string; children: ReactNode; dot?: boolean; title?: string }) {
  return (
    <span className={cn(badge({ tone }), className)} title={title}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}
