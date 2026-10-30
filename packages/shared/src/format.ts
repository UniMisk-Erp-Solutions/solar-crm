/** Display helpers — INR with Indian digit grouping, DD-MMM-YYYY dates, Asia/Kolkata. */

export const IST = 'Asia/Kolkata';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** Indian digit grouping: 1234567.5 -> "12,34,567.50" */
export function groupIndian(value: number, decimals = 0): string {
  if (!Number.isFinite(value)) return '—';
  const neg = value < 0;
  const fixed = Math.abs(value).toFixed(decimals);
  const [int = '0', frac] = fixed.split('.');
  let out: string;
  if (int.length <= 3) out = int;
  else {
    const last3 = int.slice(-3);
    const rest = int.slice(0, -3);
    out = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
  }
  return (neg ? '-' : '') + out + (frac ? '.' + frac : '');
}

/** "₹ 12,34,567" (or with paise when decimals = 2) */
export function formatINR(value: number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `₹ ${groupIndian(value, decimals)}`;
}

/** Compact: ₹ 12.3 L / ₹ 4.5 Cr for dashboards */
export function formatINRCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}₹ ${(abs / 1e7).toFixed(abs >= 1e8 ? 1 : 2)} Cr`;
  if (abs >= 1e5) return `${sign}₹ ${(abs / 1e5).toFixed(2)} L`;
  return `${sign}₹ ${groupIndian(abs)}`;
}

function istParts(d: Date): { y: number; m: number; day: number; h: number; min: number } {
  // IST = UTC+05:30, no DST — safe to compute by offset without Intl.
  const t = new Date(d.getTime() + 5.5 * 3600 * 1000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), day: t.getUTCDate(), h: t.getUTCHours(), min: t.getUTCMinutes() };
}

/** DD-MMM-YYYY in IST. Accepts ISO strings (date-only strings are treated as that calendar date). */
export function formatDate(input: string | Date | null | undefined): string {
  if (!input) return '—';
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const [y, m, d] = input.split('-').map(Number) as [number, number, number];
    return `${String(d).padStart(2, '0')}-${MONTHS[m - 1]}-${y}`;
  }
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '—';
  const p = istParts(d);
  return `${String(p.day).padStart(2, '0')}-${MONTHS[p.m]}-${p.y}`;
}

/** DD-MMM-YYYY, hh:mm AM/PM IST */
export function formatDateTime(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '—';
  const p = istParts(d);
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  return `${formatDate(d)}, ${String(h12).padStart(2, '0')}:${String(p.min).padStart(2, '0')} ${p.h >= 12 ? 'PM' : 'AM'}`;
}

/** YYYY-MM-DD of an instant in IST. */
export function istDateString(d: Date = new Date()): string {
  const p = istParts(d);
  return `${p.y}-${String(p.m + 1).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Whole calendar days from `from` to `to` in IST (positive when `to` is later). */
export function daysBetween(from: string | Date, to: string | Date): number {
  const a = istDateString(typeof from === 'string' ? new Date(from) : from);
  const b = istDateString(typeof to === 'string' ? new Date(to) : to);
  const da = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const db = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.round((db - da) / 86400000);
}

/** Human duration: "2 h 15 min", "3 d", "45 min" */
export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  const min = Math.floor(abs / 60000);
  if (min < 1) return '< 1 min';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h${min % 60 ? ` ${min % 60} min` : ''}`;
  const d = Math.floor(h / 24);
  return `${d} d${h % 24 ? ` ${h % 24} h` : ''}`;
}

export function formatKw(kw: number | null | undefined): string {
  if (kw === null || kw === undefined) return '—';
  if (kw >= 1000) return `${(kw / 1000).toFixed(2).replace(/\.?0+$/, '')} MW`;
  return `${Number.isInteger(kw) ? kw : kw.toFixed(2).replace(/\.?0+$/, '')} kW`;
}

/** +919876543210 or 9876543210 -> "+91 98765 43210" */
export function formatMobile(m: string | null | undefined): string {
  if (!m) return '—';
  const n = normalizeMobile(m);
  if (!n) return m;
  return `+91 ${n.slice(0, 5)} ${n.slice(5)}`;
}

/** Mask all but the last 3 digits: "+91 ••••• ••123" */
export function maskMobile(m: string | null | undefined): string {
  if (!m) return '—';
  const n = normalizeMobile(m);
  if (!n) return '••••••••••';
  return `+91 ••••• ••${n.slice(-3)}`;
}

export function maskEmail(e: string | null | undefined): string {
  if (!e) return '—';
  const [u = '', d = ''] = e.split('@');
  return `${u.slice(0, 1)}•••@${d}`;
}

/** Returns the bare 10-digit national number, or null when invalid. */
export function normalizeMobile(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.replace(/[\s\-().]/g, '');
  if (s.startsWith('+91')) s = s.slice(3);
  else if (s.startsWith('0091')) s = s.slice(4);
  else if (s.length === 12 && s.startsWith('91')) s = s.slice(2);
  else if (s.length === 11 && s.startsWith('0')) s = s.slice(1);
  return /^[6-9]\d{9}$/.test(s) ? s : null;
}

export function toE164(input: string): string | null {
  const n = normalizeMobile(input);
  return n ? `+91${n}` : null;
}

export function pct(n: number | null | undefined, decimals = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${n.toFixed(decimals).replace(/\.0+$/, '')}%`;
}

export function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
