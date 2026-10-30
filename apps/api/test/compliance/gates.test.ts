/** Gates G1–G14: pass / fail / warn paths, and the rule-inactive path (an unverified, conflicting or inactive rule must degrade a hard stop to a warning). */
import { describe, expect, it } from 'vitest';
import { FAKE_AADHAAR, IDS, addSku, denied, evaluate, gate, makeWorld, quoteWith, real } from '../quotes/helpers';

describe('G1 — consent / DND / suppression', () => {
  it('passes with consent', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w)]);
    expect(real(await evaluate(w, q.id), 'G1')).toHaveLength(0);
  });
  it('hard stop when no consent covers quotation / service, or suppression is active', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w)]);
    w.stubs.consent = () => denied('NO_CONSENT', 'No consent record covers service messages.');
    const r = await evaluate(w, q.id);
    expect(real(r, 'G1')[0]).toMatchObject({ severity: 'hard_stop', advisory: false });
    expect(r.hasHardStop).toBe(true);
    w.stubs.consent = () => denied('SUPPRESSED_90_DAY', 'Opt-out suppression until 31-Jan.');
    expect(real(await evaluate(w, q.id), 'G1')[0]!.severity).toBe('hard_stop');
  });
  it('a stale DND scrub alone is only a warning', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w)]);
    w.stubs.consent = (ch) => (ch === 'email' ? { allowed: true, consent_id: 'c', reasons: [{ code: 'DND_STALE', message: 'DND scrub is older than 30 days' }] } : denied('DND_STALE', 'DND scrub is older than 30 days'));
    expect(real(await evaluate(w, q.id), 'G1')[0]).toMatchObject({ severity: 'warning' });
  });
  it('degrades to a warning when the governing rule is inactive', async () => {
    const w = await makeWorld({ rules: false });
    await w.env.rule('trai.optout_reconsent_block_days', 90, { is_active: false, status: 'unverified' });
    const q = await quoteWith(w, [await addSku(w)]);
    w.stubs.consent = () => denied('NO_CONSENT', 'No consent.');
    const f = real(await evaluate(w, q.id), 'G1')[0]!;
    expect(f.severity).toBe('warning');
    expect(f.advisory).toBe(true);
  });
});

describe('G2 — DCR on subsidy quotes', () => {
  it('hard stop for a non-DCR module on a PMSG quote, with the rule id recorded', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w, { compliance: { dcr_verified: false } })]);
    const r = await evaluate(w, q.id);
    const f = real(r, 'G2')[0]!;
    expect(f.severity).toBe('hard_stop');
    expect(f.ruleIds).toHaveLength(1);
    expect(f.ruleStatus).toBe('verified');
    expect(r.ruleIdsUsed).toContain(f.ruleIds[0]);
    expect(r.status).toBe('blocked');
  });
  it('passes for DCR-verified and for thin-film modules', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w), await addSku(w, { compliance: { dcr_verified: false, thin_film: true } })]);
    expect(real(await evaluate(w, q.id), 'G2')).toHaveLength(0);
  });
  it('applies to PM-KUSUM and not to net-metered C&I', async () => {
    const k = await makeWorld({ segment: 'pm_kusum' });
    const kq = await quoteWith(k, [await addSku(k, { compliance: { dcr_verified: false } })]);
    expect(real(await evaluate(k, kq.id), 'G2')[0]!.severity).toBe('hard_stop');
    const n = await makeWorld({ segment: 'ci_net_metered', kw: 100 });
    const nq = await quoteWith(n, [await addSku(n, { compliance: { dcr_verified: false } })]);
    const r = await evaluate(n, nq.id);
    expect(real(r, 'G2')).toHaveLength(0);
    expect(gate(r, 'G2')[0]!.severity).toBe('info');
  });
  it('rule inactive → warning (advisory), never a hard stop', async () => {
    const w = await makeWorld({ rules: false });
    await w.env.rule('pmsg.dcr_required_for_cfa', true, { is_active: false, status: 'unverified' });
    const q = await quoteWith(w, [await addSku(w, { compliance: { dcr_verified: false } })]);
    const f = real(await evaluate(w, q.id), 'G2')[0]!;
    expect(f).toMatchObject({ severity: 'warning', advisory: true, ruleStatus: 'unverified' });
  });
});

describe('G3 — ALMM List-I', () => {
  it('hard stop when the model is not on List-I, or the listing expires before commissioning', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w, { compliance: { almm_list1: false } })]);
    expect(real(await evaluate(w, q.id), 'G3')[0]!.severity).toBe('hard_stop');
    const e = await makeWorld();
    const eq = await quoteWith(e, [await addSku(e, { compliance: { almm_list1_valid_till: '2026-11-15' } })]);
    expect(real(await evaluate(e, eq.id), 'G3')[0]!.message).toMatch(/valid only till/);
  });
  it('passes for a listed model', async () => {
    const w = await makeWorld();
    expect(real(await evaluate(w, (await quoteWith(w, [await addSku(w)])).id), 'G3')).toHaveLength(0);
  });
  it('is warning-only for captive behind-the-meter jobs (applicability matrix)', async () => {
    const w = await makeWorld({ segment: 'ci_captive', kw: 200 });
    const r = await evaluate(w, (await quoteWith(w, [await addSku(w, { compliance: { almm_list1: false } })])).id);
    expect(real(r, 'G3')[0]).toMatchObject({ severity: 'warning' });
    expect(real(r, 'G3')[0]!.message).toMatch(/Warning only/);
  });
  it('rule inactive → warning', async () => {
    const w = await makeWorld({ rules: false });
    await w.env.rule('almm.list1.enforcement_date', '2024-04-01', { is_active: false, status: 'unverified' });
    const f = real(await evaluate(w, (await quoteWith(w, [await addSku(w, { compliance: { almm_list1: false } })])).id), 'G3')[0]!;
    expect(f).toMatchObject({ severity: 'warning', advisory: true });
  });
});

describe('G4 — ALMM List-II', () => {
  it('hard stop on a subsidy job commissioned on/after the List-II date with non-List-II cells', async () => {
    const w = await makeWorld();
    const r = await evaluate(w, (await quoteWith(w, [await addSku(w, { compliance: { almm_list2: false } })])).id);
    expect(real(r, 'G4')[0]).toMatchObject({ severity: 'hard_stop' });
  });
  it('passes before the List-II date and for List-II cells', async () => {
    const early = await makeWorld({ commissioning: '2026-05-01' });
    expect(real(await evaluate(early, (await quoteWith(early, [await addSku(early, { compliance: { almm_list2: false } })])).id), 'G4')).toHaveLength(0);
    const ok = await makeWorld();
    expect(real(await evaluate(ok, (await quoteWith(ok, [await addSku(ok)])).id), 'G4')).toHaveLength(0);
  });
  it('net-metered jobs are handled by G5, not G4', async () => {
    const w = await makeWorld({ segment: 'ci_net_metered', kw: 100 });
    const r = await evaluate(w, (await quoteWith(w, [await addSku(w, { compliance: { almm_list2: false } })])).id);
    expect(real(r, 'G4')).toHaveLength(0);
  });
  it('rule inactive → warning', async () => {
    const w = await makeWorld({ rules: false });
    await w.env.rule('almm.list2.effective_date', '2026-06-01', { is_active: false, status: 'unverified' });
    const f = real(await evaluate(w, (await quoteWith(w, [await addSku(w, { compliance: { almm_list2: false } })])).id), 'G4')[0]!;
    expect(f).toMatchObject({ severity: 'warning', advisory: true });
  });
});

describe('G5 — List-II exemption date', () => {
  const net = { segment: 'ci_net_metered' as const, kw: 100, exemption: true };
  it('hard stop when relying on the exemption and commissioning is after the exemption date', async () => {
    const w = await makeWorld({ ...net, commissioning: '2027-01-15' });
    const r = await evaluate(w, (await quoteWith(w, [await addSku(w, { compliance: { almm_list2: false } })])).id);
    expect(real(r, 'G5')[0]).toMatchObject({ severity: 'hard_stop' });
    expect(r.hasHardStop).toBe(true);
  });
  it('only informs when commissioning is inside the exemption window', async () => {
    const w = await makeWorld({ ...net, commissioning: '2026-12-15' });
    const r = await evaluate(w, (await quoteWith(w, [await addSku(w, { compliance: { almm_list2: false } })])).id);
    expect(real(r, 'G5')).toHaveLength(0);
    expect(gate(r, 'G5')[0]!.message).toMatch(/relies on the ALMM List-II exemption/);
  });
  it('passes when the job does not rely on the exemption', async () => {
    const w = await makeWorld({ segment: 'ci_net_metered', kw: 100, commissioning: '2027-01-15' });
    expect(real(await evaluate(w, (await quoteWith(w, [await addSku(w)])).id), 'G5')).toHaveLength(0);
  });
  it('rule inactive → warning', async () => {
    const w = await makeWorld({ ...net, commissioning: '2027-01-15', rules: false });
    await w.env.rule('almm.list2.exemption_net_metering_open_access_until', '2026-12-31', { is_active: false, status: 'unverified' });
    expect(real(await evaluate(w, (await quoteWith(w, [await addSku(w)])).id), 'G5')[0]).toMatchObject({ severity: 'warning', advisory: true });
  });
});

describe('G6 — BIS licence', () => {
  it('hard stop for a missing licence, an expired licence, and a licensed-model mismatch', async () => {
    for (const compliance of [{ bis_licence_no: null }, { bis_valid_till: '2026-09-01' }, { bis_licensed_model: 'SOME-OTHER-MODEL' }]) {
      const w = await makeWorld();
      const f = real(await evaluate(w, (await quoteWith(w, [await addSku(w, { compliance })])).id), 'G6')[0]!;
      expect(f.severity).toBe('hard_stop');
    }
  });
  it('a licence that expires before the commissioning date also stops', async () => {
    const w = await makeWorld();
    const f = real(await evaluate(w, (await quoteWith(w, [await addSku(w, { compliance: { bis_valid_till: '2026-11-15' } })])).id), 'G6')[0]!;
    expect(f.message).toMatch(/before the commissioning date/);
  });
  it('passes with a valid licence for the quoted model', async () => {
    const w = await makeWorld();
    expect(real(await evaluate(w, (await quoteWith(w, [await addSku(w)])).id), 'G6')).toHaveLength(0);
  });
  it('degrades to a warning while the BIS standard rule is conflicting (IS 14286 vs IS 14086)', async () => {
    const w = await makeWorld({ rules: false });
    await w.env.rule('bis.module_standard_no', { status: 'conflicting', candidates: ['IS 14286', 'IS 14086'] }, { status: 'conflicting', is_active: false, confidence: 'low' });
    const f = real(await evaluate(w, (await quoteWith(w, [await addSku(w, { compliance: { bis_licence_no: null } })])).id), 'G6')[0]!;
    expect(f).toMatchObject({ severity: 'warning', advisory: true, ruleStatus: 'conflicting' });
  });
});

describe('G7 — inverter self-certification', () => {
  const inverter = (w: Awaited<ReturnType<typeof makeWorld>>, c: object = {}) => addSku(w, { category: 'inverter', compliance: { inverter_kw: 250, self_certified: true, almm_list1: false, almm_list2: false, dcr_verified: false, bis_licence_no: null, ...c } });
  it('warning before the end date, hard stop after it', async () => {
    const before = await makeWorld({ segment: 'ci_net_metered', kw: 250, commissioning: '2026-11-30' });
    const rb = await evaluate(before, (await quoteWith(before, [await inverter(before)])).id);
    expect(real(rb, 'G7')[0]!.severity).toBe('warning');
    const after = await makeWorld({ segment: 'ci_net_metered', kw: 250, commissioning: '2027-02-01' });
    const ra = await evaluate(after, (await quoteWith(after, [await inverter(after)])).id);
    expect(real(ra, 'G7')[0]!.severity).toBe('hard_stop');
  });
  it('passes for inverters at or below the threshold, and for licensed inverters', async () => {
    const w = await makeWorld({ segment: 'ci_net_metered', kw: 50 });
    const small = await inverter(w, { inverter_kw: 100 });
    const licensed = await addSku(w, { category: 'inverter', compliance: { inverter_kw: 250, self_certified: false } });
    expect(real(await evaluate(w, (await quoteWith(w, [small, licensed])).id), 'G7')).toHaveLength(0);
  });
  it('rule inactive → stays a warning even after the end date', async () => {
    const w = await makeWorld({ segment: 'ci_net_metered', kw: 250, commissioning: '2027-02-01', rules: false });
    await w.env.rule('bis.inverter_self_cert_above_kw', 200, { is_active: false, status: 'unverified' });
    await w.env.rule('bis.inverter_self_cert_until', '2026-12-31', { is_active: false, status: 'unverified' });
    expect(real(await evaluate(w, (await quoteWith(w, [await inverter(w)])).id), 'G7')[0]).toMatchObject({ severity: 'warning', advisory: true });
  });
});

describe('G8 — validity vs price / duty horizon', () => {
  it('warns when the validity runs past the price-snapshot age limit; passes inside it', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w)]);
    expect(real(await evaluate(w, q.id), 'G8')).toHaveLength(0); // default validity is capped
    const { patchQuote } = await import('../../src/services/quoteService');
    await patchQuote(w.c(), q.id, { validity_date: '2026-12-10' });
    const f = real(await evaluate(w, q.id), 'G8')[0]!;
    expect(f).toMatchObject({ severity: 'warning' });
    expect(f.message).toMatch(/price snapshot age limit/);
  });
  it('warns when it runs past a line price valid_to', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w, { price: { valid_to: '2026-10-30' } })]);
    expect((await w.c().db.table('quotations').getOrThrow(q.id)).validity_date).toBe('2026-10-30'); // default validity is capped
    const { patchQuote } = await import('../../src/services/quoteService');
    await patchQuote(w.c(), q.id, { validity_date: '2026-11-05' });
    expect(real(await evaluate(w, q.id), 'G8')[0]!.message).toMatch(/price validity/);
  });
  it('warns when it runs past the exemption date for an exemption-reliant job', async () => {
    const w = await makeWorld({ segment: 'ci_net_metered', kw: 100, exemption: true, commissioning: '2026-12-20' });
    w.env.setNow(new Date('2026-12-26T05:00:00Z'));
    const q = await quoteWith(w, [await addSku(w)]);
    expect((await w.c().db.table('quotations').getOrThrow(q.id)).validity_date).toBe('2026-12-31'); // capped at the exemption date
    const { patchQuote } = await import('../../src/services/quoteService');
    await patchQuote(w.c(), q.id, { validity_date: '2027-01-02' });
    expect(real(await evaluate(w, q.id), 'G8')[0]!.message).toMatch(/List-II exemption end date/);
  });
});

describe('G9 — HSN, GST rate and tax position', () => {
  it('warns for a missing HSN', async () => {
    const w = await makeWorld();
    expect(real(await evaluate(w, (await quoteWith(w, [await addSku(w, { hsn: null })])).id), 'G9')[0]).toMatchObject({ severity: 'warning' });
  });
  it('a module line gets the GST rate from the rule at the quote date; an inactive rule gives null + a warning, never a silent rate', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w)]);
    const line = (await w.c().db.table('quotation_lines').all({ quote_id: q.id }))[0]!;
    expect(line).toMatchObject({ gst_rate: 5, gst_as_of: '2026-10-26' });
    expect(real(await evaluate(w, q.id), 'G9')).toHaveLength(0);

    const off = await makeWorld({ rules: false });
    await off.env.rule('gst.modules_cells_rate', 5, { is_active: false, status: 'unverified' });
    const oq = await quoteWith(off, [await addSku(off)]);
    const oline = (await off.c().db.table('quotation_lines').all({ quote_id: oq.id }))[0]!;
    expect(oline.gst_rate).toBeNull();
    const f = real(await evaluate(off, oq.id), 'G9')[0]!;
    expect(f).toMatchObject({ severity: 'warning', advisory: true });
    expect((await off.c().db.table('quotations').getOrThrow(oq.id)).tax_total).toBe(0);
  });
  it('picks the GST rate in force on the quote date (12% before 22-Sep-2025, 5% after)', async () => {
    const w = await makeWorld({ rules: false });
    await w.env.rule('gst.modules_cells_rate', 12, { effective_to: '2025-09-21' });
    await w.env.rule('gst.modules_cells_rate', 5, { effective_from: '2025-09-22' });
    const line = (await w.c().db.table('quotation_lines').all({ quote_id: (await quoteWith(w, [await addSku(w)])).id }))[0]!;
    expect(line.gst_rate).toBe(5);
  });
  it('HARD STOP for inverter lines while gst.inverter_rate is conflicting and the tax position is not approved; a CA decision clears it', async () => {
    const w = await makeWorld({ segment: 'ci_net_metered', kw: 20 });
    await w.env.rule('gst.inverter_rate', { status: 'conflicting', candidates: [5, 18] }, { status: 'conflicting', is_active: false, confidence: 'low', max_severity: 'info' });
    const inv = await addSku(w, { category: 'inverter', compliance: { inverter_kw: 20, self_certified: false } });
    const q = await quoteWith(w, [inv]);
    const r = await evaluate(w, q.id);
    expect(real(r, 'G9').find((f) => f.severity === 'hard_stop')).toBeTruthy();
    expect(r.hasHardStop).toBe(true);
    // a CA-type user records the tax position
    const { setTaxPosition } = await import('../../src/services/quoteService');
    const line = (await w.c().db.table('quotation_lines').all({ quote_id: q.id }))[0]!;
    await setTaxPosition(w.c('accounts'), q.id, { lines: [{ line_id: line.id, approved: true, gst_rate: 18 }] });
    const after = await evaluate(w, q.id);
    expect(real(after, 'G9')).toHaveLength(0);
    const saved = await w.c().db.table('quotations').getOrThrow(q.id);
    expect(saved.tax_position_approved).toBe(true);
    expect(saved.tax_total).toBeCloseTo(3600, 2);
    // the CA decision survives a re-save of the same lines
    const { replaceLines } = await import('../../src/services/quoteService');
    await replaceLines(w.c(), q.id, { lines: [{ sku_id: inv.id, qty: 1, discount_pct: 0 }] });
    expect(real(await evaluate(w, q.id), 'G9')).toHaveLength(0);
  });
  it('an inverter on a verified rate with an unapproved tax position is only a warning', async () => {
    const w = await makeWorld({ segment: 'ci_net_metered', kw: 20 });
    await w.env.rule('gst.inverter_rate', 18);
    const q = await quoteWith(w, [await addSku(w, { category: 'inverter', compliance: { inverter_kw: 20 } })]);
    const f = real(await evaluate(w, q.id), 'G9');
    expect(f.every((x) => x.severity === 'warning')).toBe(true);
    expect(f.length).toBeGreaterThan(0);
  });
});

describe('G10 — ALMM snapshot freshness', () => {
  it('warns when the snapshot is older than the limit (default 7 days) or missing; passes when fresh', async () => {
    const w = await makeWorld();
    expect(real(await evaluate(w, (await quoteWith(w, [await addSku(w)])).id), 'G10')).toHaveLength(0);
    const stale = await makeWorld();
    const f = real(await evaluate(stale, (await quoteWith(stale, [await addSku(stale, { compliance: { almm_snapshot_date: '2026-10-10' } })])).id), 'G10')[0]!;
    expect(f).toMatchObject({ severity: 'warning' });
    expect(f.message).toMatch(/16 days old/);
    const none = await makeWorld();
    expect(real(await evaluate(none, (await quoteWith(none, [await addSku(none, { compliance: { almm_snapshot_date: null } })])).id), 'G10')[0]!.message).toMatch(/no ALMM snapshot date/);
  });
  it('uses the default of 7 days when the rule row is absent, and stays advisory when the rule is inactive', async () => {
    const w = await makeWorld({ rules: false });
    expect(real(await evaluate(w, (await quoteWith(w, [await addSku(w, { compliance: { almm_snapshot_date: '2026-10-10' } })])).id), 'G10')).toHaveLength(1);
    const off = await makeWorld({ rules: false });
    await off.env.rule('compliance.almm_snapshot_max_age_days', 30, { is_active: false, status: 'unverified' });
    const f = real(await evaluate(off, (await quoteWith(off, [await addSku(off, { compliance: { almm_snapshot_date: '2026-10-10' } })])).id), 'G10')[0]!;
    expect(f).toMatchObject({ severity: 'warning', advisory: true });
  });
});

describe('G11 — dealer credit and portal status (warning on a quote)', () => {
  it('passes for a dealer inside the limit', async () => {
    const w = await makeWorld();
    expect(real(await evaluate(w, (await quoteWith(w, [await addSku(w)])).id), 'G11')).toHaveLength(0);
  });
  it('warns when the dealer is over the credit limit', async () => {
    const w = await makeWorld();
    await w.c().db.table('dealer_receivables').insert({ dealer_id: IDS.dealerA1, distributor_id: IDS.distributorA, doc_ref: 'INV-1', amount: 1_500_000, paid_amount: 0, invoice_date: '2026-09-01', due_date: '2026-10-01', subsidy_linked: false, status: 'open' });
    const r = await evaluate(w, (await quoteWith(w, [await addSku(w)])).id);
    expect(real(r, 'G11')[0]).toMatchObject({ severity: 'warning' });
    expect(r.hasHardStop).toBe(false);
  });
  it('warns when the dealer is deactivated on the portal', async () => {
    const w = await makeWorld();
    await w.c().db.table('dealers').update(IDS.dealerA1, { portal_status: 'deactivated' });
    const f = real(await evaluate(w, (await quoteWith(w, [await addSku(w)])).id), 'G11')[0]!;
    expect(f.severity).toBe('warning');
    expect(f.message).toMatch(/deactivated/);
  });
});

describe('G12 — name on bill / pending dues', () => {
  it('passes when the names match', async () => {
    const w = await makeWorld();
    expect(real(await evaluate(w, (await quoteWith(w, [await addSku(w)])).id), 'G12')).toHaveLength(0);
  });
  it('warns on a name mismatch and on pending dues', async () => {
    const m = await makeWorld({ siteOver: { name_match: false, name_on_bill: 'Ramesh Patel' } });
    expect(real(await evaluate(m, (await quoteWith(m, [await addSku(m)])).id), 'G12')[0]).toMatchObject({ severity: 'warning' });
    const d = await makeWorld({ siteOver: { pending_dues: true } });
    expect(real(await evaluate(d, (await quoteWith(d, [await addSku(d)])).id), 'G12')[0]!.message).toMatch(/pending DISCOM dues/);
  });
});

describe('G13 — PMSG above the CFA kW limit', () => {
  it('warns above 3 kW, passes at 3 kW, does not apply to RWA', async () => {
    const big = await makeWorld({ kw: 4 });
    expect(real(await evaluate(big, (await quoteWith(big, [await addSku(big)])).id), 'G13')[0]).toMatchObject({ severity: 'warning' });
    const ok = await makeWorld({ kw: 3 });
    expect(real(await evaluate(ok, (await quoteWith(ok, [await addSku(ok)])).id), 'G13')).toHaveLength(0);
    const rwa = await makeWorld({ segment: 'rwa_ghs', kw: 100 });
    const r = await evaluate(rwa, (await quoteWith(rwa, [await addSku(rwa)])).id);
    expect(real(r, 'G13')).toHaveLength(0);
    expect(gate(r, 'G13')[0]!.severity).toBe('info');
  });
  it('rule inactive → still a warning, flagged advisory', async () => {
    const w = await makeWorld({ kw: 4, rules: false });
    await w.env.rule('pmsg.cfa.max_kw_eligible', 3, { is_active: false, status: 'unverified' });
    expect(real(await evaluate(w, (await quoteWith(w, [await addSku(w)])).id), 'G13')[0]).toMatchObject({ severity: 'warning', advisory: true });
  });
});

describe('G14 — Aadhaar', () => {
  it('hard stop for an Aadhaar number in free text on the quote and for an Aadhaar-named document', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w)]);
    expect(real(await evaluate(w, q.id), 'G14')).toHaveLength(0);
    // the edge guard blocks such JSON bodies, so write straight to the row to prove the engine's own check
    await w.c().db.table('quotations').update(q.id, { payment_terms: `Advance on order. Customer ID ${FAKE_AADHAAR}` });
    const r = await evaluate(w, q.id);
    expect(real(r, 'G14')[0]).toMatchObject({ severity: 'hard_stop' });
    expect(real(r, 'G14')[0]!.message).not.toContain(FAKE_AADHAAR);
    await w.c().db.table('quotations').update(q.id, { payment_terms: 'Advance on order' });
    await w.c().db.table('documents').insert({ entity_type: 'quotation', entity_id: q.id, bucket: 'quote-pdfs', path: 'x/aadhaar_front.jpg', doc_type: 'upload', file_name: 'aadhaar_front.jpg', mime: 'image/jpeg', size_bytes: 10, uploaded_by: null });
    expect(real(await evaluate(w, q.id), 'G14')[0]!.message).toMatch(/Aadhaar document/);
  });
  it('rule inactive → warning', async () => {
    const w = await makeWorld({ rules: false });
    await w.env.rule('compliance.aadhaar_block', true, { is_active: false, status: 'unverified' });
    const q = await quoteWith(w, [await addSku(w)]);
    await w.c().db.table('quotations').update(q.id, { payment_terms: `ID ${FAKE_AADHAAR}` });
    expect(real(await evaluate(w, q.id), 'G14')[0]).toMatchObject({ severity: 'warning', advisory: true });
  });
  it('the API edge refuses a body with an Aadhaar number', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w)]);
    const res = await w.env.as('dsm').patch(`/api/v1/quotes/${q.id}`).send({ payment_terms: `ID ${FAKE_AADHAAR}` });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('AADHAAR_BLOCKED');
  });
});
