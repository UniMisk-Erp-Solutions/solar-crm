/**
 * Aadhaar guard (gate G14). The CRM must never store an Aadhaar number or image.
 * Detects 12-digit numbers (optionally grouped 4-4-4) that pass the Verhoeff checksum.
 */

const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
] as const;
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
] as const;
const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9] as const;

/** True when `num` (digits only) satisfies the Verhoeff checksum. */
export function verhoeffValid(num: string): boolean {
  if (!/^\d+$/.test(num)) return false;
  let c = 0;
  const digits = num.split('').reverse().map(Number);
  for (let i = 0; i < digits.length; i++) {
    const row = P[i % 8] as readonly number[];
    c = (D[c as number] as readonly number[])[row[digits[i] as number] as number] as number;
  }
  return c === 0;
}

/** Generates the Verhoeff check digit for a numeric payload (used by tests and seed data). */
export function verhoeffCheckDigit(payload: string): string {
  let c = 0;
  const digits = payload.split('').reverse().map(Number);
  for (let i = 0; i < digits.length; i++) {
    const row = P[(i + 1) % 8] as readonly number[];
    c = (D[c] as readonly number[])[row[digits[i] as number] as number] as number;
  }
  return String(INV[c]);
}

/** Valid-looking Aadhaar: 12 digits, first digit 2-9, Verhoeff-valid. */
export function isAadhaarNumber(digits12: string): boolean {
  return /^[2-9]\d{11}$/.test(digits12) && verhoeffValid(digits12);
}

const CANDIDATE = /(?<!\d)([2-9]\d{3})[\s-]?(\d{4})[\s-]?(\d{4})(?!\d)/g;
const AADHAAR_WORDS = /\b(aadhaar|aadhar|adhaar|uidai|आधार|આધાર)\b/i;

export interface AadhaarMatch { index: number; masked: string }

/**
 * Scan free text. A +91 mobile written without a plus (91 + 6-9 + 9 digits) is NOT treated as Aadhaar.
 * Returns matches; empty array means clean.
 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function detectAadhaar(input: string | null | undefined): AadhaarMatch[] {
  if (!input) return [];
  // a UUID's last group can be 12 digits that happen to pass the checksum — blank UUIDs out before scanning
  const text = input.replace(UUID_RE, ' ');
  const out: AadhaarMatch[] = [];
  for (const m of text.matchAll(CANDIDATE)) {
    const digits = `${m[1]}${m[2]}${m[3]}`;
    if (/^91[6-9]\d{9}$/.test(digits)) continue;
    if (isAadhaarNumber(digits)) out.push({ index: m.index ?? 0, masked: `XXXX XXXX ${digits.slice(-4)}` });
  }
  return out;
}

/** Filename heuristic: "aadhaar_card.jpg", "adhar-front.png" etc. */
export function looksLikeAadhaarFilename(name: string | null | undefined): boolean {
  if (!name) return false;
  return AADHAAR_WORDS.test(name.replace(/[_\-.]/g, ' ')) || detectAadhaar(name.replace(/\.[a-z0-9]+$/i, '')).length > 0;
}

/** Recursively scans an arbitrary JSON-like value. Returns dotted paths of offending string fields. */
/**
 * Fields that legitimately hold long numeric identifiers (12-digit UPI/UTR references, e-way bill numbers, DISCOM consumer numbers…).
 * They are labelled structured identifiers, never free text, so they are not scanned. Every free-text field still is.
 */
export const AADHAAR_SCAN_SKIP_KEYS: ReadonlySet<string> = new Set([
  'mobile', 'phone', 'pincode', 'account_no', 'gstin', 'pan', 'ewb_no', 'irn', 'ack_no', 'invoice_no', 'reference', 'utr', 'txn_id', 'cheque_no',
  'consumer_no', 'application_no', 'e_token', 'portal_vendor_id', 'doc_ref', 'serial', 'batch_no', 'proof_ref', 'source_ref', 'brand_claim_no', 'complaint_ref', 'vehicle_no',
]);

export function scanForAadhaar(value: unknown, path = '', skipKeys: ReadonlySet<string> = AADHAAR_SCAN_SKIP_KEYS): string[] {
  const hits: string[] = [];
  if (typeof value === 'string') {
    if (detectAadhaar(value).length) hits.push(path || '(root)');
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...scanForAadhaar(v, `${path}[${i}]`, skipKeys)));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (skipKeys.has(k) || /(_id|_ids|Id|Ids)$/.test(k)) continue;
      hits.push(...scanForAadhaar(v, path ? `${path}.${k}` : k, skipKeys));
    }
  }
  return hits;
}
