import 'dotenv/config';
import { z } from 'zod';

const bool = z.preprocess((v) => (typeof v === 'boolean' ? String(v) : v), z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1'));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  LOG_LEVEL: z.string().default('info'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),

  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  /** Force demo mode (in-memory data + role-switcher login) even if Supabase variables are present. */
  DEMO_MODE: bool.optional(),
  SESSION_TIMEOUT_MINUTES: z.coerce.number().default(480),

  WHATSAPP_PROVIDER: z.enum(['mock']).default('mock'),
  SMS_PROVIDER: z.enum(['mock']).default('mock'),
  EMAIL_PROVIDER: z.enum(['mock', 'smtp']).default('mock'),
  DND_PROVIDER: z.enum(['mock']).default('mock'),
  EINVOICE_PROVIDER: z.enum(['mock']).default('mock'),
  EWAYBILL_PROVIDER: z.enum(['mock']).default('mock'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('Future Solar <no-reply@futuresolar.example>'),

  PUBLIC_RATE_LIMIT_PER_MIN: z.coerce.number().default(30),
  AUTH_RATE_LIMIT_PER_15MIN: z.coerce.number().default(30),
  MAX_UPLOAD_MB: z.coerce.number().default(10),
  RUN_JOBS: bool.default('true'),
});

export type Config = z.infer<typeof schema> & { demo: boolean; dataMode: 'memory' | 'supabase'; corsOrigins: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Record<keyof z.input<typeof schema>, unknown>> = {}): Config {
  // A blank value in .env (e.g. `DEMO_MODE=`) means "not set", never an invalid empty string.
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.parse({ ...present, ...overrides });
  const haveSupabase = !!(parsed.SUPABASE_URL && parsed.SUPABASE_SERVICE_ROLE_KEY);
  const demo = parsed.DEMO_MODE ?? !haveSupabase;
  return {
    ...parsed,
    demo,
    dataMode: demo || !haveSupabase ? 'memory' : 'supabase',
    corsOrigins: parsed.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  };
}
