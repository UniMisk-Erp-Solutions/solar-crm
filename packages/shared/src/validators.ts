import { z } from 'zod';
import { normalizeMobile } from './format';
import { detectAadhaar } from './aadhaar';

export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
export const PINCODE_RE = /^[1-9]\d{5}$/;
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const isMobile = (v: string): boolean => normalizeMobile(v) !== null;
export const isGstin = (v: string): boolean => GSTIN_RE.test(v.toUpperCase());
export const isPan = (v: string): boolean => PAN_RE.test(v.toUpperCase());

/** Mobile accepted in any common format; output is E.164 (+91XXXXXXXXXX). */
export const mobileSchema = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const n = normalizeMobile(v);
    if (!n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid 10-digit Indian mobile number starting with 6–9' });
      return z.NEVER;
    }
    return `+91${n}`;
  });

export const emailSchema = z.string().trim().toLowerCase().regex(EMAIL_RE, 'Enter a valid e-mail address');
export const optionalEmailSchema = z.union([z.literal('').transform(() => null), emailSchema.nullable()]).nullable().optional();
export const pincodeSchema = z.string().trim().regex(PINCODE_RE, 'Enter a valid 6-digit pincode');
export const gstinSchema = z.string().trim().toUpperCase().regex(GSTIN_RE, 'Enter a valid 15-character GSTIN');
export const panSchema = z.string().trim().toUpperCase().regex(PAN_RE, 'Enter a valid PAN');
export const uuidSchema = z.string().uuid();
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const isoDateTimeSchema = z.string().datetime({ offset: true });

/** Free-text field that rejects Aadhaar numbers (gate G14). */
export const safeText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => detectAadhaar(v).length === 0, { message: 'Aadhaar numbers must not be entered here — use last four digits only.', params: { code: 'AADHAAR_BLOCKED' } });

export const addressSchema = z.object({
  line1: z.string().trim().min(1, 'Address line is required').max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(100),
  district: z.string().trim().max(100).optional(),
  state: z.string().trim().min(1).max(100),
  pincode: pincodeSchema,
});

export const listQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.string().trim().max(60).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type ListQuery = z.infer<typeof listQuerySchema>;
