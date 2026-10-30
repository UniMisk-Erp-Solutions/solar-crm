import type { Express, Router } from 'express';
import request from 'supertest';
import { DEMO_ORG_ID, seedId, type AppRole, type Json, type Profile, type RuleConfig, type RuleConfidence, type RuleStatus, type Severity } from '@solar/shared';
import type { SeedData } from '@solar/shared/seed';
import { createApp } from '../../src/app';
import { demoToken } from '../../src/auth/authenticate';
import type { AppContext } from '../../src/auth/context';
import { loadConfig } from '../../src/config';
import { MemoryDb } from '../../src/db/memory';
import { buildContext, systemUser, type AppDeps } from '../../src/deps';
import type { ServiceOverrides } from '../../src/services';
import { createLogger } from '../../src/lib/logger';
import { fakeProviders, type FakeProviders } from './fakeProviders';

/** Monday 26-Oct-2026, 10:30 IST — a normal working morning. */
export const T0 = new Date('2026-10-26T05:00:00.000Z');

export const IDS = {
  org: DEMO_ORG_ID,
  profile: (role: AppRole) => seedId('test-profile', ['admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'distributor_user', 'dealer_user', 'techno_commercial', 'accounts', 'compliance_officer', 'dispatch', 'viewer'].indexOf(role) + 1),
  /** a second distributor user to prove cross-distributor isolation */
  distributorUserB: seedId('test-profile', 50),
  dealerUserB: seedId('test-profile', 51),
  distributorA: seedId('test-distributor', 1),
  distributorB: seedId('test-distributor', 2),
  dealerA1: seedId('test-dealer', 1),
  dealerA2: seedId('test-dealer', 2),
  dealerB1: seedId('test-dealer', 3),
  territoryAhmedabad: seedId('test-territory', 1),
  territorySurat: seedId('test-territory', 2),
};

const iso = T0.toISOString();
const base = { org_id: DEMO_ORG_ID, created_at: iso, updated_at: iso, created_by: null };

function profile(role: AppRole, overrides: Partial<Profile> = {}): Profile {
  return { id: IDS.profile(role), org_id: DEMO_ORG_ID, full_name: `Test ${role}`, email: `${role}@test.local`, phone: null, role, designation: null, distributor_id: null, dealer_id: null, territory_ids: [], reports_to: null, language: 'en', active: true, created_at: iso, updated_at: iso, created_by: null, ...overrides };
}

/** Minimal tenant: one org, a user per role, 2 distributors, 3 dealers, 2 territories. Add anything else with env.db / env.insert. */
export function baseSeed(): SeedData {
  const roles: AppRole[] = ['admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'distributor_user', 'dealer_user', 'techno_commercial', 'accounts', 'compliance_officer', 'dispatch', 'viewer'];
  const profiles = roles.map((r) =>
    profile(r, r === 'distributor_user' ? { distributor_id: IDS.distributorA } : r === 'dealer_user' ? { distributor_id: IDS.distributorA, dealer_id: IDS.dealerA1 } : {}),
  );
  profiles.push(profile('distributor_user', { id: IDS.distributorUserB, full_name: 'Test distributor B', email: 'distb@test.local', distributor_id: IDS.distributorB }));
  profiles.push(profile('dealer_user', { id: IDS.dealerUserB, full_name: 'Test dealer B', email: 'dealb@test.local', distributor_id: IDS.distributorB, dealer_id: IDS.dealerB1 }));
  const dist = (id: string, name: string) => ({ ...base, id, legal_name: name, trade_name: name, gstin: null, pan: null, contact_name: null, phone: null, email: null, address: null, state: 'Gujarat', city: 'Ahmedabad', territory_ids: [IDS.territoryAhmedabad, IDS.territorySurat], capacity_band_min_kw: 1, capacity_band_max_kw: 5000, capability_tags: ['module', 'inverter', 'structure'], score: 80, status: 'active' as const, credit_days: 30, credit_limit: 5_000_000, rebate_slab_key: null });
  const dealer = (id: string, distributor_id: string, name: string, limit = 1_000_000) => ({ ...base, id, distributor_id, legal_name: name, trade_name: name, gstin: null, pan: null, contact_name: null, phone: null, email: null, territory_id: IDS.territoryAhmedabad, city: 'Ahmedabad', district: 'Ahmedabad', state: 'Gujarat', credit_limit: limit, security_type: 'pdc' as const, security_amount: 0, status: 'active' as const, portal_status: 'active' as const, complaint_count: 0, rebate_accrued: 0 });
  return {
    organizations: [{ id: DEMO_ORG_ID, name: 'Future Solar', legal_name: 'Future Solar Pvt. Ltd.', gstin: '24AAAAA0000A1Z5', pan: null, address: null, state: 'Gujarat', settings: {}, created_at: iso, updated_at: iso }],
    profiles,
    distributors: [dist(IDS.distributorA, 'Alpha Solar Distributors'), dist(IDS.distributorB, 'Beta Energy Distributors')],
    dealers: [dealer(IDS.dealerA1, IDS.distributorA, 'Sunrise Installers'), dealer(IDS.dealerA2, IDS.distributorA, 'Bright Roofs'), dealer(IDS.dealerB1, IDS.distributorB, 'Gamma Solar Dealers')],
    territories: [
      { ...base, id: IDS.territoryAhmedabad, name: 'Ahmedabad', state: 'Gujarat', district: 'Ahmedabad', pincode_ranges: [{ from: '380001', to: '382999' }], discom_id: null, dsm_id: IDS.profile('dsm'), active: true },
      { ...base, id: IDS.territorySurat, name: 'Surat', state: 'Gujarat', district: 'Surat', pincode_ranges: [{ from: '394101', to: '395999' }], discom_id: null, dsm_id: IDS.profile('dsm'), active: true },
    ],
  };
}

export interface TestEnv {
  app: Express; deps: AppDeps; db: MemoryDb; providers: FakeProviders; now(): Date; setNow(d: Date): void; advance(ms: number): void;
  token(role: AppRole | string): string;
  /** supertest agent already authenticated as the given role (or explicit profile id) */
  as(role: AppRole | string): { get(url: string): request.Test; post(url: string): request.Test; patch(url: string): request.Test; put(url: string): request.Test; delete(url: string): request.Test };
  anon(): ReturnType<typeof request>;
  ctx(role?: AppRole | string): AppContext;
  systemCtx(): AppContext;
  /** insert a rule_config row (verified + active by default) */
  rule(path: string, value: Json, opts?: Partial<Pick<RuleConfig, 'status' | 'is_active' | 'confidence' | 'max_severity' | 'enforce_hard_stop' | 'effective_from' | 'effective_to'>>): Promise<RuleConfig>;
}

export interface TestEnvOptions {
  seed?: SeedData; now?: Date; authed?: Router[]; public?: Router[]; serviceOverrides?: ServiceOverrides;
  /** merge extra tables on top of baseSeed() */
  extraSeed?: SeedData;
}

export function createTestEnv(opts: TestEnvOptions = {}): TestEnv {
  let t = opts.now ?? T0;
  const nowFn = () => t;
  const seed: SeedData = opts.seed ?? { ...baseSeed(), ...(opts.extraSeed ?? {}) };
  const db = new MemoryDb(seed, { now: nowFn });
  const providers = fakeProviders();
  const config = loadConfig({}, { NODE_ENV: 'test', DEMO_MODE: true, RUN_JOBS: false, LOG_LEVEL: 'silent' });
  const deps: AppDeps = { config, db, providers, log: createLogger('silent'), now: nowFn, serviceOverrides: opts.serviceOverrides };
  const app = createApp(deps, { authed: opts.authed ?? [], public: opts.public ?? [] });
  const idOf = (who: string) => (/^[0-9a-f-]{36}$/.test(who) ? who : IDS.profile(who as AppRole));
  const token = (who: string) => demoToken(idOf(who), nowFn().getTime());
  const as = (who: string) => {
    const agent = request(app);
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token(who)}`);
    return { get: (u: string) => auth(agent.get(u)), post: (u: string) => auth(agent.post(u)), patch: (u: string) => auth(agent.patch(u)), put: (u: string) => auth(agent.put(u)), delete: (u: string) => auth(agent.delete(u)) };
  };
  const ctx = (who: string = 'admin') => {
    const p = db.table('profiles');
    // synchronous access through the in-memory store
    const row = (db.store('profiles').get(idOf(who)) as unknown as Profile) ?? profile('admin');
    void p;
    return buildContext(deps, DEMO_ORG_ID, row, { requestId: 'test', now: nowFn });
  };
  return {
    app, deps, db, providers, now: nowFn, setNow: (d) => { t = d; }, advance: (ms) => { t = new Date(t.getTime() + ms); },
    token, as, anon: () => request(app), ctx, systemCtx: () => buildContext(deps, DEMO_ORG_ID, systemUser(DEMO_ORG_ID), { system: true, now: nowFn }),
    rule: (path, value, o = {}) => {
      const i = path.indexOf('.');
      return db.table('rule_config').insert({
        ...base, id: undefined as unknown as string, category: path.slice(0, i), key: path.slice(i + 1), value, effective_from: o.effective_from ?? '2020-01-01', effective_to: o.effective_to ?? null,
        source_name: 'test', source_ref: 'test', confidence: (o.confidence ?? 'high') as RuleConfidence, status: (o.status ?? 'verified') as RuleStatus, is_active: o.is_active ?? true,
        max_severity: (o.max_severity ?? 'hard_stop') as Severity, enforce_hard_stop: o.enforce_hard_stop ?? false, notes: null, updated_by: null,
      });
    },
  };
}
