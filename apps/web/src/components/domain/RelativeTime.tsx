import { formatDateTime } from '@solar/shared';
import { useEffect, useState } from 'react';

/** "5 min ago", "2 h ago", "3 d ago" — hover for the exact IST time. */
export function RelativeTime({ value, className }: { value: string | null | undefined; className?: string }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => tick((n) => n + 1), 60_000); return () => window.clearInterval(t); }, []);
  if (!value) return <span className={className}>—</span>;
  const diff = Date.now() - new Date(value).getTime();
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60000);
  const text = min < 1 ? 'just now' : min < 60 ? `${min} min` : min < 1440 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} d`;
  return <time dateTime={value} title={formatDateTime(value)} className={className}>{min < 1 ? text : diff >= 0 ? `${text} ago` : `in ${text}`}</time>;
}
