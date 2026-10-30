import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { cn } from '@/lib/cn';

export const buttonStyles = cva(
  'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-fg hover:bg-primary-hover',
        accent: 'bg-accent text-white hover:bg-black',
        secondary: 'border border-border-strong bg-surface text-fg hover:bg-surface-2',
        ghost: 'text-fg hover:bg-surface-2',
        danger: 'bg-danger text-white hover:brightness-95',
        soft: 'bg-primary-soft text-primary-text hover:brightness-95',
        link: 'text-primary-text underline-offset-2 hover:underline px-0',
      },
      size: { xs: 'h-8 px-2.5 text-xs', sm: 'h-9 px-3.5 text-sm', md: 'h-11 px-5 text-[15px]', lg: 'h-12 px-6 text-base', icon: 'h-10 w-10' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonStyles> {
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, loading, leftIcon, rightIcon, children, disabled, type = 'button', ...rest }, ref,
) {
  return (
    <button ref={ref} type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={cn(buttonStyles({ variant, size }), className)} {...rest}>
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : leftIcon}
      {children}
      {!loading && rightIcon}
    </button>
  );
});

export function LinkButton({ className, variant, size, children, leftIcon, ...rest }: LinkProps & VariantProps<typeof buttonStyles> & { leftIcon?: ReactNode }) {
  return <Link className={cn(buttonStyles({ variant, size }), className)} {...rest}>{leftIcon}{children}</Link>;
}
