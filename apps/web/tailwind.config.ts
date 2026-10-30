import type { Config } from 'tailwindcss';

const c = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
    content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Manrope Variable"', 'system-ui', 'sans-serif'],
        display: ['"Fraunces Variable"', 'Georgia', 'serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      colors: {
        bg: c('bg'), surface: c('surface'), 'surface-2': c('surface-2'), border: c('border'), 'border-strong': c('border-strong'),
        fg: c('fg'), muted: c('muted'), subtle: c('subtle'),
        primary: { DEFAULT: c('primary'), fg: c('primary-fg'), soft: c('primary-soft'), text: c('primary-text'), hover: c('primary-hover') },
        accent: { DEFAULT: c('accent'), soft: c('accent-soft'), text: c('accent-text') },
        success: { DEFAULT: c('success'), soft: c('success-soft'), text: c('success-text') },
        warning: { DEFAULT: c('warning'), soft: c('warning-soft'), text: c('warning-text') },
        danger: { DEFAULT: c('danger'), soft: c('danger-soft'), text: c('danger-text') },
        info: { DEFAULT: c('info'), soft: c('info-soft'), text: c('info-text') },
        // ownership legend from the reference flow chart
        owner: { system: c('owner-system'), distributor: c('owner-distributor'), customer: c('owner-customer'), sales: c('owner-sales'), management: c('owner-management') },
      },
      borderRadius: { xl: '16px', lg: '12px', md: '10px', sm: '6px' },
      boxShadow: {
        card: '0 1px 2px rgb(22 25 21 / 0.04)',
        pop: '0 12px 32px rgb(22 25 21 / 0.12), 0 2px 8px rgb(22 25 21 / 0.06)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-in-right': { from: { transform: 'translateX(24px)', opacity: '0' }, to: { transform: 'translateX(0)', opacity: '1' } },
        'pop-in': { from: { transform: 'scale(.97)', opacity: '0' }, to: { transform: 'scale(1)', opacity: '1' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
      },
      animation: { 'fade-in': 'fade-in .15s ease-out', 'slide-in-right': 'slide-in-right .2s ease-out', 'pop-in': 'pop-in .15s ease-out' },
    },
  },
  plugins: [],
} satisfies Config;
