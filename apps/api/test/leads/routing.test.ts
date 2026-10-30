import { describe, expect, it } from 'vitest';
import { DEMO_ORG_ID, seedId, type Lead } from '@solar/shared';
import { bandFit, normaliseWeights, pincodeProximity, registrationCovers } from '../../src/services/routing';
import { acceptanceDueAt } from '../../src/services/leadServiceSettings';
import { API, IDS, leadEnv, person, type LeadEnv } from './helpers';

const setDist = (env: LeadEnv, id: string, patch: Record<string, unknown>) => env.db.table('distributors').update(id, patch);
const NAMES = ['Kavita Joshi', 'Rohit Mehra', 'Sanjay Gupta', 'Neha Trivedi', 'Vikram Rao', 'Pooja Iyer', 'Deepak Nair', 'Farhan Qureshi', 'Lata Bhatt', 'Omkar Desai', 'Tara Menon', 'Yash Kothari', 'Zoya Ansari', 'Girish Pandya', 'Hema Vyas', 'Ishaan Bose', 'Jaya Kulkarni', 'Manoj Thakkar', 'Nikita Sethi', 'Umesh Dave'];
let n = 0;
const mobile = () => `9${String(100000000 + ++n * 7).padStart(9, '0')}`;
async function route(env: LeadEnv, over: Record<string, unknown> = {}) {
  const r = await env.capture(person({ email: undefined, name: NAMES[n % NAMES.length], mobile: mobile(), ...over }));
  expect(r.status).toBe(201);
  const lead = await env.lead(r.body.data.lead_id);
  const assignments = await env.db.table('lead_assignments').all({ lead_id: lead.id });
  return { lead, assignments, id: lead.id };
}

describe('routing — territory, capacity band, capability, vendor registration, ranking', () => {
  it('pincode → territory → the eligible distributor with the best score; the decision is explained', async () => {
    const env = leadEnv();
    await setDist(env, IDS.distributorA, { score: 60 });
    await setDist(env, IDS.distributorB, { score: 90 });
    const { lead, assignments } = await route(env);
    expect(lead).toMatchObject({ status: 'assigned', distributor_id: IDS.distributorB, territory_id: IDS.territoryAhmedabad, owner_id: IDS.distributorUserB });
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({ step: 'auto', status: 'pending', distributor_id: IDS.distributorB, assigned_to: IDS.distributorUserB });
    const snap = assignments[0]!.score_snapshot as { chosen: string; weights: Record<string, number>; candidates: { distributor_id: string; total: number; eligible: boolean }[]; rule: string };
    expect(snap.chosen).toBe(IDS.distributorB);
    expect(snap.rule).toBe('routing.score_weights');
    expect(snap.weights).toEqual({ score: 0.4, load: 0.15, band_fit: 0.15, proximity: 0.3 });
    expect(snap.candidates.map((c) => c.distributor_id)).toEqual([IDS.distributorB, IDS.distributorA]);
    expect(snap.candidates[0]!.total).toBeGreaterThan(snap.candidates[1]!.total);
  });

  it('only distributors that serve the territory are eligible', async () => {
    const env = leadEnv();
    await setDist(env, IDS.distributorA, { territory_ids: [IDS.territoryAhmedabad], score: 99 });
    await setDist(env, IDS.distributorB, { territory_ids: [IDS.territorySurat], score: 10 });
    const surat = await route(env, { pincode: '395003', mobile: mobile() });
    expect(surat.lead).toMatchObject({ distributor_id: IDS.distributorB, territory_id: IDS.territorySurat, city: 'Surat' });
    const ahm = await route(env, { mobile: mobile() });
    expect(ahm.lead.distributor_id).toBe(IDS.distributorA);
  });

  it('capacity band: kW must lie inside capacity_band_min..max', async () => {
    const env = leadEnv();
    await setDist(env, IDS.distributorA, { capacity_band_min_kw: 1, capacity_band_max_kw: 10, score: 70 });
    await setDist(env, IDS.distributorB, { capacity_band_min_kw: 50, capacity_band_max_kw: 5000, score: 70 });
    expect((await route(env, { capacity_kw: 5, mobile: mobile() })).lead.distributor_id).toBe(IDS.distributorA);
    expect((await route(env, { capacity_kw: 200, mobile: mobile() })).lead.distributor_id).toBe(IDS.distributorB);
    const none = await route(env, { capacity_kw: 20, mobile: mobile() });
    expect(none.lead.status).toBe('unassigned');
    const reasons = (none.assignments[0]!.score_snapshot as { candidates: { reasons: string[] }[] }).candidates.flatMap((c) => c.reasons).join(' ');
    expect(reasons).toMatch(/outside the 1–10 kW band/);
    expect(reasons).toMatch(/outside the 50–5000 kW band/);
  });

  it('capability tags must include every product of interest', async () => {
    const env = leadEnv();
    expect((await route(env, { product_interest: ['battery'], mobile: mobile() })).lead.status).toBe('unassigned');
    await setDist(env, IDS.distributorB, { capability_tags: ['module', 'inverter', 'battery'] });
    expect((await route(env, { product_interest: ['Battery', 'module'], mobile: mobile() })).lead.distributor_id).toBe(IDS.distributorB);
  });

  it('inactive distributors never receive leads', async () => {
    const env = leadEnv();
    await setDist(env, IDS.distributorA, { status: 'on_hold', score: 100 });
    expect((await route(env)).lead.distributor_id).toBe(IDS.distributorB);
  });

  it('vendor registration level and districts apply only when a registration exists', async () => {
    const env = leadEnv();
    const ts = env.now().toISOString();
    const reg = (id: number, party: string, over: Record<string, unknown>) => env.db.table('vendor_registrations').insert({
      id: seedId('vreg', id), org_id: DEMO_ORG_ID, created_at: ts, updated_at: ts, created_by: null, party_type: 'distributor', party_id: party, level: 'state', portal_vendor_id: null,
      states: ['Gujarat'], districts: ['Surat'], bank_guarantee_amount: 0, bank_guarantee_valid_till: null, portal_status: 'active', deactivated_from: null, deactivated_to: null, complaint_count: 0, notes: null, ...over,
    });
    await setDist(env, IDS.distributorA, { score: 95 });
    await reg(1, IDS.distributorA, {}); // registered for Surat only
    const ahm = await route(env, { mobile: mobile() });
    expect(ahm.lead.distributor_id).toBe(IDS.distributorB); // A is not registered for Ahmedabad
    expect(JSON.stringify(ahm.assignments[0]!.score_snapshot)).toMatch(/does not cover/);
    const surat = await route(env, { pincode: '395003', mobile: mobile() });
    expect(surat.lead.distributor_id).toBe(IDS.distributorA); // covers Surat and has the better score
    await reg(2, IDS.distributorA, { level: 'national', districts: [] });
    expect((await route(env, { mobile: mobile() })).lead.distributor_id).toBe(IDS.distributorA);
    for (const r of await env.db.table('vendor_registrations').all()) await env.db.table('vendor_registrations').update(r.id, { portal_status: 'deactivated' });
    expect((await route(env, { mobile: mobile() })).lead.distributor_id).toBe(IDS.distributorB);
  });

  it('spare capacity matters: a distributor with many open leads loses to an idle one at equal score', async () => {
    const env = leadEnv();
    const c = env.ctx();
    for (let i = 0; i < 20; i++) await c.db.table('leads').insert({ name: `Busy ${i}`, mobile: `+9190000${String(i).padStart(5, '0')}`, status: 'accepted', source: 'manual', distributor_id: IDS.distributorA } as Partial<Lead>);
    const { lead, assignments } = await route(env);
    expect(lead.distributor_id).toBe(IDS.distributorB);
    const cands = (assignments[0]!.score_snapshot as { candidates: { distributor_id: string; open_leads: number; load: number }[] }).candidates;
    expect(cands.find((x) => x.distributor_id === IDS.distributorA)).toMatchObject({ open_leads: 20, load: 0 });
  });

  it('weights come from rule routing.score_weights', async () => {
    const env = leadEnv();
    await setDist(env, IDS.distributorA, { score: 95, capacity_band_min_kw: 1, capacity_band_max_kw: 5000, address: { pincode: '380001' } });
    await setDist(env, IDS.distributorB, { score: 60, capacity_band_min_kw: 3, capacity_band_max_kw: 9, address: { pincode: '380001' } }); // sits right on a 5 kW lead
    expect((await route(env, { mobile: mobile() })).lead.distributor_id).toBe(IDS.distributorA); // default: score dominates
    await env.rule('routing.score_weights', { score: 0, load: 0, band_fit: 1, proximity: 0 });
    const r = await route(env, { mobile: mobile() });
    expect(r.lead.distributor_id).toBe(IDS.distributorB);
    expect((r.assignments[0]!.score_snapshot as { weights: Record<string, number> }).weights).toEqual({ score: 0, load: 0, band_fit: 1, proximity: 0 });
  });

  it('nobody eligible → unassigned, escalated to the DSM with a notification and no acceptance clock', async () => {
    const env = leadEnv();
    await setDist(env, IDS.distributorA, { status: 'inactive' });
    await setDist(env, IDS.distributorB, { status: 'inactive' });
    const { lead, assignments, id } = await route(env);
    expect(lead).toMatchObject({ status: 'unassigned', distributor_id: null, owner_id: IDS.profile('dsm'), sla_due_at: null });
    expect(lead.next_action).toMatch(/Assign a distributor/);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({ step: 'escalation', distributor_id: null, assigned_to: IDS.profile('dsm') });
    const note = (await env.db.table('notifications').all({ kind: 'lead.unassigned' }))[0]!;
    expect(note).toMatchObject({ user_id: IDS.profile('dsm'), entity_id: id, severity: 'warning' });
    expect(await env.db.table('clocks').count({ entity_id: id, clock_type: 'lead_acceptance', status: 'running' })).toBe(0);
    expect(env.providers.calls.email.some((m) => m.to === 'dsm@test.local')).toBe(true);
    // the DSM can then choose a distributor by hand (an inactive one is refused)
    await setDist(env, IDS.distributorB, { status: 'active' });
    const bad = await env.u('dsm').post(`${API}/leads/${id}/reassign`).send({ distributor_id: IDS.distributorA, reason: 'Try A' });
    expect(bad.status).toBe(422);
    const ok = await env.u('dsm').post(`${API}/leads/${id}/reassign`).send({ distributor_id: IDS.distributorB, reason: 'B can take it' });
    expect(ok.body.data).toMatchObject({ status: 'assigned', distributor_id: IDS.distributorB });
  });

  it('an unknown pincode (not in a territory) is escalated with the territory reason', async () => {
    const env = leadEnv();
    const { lead, assignments } = await route(env, { pincode: '390001' }); // provider knows Vadodara, no territory covers it
    expect(lead).toMatchObject({ status: 'unassigned', city: 'Vadodara', territory_id: null });
    expect(JSON.stringify(assignments[0]!.score_snapshot)).toMatch(/does not fall in any territory/);
  });

  it('a dealer upload stays with the dealer’s distributor and the dealer’s user', async () => {
    const env = leadEnv();
    await setDist(env, IDS.distributorA, { score: 1 });
    await setDist(env, IDS.distributorB, { score: 100 });
    const key = await env.key('dealer_upload');
    const r = await env.capture(person({ dealer_id: IDS.dealerA1 }), key);
    const lead = await env.lead(r.body.data.lead_id);
    expect(lead.distributor_id).toBe(IDS.distributorA);
    expect((await env.db.table('lead_assignments').all({ lead_id: lead.id }))[0]!.score_snapshot).toMatchObject({ mode: 'dealer_upload' });
  });

  it('pure helpers', () => {
    expect(bandFit(null, 1, 100)).toBe(0.5);
    expect(bandFit(10, 1, 100)).toBeCloseTo(1);
    expect(bandFit(1, 1, 100)).toBe(0);
    expect(bandFit(100, 1, 100)).toBe(0);
    expect(normaliseWeights({ score: 3, load: 1, band_fit: 0, proximity: 0 })).toEqual({ score: 0.75, load: 0.25, band_fit: 0, proximity: 0 });
    expect(normaliseWeights({ score: -1 })).toEqual({ score: 0.4, load: 0.15, band_fit: 0.15, proximity: 0.3 });
    expect(pincodeProximity('380015', '380009').value).toBeGreaterThan(pincodeProximity('380015', '395003').value);
    expect(pincodeProximity('380015', '380009').hint).toBe('same postal region');
    expect(pincodeProximity(null, '380009').value).toBe(0.5);
    expect(registrationCovers([], { state: 'Gujarat', district: 'Surat' }).ok).toBe(true);
  });
});

describe('acceptance SLA is set from the temperature, in working time', () => {
  it('warm 120 working minutes by default (the rule can change it); the clock and the lead carry the due time', async () => {
    const env = leadEnv();
    const { lead, id } = await route(env);
    expect(lead.sla_due_at).toBe(new Date(env.now().getTime() + 120 * 60_000).toISOString());
    const clock = (await env.db.table('clocks').all({ entity_id: id, clock_type: 'lead_acceptance' }))[0]!;
    expect(clock).toMatchObject({ status: 'running', owner_id: IDS.profile('distributor_user'), due_at: lead.sla_due_at });
    await env.rule('sla.lead_acceptance_minutes.warm', 90);
    const second = await route(env, { mobile: mobile() });
    expect(second.lead.sla_due_at).toBe(new Date(env.now().getTime() + 90 * 60_000).toISOString());
  });

  it('hot = sla.lead_acceptance_minutes.hot (30), cold = end of the working day, and nights/Sundays do not count', async () => {
    const env = leadEnv();
    const ctx = env.ctx();
    const from = new Date('2026-10-26T05:00:00Z'); // Mon 10:30 IST
    expect((await acceptanceDueAt(ctx, 'hot', from)).toISOString()).toBe('2026-10-26T05:30:00.000Z');
    expect((await acceptanceDueAt(ctx, 'cold', from)).toISOString()).toBe('2026-10-26T13:00:00.000Z'); // 18:30 IST
    const fri = new Date('2026-10-30T12:30:00Z'); // Fri 18:00 IST: 30 min left that day
    expect((await acceptanceDueAt(ctx, 'warm', fri)).toISOString()).toBe('2026-10-31T05:30:00.000Z'); // Sat 11:00 IST
    await env.rule('work_calendar.hours', { days: [1, 2, 3, 4, 5], start: '09:30', end: '18:30' });
    await env.rule('work_calendar.holidays', ['2026-10-26']);
    const ctx2 = env.ctx();
    expect((await acceptanceDueAt(ctx2, 'hot', from)).toISOString()).toBe('2026-10-27T04:30:00.000Z'); // holiday Monday → Tue 09:30 + 30 min = 10:00 IST
  });
});

describe('pincode closeness', () => {
  it('between two equally good distributors, the one whose home pincode is nearest the lead wins', async () => {
    const env = leadEnv();
    const lead = await route(env, { pincode: '380001', mobile: mobile() });
    const pin = (await env.db.table('leads').get(lead.id))!.pincode;
    await setDist(env, IDS.distributorA, { score: 70, address: { pincode: '395003' } });
    await setDist(env, IDS.distributorB, { score: 70, address: { pincode: pin } });
    const r = await route(env, { pincode: '380001', mobile: mobile() });
    expect(r.lead.distributor_id).toBe(IDS.distributorB);
    const cands = (r.assignments[0]!.score_snapshot as { candidates: { distributor_id: string; proximity: number; distance_hint: string }[] }).candidates;
    expect(cands.find((c) => c.distributor_id === IDS.distributorB)).toMatchObject({ distance_hint: 'same postal region' });
    expect(cands.find((c) => c.distributor_id === IDS.distributorB)!.proximity).toBeGreaterThan(cands.find((c) => c.distributor_id === IDS.distributorA)!.proximity);
  });
});

describe('segment follows the customer type', () => {
  it('a captured lead gets its segment from the customer type, so the requirement form is never blocked', async () => {
    const env = leadEnv();
    expect((await route(env, { segment: undefined, customer_type: 'residential', mobile: mobile() })).lead.segment).toBe('pmsg_residential');
    expect((await route(env, { segment: undefined, customer_type: 'housing_society', mobile: mobile() })).lead.segment).toBe('rwa_ghs');
    expect((await route(env, { segment: undefined, customer_type: 'industrial', mobile: mobile() })).lead.segment).toBe('ci_captive');
  });
});

describe('recording consent by hand (the quotation says "No consent has been recorded")', () => {
  it('a lead captured without consent gets a consent row from staff, and the summary shows it', async () => {
    const env = leadEnv();
    const { id } = await route(env, { consent: undefined, mobile: mobile() });
    const before = await env.u('dsm').get(`${API}/leads/${id}/consents`);
    expect(before.body.data.summary.has_active).toBe(false);
    const res = await env.u('dsm').post(`${API}/leads/${id}/consents`).send({ notice_version: 'default-v1', purposes: ['service', 'quotation', 'promotional'], channels: ['call', 'sms', 'whatsapp'], capture_source: 'staff_entry', proof_ref: 'On a phone call — agreed at 4 pm' });
    expect(res.status).toBe(201);
    const after = await env.u('dsm').get(`${API}/leads/${id}/consents`);
    expect(after.body.data.summary).toMatchObject({ has_active: true });
  });
});
