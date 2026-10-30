import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/config';

/** Parses a .env file the way dotenv does (KEY=value, # comments, optional quotes). */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^"(.*)"$/, '$1');
  }
  return out;
}

describe('configuration', () => {
  it('starts in demo mode from the shipped .env.example with every blank value left blank', () => {
    const env = parseEnv(readFileSync(join(__dirname, '../../.env.example'), 'utf8'));
    expect(env['DEMO_MODE']).toBe('');
    const cfg = loadConfig(env as NodeJS.ProcessEnv);
    expect(cfg.demo).toBe(true);
    expect(cfg.dataMode).toBe('memory');
    expect(cfg.PORT).toBe(4000);
  });

  it('goes live only when both Supabase variables are set and demo is not forced', () => {
    expect(loadConfig({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' } as NodeJS.ProcessEnv).dataMode).toBe('supabase');
    expect(loadConfig({ SUPABASE_URL: 'https://x.supabase.co' } as NodeJS.ProcessEnv).demo).toBe(true);
    expect(loadConfig({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', DEMO_MODE: 'true' } as NodeJS.ProcessEnv).dataMode).toBe('memory');
  });
});
