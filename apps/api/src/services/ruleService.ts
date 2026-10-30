import { istDateString, type Json, type RuleConfig } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { audit } from '../lib/audit';
import { badRequest } from '../http/errors';
import type { ResolvedRule, RuleService, RuleVersionInput } from './contracts';
import { fireRuleChanged } from './hooks';

const toDate = (ref: Date | string | undefined, ctx: AppContext): string =>
  typeof ref === 'string' ? ref.slice(0, 10) : istDateString(ref ?? ctx.now());

const resolved = (r: RuleConfig): ResolvedRule => ({
  id: r.id, category: r.category, key: r.key, value: r.value, status: r.status, confidence: r.confidence, isActive: r.is_active,
  maxSeverity: r.max_severity, enforceHardStop: r.enforce_hard_stop, source: { name: r.source_name, ref: r.source_ref },
  effective_from: r.effective_from, effective_to: r.effective_to, notes: r.notes,
});

const dayBefore = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

export function createRuleService(ctx: AppContext): RuleService {
  const cache = new Map<string, RuleConfig[]>();
  const versions = async (category: string, key: string): Promise<RuleConfig[]> => {
    const k = `${category}\u0000${key}`;
    let v = cache.get(k);
    if (!v) { v = await ctx.db.table('rule_config').all({ category, key }, { orderBy: { col: 'effective_from', dir: 'desc' } }); cache.set(k, v); }
    return v;
  };
  const split = (path: string): [string, string] => {
    const i = path.indexOf('.');
    if (i < 1) throw badRequest(`Invalid rule path "${path}"`);
    return [path.slice(0, i), path.slice(i + 1)];
  };

  const svc: RuleService = {
    async get(category, key, ref) {
      const on = toDate(ref, ctx);
      const inForce = (await versions(category, key)).filter((r) => r.effective_from <= on && (!r.effective_to || r.effective_to >= on));
      if (!inForce.length) return null;
      // latest effective_from wins; on a tie prefer an active version
      inForce.sort((a, b) => (a.effective_from === b.effective_from ? Number(b.is_active) - Number(a.is_active) : a.effective_from < b.effective_from ? 1 : -1));
      return resolved(inForce[0]!);
    },
    async path(path, ref) { const [c, k] = split(path); return svc.get(c, k, ref); },
    async value<T = Json>(path: string, ref?: Date | string, fallback: T | null = null) {
      const r = await svc.path(path, ref);
      return r && r.isActive ? (r.value as unknown as T) : fallback;
    },
    async list(filter = {}) {
      const where: Record<string, string | boolean> = {};
      if (filter.category) where['category'] = filter.category;
      if (filter.status) where['status'] = filter.status;
      if (filter.active !== undefined) where['is_active'] = filter.active;
      return ctx.db.table('rule_config').all(where, { orderBy: [{ col: 'category' }, { col: 'key' }, { col: 'effective_from', dir: 'desc' }], search: filter.q ? { cols: ['category', 'key', 'notes', 'source_name'], text: filter.q } : undefined });
    },
    async history(category, key) { return ctx.db.table('rule_config').all({ category, key }, { orderBy: { col: 'effective_from', dir: 'desc' } }); },

    async createVersion(input: RuleVersionInput) {
      if (!input.source_ref.trim()) throw badRequest('A source reference is mandatory for every rule version');
      const existing = await ctx.db.table('rule_config').all({ category: input.category, key: input.key });
      // close the previous open-ended version the day before this one starts
      for (const prev of existing) {
        if (prev.effective_from < input.effective_from && (!prev.effective_to || prev.effective_to >= input.effective_from)) {
          await ctx.db.table('rule_config').update(prev.id, { effective_to: dayBefore(input.effective_from), updated_by: ctx.user.id });
        }
      }
      const row = await ctx.db.table('rule_config').insert({
        category: input.category, key: input.key, value: input.value, effective_from: input.effective_from, effective_to: input.effective_to ?? null,
        source_name: input.source_name, source_ref: input.source_ref, confidence: input.confidence, status: input.status, is_active: input.is_active ?? false,
        max_severity: input.max_severity ?? 'warning', enforce_hard_stop: input.enforce_hard_stop ?? false, notes: input.notes ?? null, updated_by: ctx.user.id, created_by: ctx.user.id,
      });
      cache.clear();
      await audit(ctx, { action: 'rule.create_version', table: 'rule_config', record_id: row.id, new: row as unknown as Json });
      await fireRuleChanged(ctx, row, 'created');
      return row;
    },

    async update(id, patch) {
      const before = await ctx.db.table('rule_config').getOrThrow(id);
      if (patch.source_ref !== undefined && !patch.source_ref.trim()) throw badRequest('A source reference is mandatory');
      const row = await ctx.db.table('rule_config').update(id, { ...patch, updated_by: ctx.user.id });
      cache.clear();
      await audit(ctx, { action: 'rule.update', table: 'rule_config', record_id: id, old: before as unknown as Json, new: row as unknown as Json });
      await fireRuleChanged(ctx, row, 'updated');
      return row;
    },

    async setActive(id, active, opts = {}) {
      const before = await ctx.db.table('rule_config').getOrThrow(id);
      const patch: Partial<RuleConfig> = { is_active: active, updated_by: ctx.user.id };
      if (opts.enforceHardStop !== undefined) patch.enforce_hard_stop = opts.enforceHardStop;
      if (opts.maxSeverity !== undefined) patch.max_severity = opts.maxSeverity;
      // an unverified rule may only block when a compliance officer explicitly enforces it as a hard stop
      if (opts.enforceHardStop && !opts.maxSeverity) patch.max_severity = 'hard_stop';
      const row = await ctx.db.table('rule_config').update(id, patch);
      cache.clear();
      await audit(ctx, { action: active ? 'rule.activate' : 'rule.deactivate', table: 'rule_config', record_id: id, old: before as unknown as Json, new: row as unknown as Json });
      await fireRuleChanged(ctx, row, active ? 'activated' : 'deactivated');
      return row;
    },
  };
  return svc;
}
