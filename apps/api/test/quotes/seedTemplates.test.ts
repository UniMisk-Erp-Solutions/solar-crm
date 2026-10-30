/** The templates and clause keys that application code refers to must exist in the seed: a missing key silently blocks a customer message or drops a clause. */
import { describe, expect, it } from 'vitest';
import { buildSeed } from '@solar/shared/seed';

describe('seeded message templates referenced by the application', () => {
  const seed = buildSeed(new Date('2026-10-26T05:00:00Z'));
  const templates = seed.message_templates ?? [];

  it('every clause in the default-clause rule is an active template', () => {
    const rule = (seed.rule_config ?? []).find((r) => r.category === 'quote' && r.key === 'default_clauses')!;
    for (const key of rule.value as string[]) {
      expect(templates.some((t) => t.key === key && t.active), `clause template ${key}`).toBe(true);
    }
    expect((rule.value as string[]).length).toBeGreaterThanOrEqual(4); // price validity, duty change, GST change, ALMM change
  });

  it('the WhatsApp templates used when a quote is sent and when payment is chased exist, approved by name, utility category', () => {
    for (const key of ['wa.quote_sent', 'wa.payment_reminder']) {
      const t = templates.find((x) => x.key === key && x.channel === 'whatsapp' && x.language === 'en')!;
      expect(t, key).toBeTruthy();
      expect(t).toMatchObject({ active: true, category: 'utility', purpose: 'transactional' });
      expect(t.whatsapp_template_name).toBeTruthy();
    }
  });
});
