import { seedId } from '../ids';
import type { RuleConfig } from '../rows';
import { rules_core } from './rules.core';
import { rules_leads } from './rules.leads';
import { rules_orders } from './rules.orders';
import { rules_platform } from './rules.platform';
import { rules_postsale } from './rules.postsale';
import { rules_quotes } from './rules.quotes';
import { rules_regulatory } from './rules.regulatory';
import { rules_reporting } from './rules.reporting';
import type { RuleSeedInput } from './rules.types';
import { rules_sites } from './rules.sites';
import { makeEnv } from './util';

export const DEFAULT_RULE_EFFECTIVE_FROM = '2020-01-01';

/**
 * Every rule fragment, in precedence order. The seed module's own rows (core, regulatory) come first, so if a module fragment
 * accidentally redefines the same path + effective date, the seed module's row is kept.
 */
export function ruleFragments(): { name: string; rules: RuleSeedInput[] }[] {
  return [
    { name: 'core', rules: rules_core },
    { name: 'regulatory', rules: rules_regulatory },
    { name: 'leads', rules: rules_leads },
    { name: 'sites', rules: rules_sites },
    { name: 'quotes', rules: rules_quotes },
    { name: 'orders', rules: rules_orders },
    { name: 'postsale', rules: rules_postsale },
    { name: 'platform', rules: rules_platform },
    { name: 'reporting', rules: rules_reporting },
  ];
}

export const ruleKey = (path: string, effectiveFrom?: string): string => `${path}@${effectiveFrom ?? DEFAULT_RULE_EFFECTIVE_FROM}`;
export const ruleSeedId = (path: string, effectiveFrom?: string): string => seedId(`rule:${ruleKey(path, effectiveFrom)}`, 1);

/** Splits "<category>.<key>" at the FIRST dot. */
export function splitRulePath(path: string): { category: string; key: string } {
  const i = path.indexOf('.');
  if (i < 1 || i === path.length - 1) throw new Error(`Invalid rule path "${path}"`);
  return { category: path.slice(0, i), key: path.slice(i + 1) };
}

/** All rules merged into rule_config rows. Fragments may be empty. Duplicates (same path + effective_from) keep the first occurrence. */
export function buildRuleConfigRows(now: Date = new Date()): RuleConfig[] {
  const env = makeEnv(now);
  const seen = new Set<string>();
  const rows: RuleConfig[] = [];
  for (const { rules } of ruleFragments()) {
    for (const r of rules) {
      const from = r.effective_from ?? DEFAULT_RULE_EFFECTIVE_FROM;
      const k = ruleKey(r.path, from);
      if (seen.has(k)) continue;
      seen.add(k);
      const { category, key } = splitRulePath(r.path);
      rows.push({
        id: ruleSeedId(r.path, from), org_id: env.org, created_at: env.t(-30 * 1440), updated_at: env.t(-30 * 1440), created_by: null,
        category, key, value: r.value, effective_from: from, effective_to: r.effective_to ?? null,
        source_name: r.source_name, source_ref: r.source_ref, confidence: r.confidence, status: r.status,
        is_active: r.active, max_severity: r.max_severity ?? 'warning', enforce_hard_stop: false, notes: r.notes ?? null, updated_by: null,
      });
    }
  }
  return rows;
}
