import { describe, expect, it } from 'vitest';
import { tickClocks } from '../../src/services/clockService';
import { API, IDS, jpegWithGps, newEnv, noExifJpeg, seedProject, seedRules } from './fixtures';

const DAY = 86400000;

describe('installation → certificate → DISCOM commissioning clock', () => {
  it('creates an installation only from a dispatched sales order', async () => {
    const env = newEnv();
    const p = await seedProject(env, { soStatus: 'approved' });
    const blocked = await env.as('dealer_user').post(`${API}/installations`).send({ sales_order_id: p.soId });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('GUARD_BLOCKED');
    await env.ctx().db.table('sales_orders').update(p.soId, { status: 'dispatched' });
    const ok = await env.as('dealer_user').post(`${API}/installations`).send({ sales_order_id: p.soId, install_date: '2026-10-20' });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ status: 'installed', kw: 3, dealer_id: IDS.dealerA1, agreement_status: 'pending', installer_name: 'Sunrise Installers' });
    const dup = await env.as('dealer_user').post(`${API}/installations`).send({ sales_order_id: p.soId });
    expect(dup.status).toBe(409);
  });

  it('a dealer cannot record an installation for another dealer’s order', async () => {
    const env = newEnv();
    const p = await seedProject(env, { dealerId: IDS.dealerB1, distributorId: IDS.distributorB });
    const r = await env.as('dealer_user').post(`${API}/installations`).send({ sales_order_id: p.soId });
    expect(r.status).toBe(403);
  });

  it('certificate starts the 15-day DISCOM clock; a breach sets deemed_breach, logs evidence and notifies the DSM', async () => {
    const env = newEnv();
    await seedRules(env);
    const p = await seedProject(env);
    const inst = (await env.as('dealer_user').post(`${API}/installations`).send({ sales_order_id: p.soId, install_date: '2026-10-20' })).body.data;

    const cert = await env.as('dealer_user').post(`${API}/installations/${inst.id}/certificate`).send({});
    expect(cert.status).toBe(200);
    expect(cert.body.data.installation.status).toBe('certified');
    const app = cert.body.data.discom_application;
    expect(app).toMatchObject({ installation_id: inst.id, applied_kw: 3, feasibility_status: 'not_required', deemed_breach: false, agreement_status: 'pending', discom_id: expect.any(String) });
    expect(app.commissioning_due_at).toBe('2026-11-10T18:29:59.999Z'); // 26-Oct + 15 days, end of the IST day
    const clocks = await env.db.table('clocks').all({ entity_id: app.id });
    expect(clocks).toHaveLength(1);
    expect(clocks[0]).toMatchObject({ clock_type: 'discom_commissioning', status: 'running', entity_type: 'discom_application', due_at: app.commissioning_due_at });

    env.setNow(new Date('2026-11-11T05:00:00Z'));
    const tick = await tickClocks(env.deps);
    expect(tick.breached).toBe(1);
    const after = await env.db.table('discom_applications').get(app.id);
    expect(after?.deemed_breach).toBe(true);
    expect((await env.db.table('clocks').get(clocks[0]!.id))?.status).toBe('breached');
    const dsm = (await env.db.table('notifications').all({ kind: 'discom.deemed_breach' }));
    expect(dsm.map((n) => n.user_id)).toContain(IDS.profile('dsm'));
    const evidence = (await env.db.table('audit_log').all({ action: 'discom.deemed_breach' }))[0]!;
    expect(evidence.detail).toMatchObject({ evidence: { application_id: app.id, certificate_submitted_at: expect.any(String), days_overdue: 1 } });

    // late commissioning keeps the breach and finishes the job
    const done = await env.as('dsm').post(`${API}/installations/${inst.id}/commission`).send({});
    expect(done.status).toBe(200);
    expect(done.body.data.discom_application.deemed_breach).toBe(true);
    expect(done.body.data.serials_installed).toBe(2);
    expect(done.body.data.installation).toMatchObject({ status: 'commissioned', om_end: '2031-11-11', warranty_end: '2036-11-11' });
    const serials = await env.db.table('inventory_serials').all({ sales_order_id: p.soId });
    expect(serials.every((s) => s.status === 'installed' && s.installed_at)).toBe(true);
  });

  it('the commissioning length comes from the rule: change it and the due date moves; inactive ⇒ warning and no clock', async () => {
    const env = newEnv();
    await seedRules(env);
    await env.rule('discom.commissioning_days', 20, { status: 'unverified', effective_from: '2026-01-01' });
    const p = await seedProject(env);
    const inst = (await env.as('admin').post(`${API}/installations`).send({ sales_order_id: p.soId, install_date: '2026-10-20' })).body.data;
    const cert = await env.as('admin').post(`${API}/installations/${inst.id}/certificate`).send({ certificate_at: '2026-10-26' });
    expect(cert.body.data.discom_application.commissioning_due_at).toBe('2026-11-15T18:29:59.999Z'); // +20 days

    const env2 = newEnv();
    await seedRules(env2);
    const rules = await env2.db.table('rule_config').all({ key: 'commissioning_days' });
    await env2.db.table('rule_config').update(rules[0]!.id, { is_active: false });
    const p2 = await seedProject(env2);
    const i2 = (await env2.as('admin').post(`${API}/installations`).send({ sales_order_id: p2.soId, install_date: '2026-10-20' })).body.data;
    const c2 = await env2.as('admin').post(`${API}/installations/${i2.id}/certificate`).send({});
    expect(c2.body.data.warnings.join(' ')).toMatch(/discom\.commissioning_days is not active/);
    expect(c2.body.data.discom_application.commissioning_due_at).toBeNull();
    expect(await env2.db.table('clocks').count({ clock_type: 'discom_commissioning' })).toBe(0);
  });

  it('guards: no certificate without an install date, none dated before installation, no commissioning without a certificate', async () => {
    const env = newEnv();
    await seedRules(env);
    const p = await seedProject(env);
    const inst = (await env.as('admin').post(`${API}/installations`).send({ sales_order_id: p.soId })).body.data;
    expect((await env.as('admin').post(`${API}/installations/${inst.id}/certificate`).send({})).status).toBe(422);
    await env.as('admin').patch(`${API}/installations/${inst.id}`).send({ install_date: '2026-10-20' });
    expect((await env.as('admin').post(`${API}/installations/${inst.id}/certificate`).send({ certificate_at: '2026-10-10' })).status).toBe(422);
    expect((await env.as('admin').post(`${API}/installations/${inst.id}/commission`).send({})).status).toBe(422);
    // PATCH with certificate_at is equivalent to the dedicated endpoint
    const patched = await env.as('admin').patch(`${API}/installations/${inst.id}`).send({ certificate_at: '2026-10-25' });
    expect(patched.body.data.status).toBe('certified');
    expect(await env.db.table('clocks').count({ clock_type: 'discom_commissioning', status: 'running' })).toBe(1);
  });

  it('records the GERC regulation version from the commissioning date and the Gujarat no-connectivity-agreement default only when its rule is active', async () => {
    const env = newEnv();
    await seedRules(env);
    await env.rule('gerc.regulation_versions', [{ from: '2016-01-01', label: 'GERC 2016' }, { from: '2025-11-04', label: 'GERC 2016 (5th Amendment)' }]);
    await env.rule('gujarat.pmsg_no_connectivity_agreement', true, { status: 'unverified', is_active: false, effective_from: '2025-11-04' });
    const p = await seedProject(env);
    const created = await env.as('admin').post(`${API}/installations`).send({ sales_order_id: p.soId, install_date: '2026-10-20' });
    expect(created.body.data.no_connectivity_agreement).toBe(false);
    expect(created.body.data.warnings.join(' ')).toMatch(/gujarat\.pmsg_no_connectivity_agreement is not active/);

    const rule = (await env.db.table('rule_config').all({ key: 'pmsg_no_connectivity_agreement' }))[0]!;
    await env.db.table('rule_config').update(rule.id, { is_active: true });
    const p2 = await seedProject(env, { n: 2 });
    const second = await env.as('admin').post(`${API}/installations`).send({ sales_order_id: p2.soId, install_date: '2026-10-20' });
    expect(second.body.data.no_connectivity_agreement).toBe(true);
    await env.as('admin').post(`${API}/installations/${second.body.data.id}/certificate`).send({});
    const done = await env.as('admin').post(`${API}/installations/${second.body.data.id}/commission`).send({ commissioned_at: '2026-11-02' });
    expect(done.body.data.installation.regulation_version).toBe('GERC 2016 (5th Amendment)');
    expect(done.body.data.discom_application).toMatchObject({ regulation_version: 'GERC 2016 (5th Amendment)', agreement_status: 'not_required' });
  });
});

describe('geo-tagged installation photos', () => {
  it('stores photos in the site-photos bucket and reads EXIF geo; flags photos without geo', async () => {
    const env = newEnv();
    const p = await seedProject(env);
    const inst = (await env.as('dealer_user').post(`${API}/installations`).send({ sales_order_id: p.soId, install_date: '2026-10-20' })).body.data;
    const res = await env.as('dealer_user').post(`${API}/installations/${inst.id}/photos`)
      .attach('photos', jpegWithGps(23.0225, 72.5714), { filename: 'roof.jpg', contentType: 'image/jpeg' })
      .attach('photos', noExifJpeg(), { filename: 'meter.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(201);
    const [geo, plain] = res.body.data.uploaded;
    expect(geo.lat).toBeCloseTo(23.0225, 3); expect(geo.lng).toBeCloseTo(72.5714, 3);
    expect(plain.lat).toBeNull();
    expect(res.body.data.warnings.join(' ')).toMatch(/1 photo\(s\) carry no geo-tag/);
    expect(res.body.data.installation.photos).toHaveLength(2);
    expect([...env.providers.files.keys()].every((k) => k.startsWith('site-photos/'))).toBe(true);
    expect(await env.db.table('documents').count({ entity_type: 'installation', entity_id: inst.id, bucket: 'site-photos' })).toBe(2);

    // device GPS sent with the upload fills the gap
    const withMeta = await env.as('dealer_user').post(`${API}/installations/${inst.id}/photos`).field('lat', '21.17').field('lng', '72.83').attach('photos', noExifJpeg(), { filename: 'inverter.jpg', contentType: 'image/jpeg' });
    expect(withMeta.body.data.uploaded[0]).toMatchObject({ lat: 21.17, lng: 72.83 });
    const read = await env.as('dealer_user').get(`${API}/installations/${inst.id}`);
    expect(read.body.data.geo_tagged_photos).toBe(2);
  });

  it('rejects non-image uploads and Aadhaar-like file names', async () => {
    const env = newEnv();
    const p = await seedProject(env);
    const inst = (await env.as('admin').post(`${API}/installations`).send({ sales_order_id: p.soId })).body.data;
    const pdf = await env.as('admin').post(`${API}/installations/${inst.id}/photos`).attach('photos', Buffer.from('%PDF-1.4'), { filename: 'cert.pdf', contentType: 'application/pdf' });
    expect(pdf.status).toBe(400);
    const aadhaar = await env.as('admin').post(`${API}/installations/${inst.id}/photos`).attach('photos', noExifJpeg(), { filename: 'aadhaar_front.jpg', contentType: 'image/jpeg' });
    expect(aadhaar.status).toBe(422);
    expect(aadhaar.body.error.code).toBe('AADHAAR_BLOCKED');
  });
});

describe('5-year O&M register', () => {
  it('lists commissioned installations with days left and flags expiring / expired / not started', async () => {
    const env = newEnv();
    await seedRules(env);
    const mk = async (n: number, commissioned: string | null) => {
      const p = await seedProject(env, { n });
      const row = await env.ctx().db.table('installations').insert({
        sales_order_id: p.soId, customer_id: p.customerId, site_id: p.siteId, dealer_id: IDS.dealerA1, distributor_id: IDS.distributorA, status: commissioned ? 'commissioned' : 'installed', photos: [],
        agreement_status: 'pending', no_connectivity_agreement: false, kw: 3, commissioned_at: commissioned ? `${commissioned}T05:00:00.000Z` : null, regulation_version: null, certificate_at: null,
        install_date: '2026-01-01', warranty_end: null, om_end: commissioned ? `${Number(commissioned.slice(0, 4)) + 5}${commissioned.slice(4)}` : null, vendor_registration_id: null, installer_name: 'X',
      });
      return row.id;
    };
    await mk(1, '2026-01-15');            // om_end 2031-01-15 → active
    await mk(2, '2021-12-01');            // om_end 2026-12-01 → 36 days → expiring (<= 90)
    await mk(3, '2021-06-01');            // om_end 2026-06-01 → expired
    await mk(4, null);                    // not started
    const all = await env.as('dsm').get(`${API}/installations/om-register`);
    expect(all.status).toBe(200);
    expect(all.body.summary).toMatchObject({ active: 1, expiring: 1, expired: 1, not_started: 1, expiring_window_days: 90 });
    expect(all.body.data.map((r: { state: string }) => r.state)).toEqual(['expired', 'expiring', 'active', 'not_started']);
    expect(all.body.data[1].days_left).toBe(36);
    const expiring = await env.as('dsm').get(`${API}/installations/om-register?state=expiring`);
    expect(expiring.body.data).toHaveLength(1);
    const within = await env.as('dsm').get(`${API}/installations/om-register?within_days=60`);
    expect(within.body.data).toHaveLength(1);
    // a dealer only sees its own installations
    expect((await env.as('dealer_user').get(`${API}/installations/om-register`)).body.total).toBe(4);
    expect((await env.as(IDS.dealerUserB).get(`${API}/installations/om-register`)).body.total).toBe(0);
  });
});

describe('time moves with the test clock', () => {
  it('uses ctx.now(), not the wall clock', async () => {
    const env = newEnv();
    await seedRules(env);
    env.setNow(new Date(env.now().getTime() + 40 * DAY));
    const p = await seedProject(env);
    const inst = (await env.as('admin').post(`${API}/installations`).send({ sales_order_id: p.soId, install_date: '2026-12-01' })).body.data;
    const cert = await env.as('admin').post(`${API}/installations/${inst.id}/certificate`).send({});
    expect(cert.body.data.discom_application.commissioning_due_at).toBe('2026-12-20T18:29:59.999Z'); // 5-Dec + 15
  });
});
