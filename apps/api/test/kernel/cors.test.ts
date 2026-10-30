import { describe, expect, it } from 'vitest';
import { originAllowed } from '../../src/app';

describe('CORS allow-list', () => {
  const list = ['http://localhost:5173', 'https://*.vercel.app'];
  it('accepts exact origins, wildcard labels and callers without an origin', () => {
    expect(originAllowed(list, 'http://localhost:5173')).toBe(true);
    expect(originAllowed(list, 'https://solar-crm-git-main-team.vercel.app')).toBe(true);
    expect(originAllowed(list, undefined)).toBe(true);
  });
  it('rejects look-alikes and other sites', () => {
    expect(originAllowed(list, 'https://evil.com')).toBe(false);
    expect(originAllowed(list, 'https://solar.vercel.app.evil.com')).toBe(false);
    expect(originAllowed(list, 'http://solar.vercel.app')).toBe(false);
    expect(originAllowed(list, 'https://a.b.vercel.app')).toBe(false);
  });
});
