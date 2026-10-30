import { describe, expect, it } from 'vitest';
import * as E from '../src/enums';
import { TABLE_NAMES, type TableName } from '../src/enums';
import { detectAadhaar, looksLikeAadhaarFilename, scanForAadhaar } from '../src/aadhaar';
import { daysBetween, istDateString, normalizeMobile } from '../src/format';
import { DEMO_ORG_ID } from '../src/ids';
import type { Quotation } from '../src/rows';
import { DEMO_IDS, DEFERRED_COLUMNS, INSERT_ORDER, buildDemoSeed, buildReferenceSeed, buildRuleConfigRows, buildSeed, VERIFY_ITEMS } from '../src/seed';
import { insertOrderIsComplete, REFERENCE_TABLES } from '../src/seed/order';
import { DEMO_QUOTE_SCENARIOS } from '../src/seed/demo.quotes';
import { rules_core } from '../src/seed/rules.core';
import { rules_regulatory } from '../src/seed/rules.regulatory';
import { ruleFragments } from '../src/seed/rules.build';
import { FK, FK_ARRAYS, POLYMORPHIC, USER_COLUMNS, type EnumMap } from './helpers/seedFk';

const NOW = new Date('2026-10-26T06:30:00Z');
const seed = buildSeed(NOW);
const ref = buildReferenceSeed(NOW, false);
const demo = buildDemoSeed(NOW);
type Row = Record<string, unknown>;
const rows = (t: TableName, s = seed): Row[] => (s[t] ?? []) as unknown as Row[];
const ids = (t: TableName): Set<string> => new Set(rows(t).map((r) => String(r['id'])));
const today = istDateString(NOW);

describe('determinism and shape', () => {
  it('is deterministic for a given anchor and moves with it', () => {
    expect(JSON.stringify(buildSeed(NOW))).toBe(JSON.stringify(buildSeed(new Date(NOW.getTime()))));
    const later = buildSeed(new Date('2026-12-01T06:30:00Z'));
    expect(JSON.stringify(later.leads)).not.toBe(JSON.stringify(seed.leads));
    // ids never depend on the anchor
    expect((later.leads ?? []).map((l) => l.id)).toEqual((seed.leads ?? []).map((l) => l.id));
  });
  it('splits cleanly into reference and demo, which together are the whole seed', () => {
    for (const t of TABLE_NAMES) {
      expect(rows(t).length).toBe(rows(t, ref).length + rows(t, demo).length);
      // distributors belong to both: the three fictional demo ones, and the real 50-distributor network (SQL seed only)
      if (t === 'distributors') { expect(rows(t, demo)).toHaveLength(3); continue; }
      // the catalogue likewise has the 14 fictional demo products and the real 100-product starter catalogue (SQL seed only)
      if (t === 'skus' || t === 'sku_compliance' || t === 'sku_prices') { expect(rows(t, demo).length).toBeGreaterThan(0); continue; }
      if (REFERENCE_TABLES.includes(t)) expect(rows(t, demo)).toHaveLength(0);
      else expect(rows(t, ref)).toHaveLength(0);
    }
  });
  it('INSERT_ORDER lists every table exactly once', () => {
    expect(insertOrderIsComplete()).toBe(true);
  });
  it('every row has an id and the demo organisation', () => {
    for (const t of TABLE_NAMES) for (const r of rows(t)) {
      expect(typeof r['id']).toBe('string');
      if (t !== 'organizations') expect(r['org_id']).toBe(DEMO_ORG_ID);
    }
  });
  it('has no duplicate ids within a table', () => {
    for (const t of TABLE_NAMES) expect(new Set(rows(t).map((r) => r['id'])).size, t).toBe(rows(t).length);
  });
  it('all rows of a table have the same columns (needed for the SQL generator)', () => {
    for (const t of TABLE_NAMES) {
      const r = rows(t);
      if (!r.length) continue;
      const cols = Object.keys(r[0]!).sort().join(',');
      r.forEach((x, i) => expect(Object.keys(x).sort().join(','), `${t}[${i}]`).toBe(cols));
    }
  });
});

describe('foreign keys', () => {
  it('every *_id reference resolves to a row in the right table', () => {
    const bad: string[] = [];
    for (const [table, cols] of Object.entries(FK) as [TableName, Record<string, TableName>][]) {
      for (const r of rows(table)) {
        for (const [col, target] of Object.entries(cols)) {
          const v = r[col];
          if (v === null || v === undefined) continue;
          if (!ids(target).has(String(v))) bad.push(`${table}.${col} -> ${target}: ${String(v)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
  it('user-id columns point at seeded profiles', () => {
    const profiles = ids('profiles');
    const bad: string[] = [];
    for (const t of TABLE_NAMES) for (const r of rows(t)) for (const c of USER_COLUMNS) {
      const v = r[c];
      if (typeof v === 'string' && !profiles.has(v)) bad.push(`${t}.${c}: ${v}`);
    }
    expect(bad).toEqual([]);
  });
  it('array foreign keys and polymorphic references resolve', () => {
    for (const [table, cols] of Object.entries(FK_ARRAYS) as [TableName, Record<string, TableName>][]) {
      for (const r of rows(table)) for (const [col, target] of Object.entries(cols)) {
        for (const v of r[col] as string[]) expect(ids(target).has(v), `${table}.${col}`).toBe(true);
      }
    }
    for (const p of POLYMORPHIC) {
      for (const r of rows(p.table)) {
        const target = p.map[String(r[p.typeColumn])];
        const v = r[p.idColumn];
        if (v === null || v === undefined) continue;
        expect(target, `${p.table}.${p.typeColumn}=${String(r[p.typeColumn])}`).toBeDefined();
        expect(ids(target!).has(String(v)), `${p.table}.${p.idColumn} -> ${target}`).toBe(true);
      }
    }
  });
  it('org_id of every table is the organisation row', () => {
    expect(rows('organizations').map((o) => o['id'])).toEqual([DEMO_ORG_ID]);
  });
  it('INSERT_ORDER puts parents before children (except the deferred circular columns and self-references)', () => {
    const pos = new Map(INSERT_ORDER.map((t, i) => [t, i]));
    const deferred = new Set(DEFERRED_COLUMNS.map((d) => `${d.table}.${d.column}`));
    const problems: string[] = [];
    for (const [table, cols] of Object.entries(FK) as [TableName, Record<string, TableName>][]) {
      for (const [col, target] of Object.entries(cols)) {
        if (target === table || deferred.has(`${table}.${col}`)) continue;
        if (!rows(table).some((r) => r[col] !== null && r[col] !== undefined)) continue;
        if ((pos.get(target) ?? 0) > (pos.get(table) ?? 0)) problems.push(`${table}.${col} -> ${target}`);
      }
    }
    for (const p of POLYMORPHIC) for (const target of Object.values(p.map)) {
      if (p.table === 'documents' || p.table === 'clocks' || p.table === 'notifications' || p.table === 'approvals') continue; // generic, no database FK
      if ((pos.get(target) ?? 0) > (pos.get(p.table) ?? 0)) problems.push(`${p.table} -> ${target}`);
    }
    expect(problems).toEqual([]);
  });
  it('self-referencing rows list the parent first', () => {
    for (const [t, col] of [['profiles', 'reports_to'], ['quotations', 'parent_quote_id'], ['leads', 'duplicate_of']] as [TableName, string][]) {
      const seen = new Set<string>();
      for (const r of rows(t)) {
        const parent = r[col];
        if (typeof parent === 'string') expect(seen.has(parent), `${t}.${col}`).toBe(true);
        seen.add(String(r['id']));
      }
    }
  });
});

describe('enum-typed values', () => {
  const ENUMS: EnumMap = {
    profiles: { role: E.APP_ROLES },
    discoms: {},
    vendor_registrations: { level: E.VENDOR_LEVELS, portal_status: E.PORTAL_STATUSES },
    dealers: { status: E.PARTY_STATUSES, portal_status: E.PORTAL_STATUSES, security_type: E.SECURITY_TYPES },
    distributors: { status: E.PARTY_STATUSES },
    sop_cases: { stage: E.SOP_STAGES },
    leads: { source: E.LEAD_SOURCES, segment: E.SEGMENTS, customer_type: E.CUSTOMER_TYPES, status: E.LEAD_STATUSES, temperature: E.TEMPERATURES, lock_status: E.LOCK_STATUSES, dnd_status: E.DND_STATUSES, timeline_bucket: E.TIMELINE_BUCKETS },
    lead_consents: { purposes: E.CONSENT_PURPOSES, channels: E.CONSENT_CHANNELS },
    lead_assignments: { status: E.ASSIGNMENT_STATUSES },
    followups: { kind: E.FOLLOWUP_KINDS, status: E.FOLLOWUP_STATUSES },
    contact_logs: { channel: E.CONTACT_CHANNELS, outcome: E.CONTACT_OUTCOMES },
    sites: { roof_ownership: E.ROOF_OWNERSHIPS, category: E.SITE_CATEGORIES },
    site_surveys: { status: E.SURVEY_STATUSES, feasibility_status: E.FEASIBILITY_STATUSES },
    opportunities: { segment: E.SEGMENTS, scheme_route: E.SCHEME_ROUTES, stage: E.OPPORTUNITY_STAGES },
    requirement_forms: { segment: E.SEGMENTS },
    segment_form_config: { segment: E.SEGMENTS },
    skus: { category: E.SKU_CATEGORIES },
    inventory_serials: { status: E.SERIAL_STATUSES },
    quotations: { status: E.QUOTE_STATUSES, segment: E.SEGMENTS, compliance_status: E.COMPLIANCE_STATUSES },
    approval_rules: { lane: E.APPROVAL_LANES, role_chain: E.APP_ROLES },
    approvals: { entity_type: E.APPROVAL_ENTITIES, lane: E.APPROVAL_LANES, required_role: E.APP_ROLES, decision: E.APPROVAL_DECISIONS },
    proforma_invoices: { status: E.PI_STATUSES },
    payments: { kind: E.PAYMENT_KINDS, mode: E.PAYMENT_MODES },
    credit_checks: { result: E.CREDIT_RESULTS, portal_status: E.PORTAL_STATUSES },
    sales_orders: { status: E.SO_STATUSES, segment: E.SEGMENTS },
    dispatches: { status: E.DISPATCH_STATUSES, ewb_status: E.EINVOICE_STATUSES, compliance_status: E.COMPLIANCE_STATUSES },
    einvoice_status: { status: E.EINVOICE_STATUSES },
    loans: { status: E.LOAN_STATUSES, rejection_code: E.LOAN_REJECTION_CODES },
    discom_applications: { feasibility_status: E.FEASIBILITY_STATUSES, agreement_status: E.AGREEMENT_STATUSES },
    subsidy_claims: { status: E.SUBSIDY_STATUSES, cohort: E.SUBSIDY_COHORTS, rejection_reason: E.SUBSIDY_REJECTION_REASONS },
    installations: { status: E.INSTALLATION_STATUSES, agreement_status: E.AGREEMENT_STATUSES },
    warranty_tickets: { type: E.WARRANTY_TYPES, status: E.WARRANTY_STATUSES, cost_bearer: E.COST_BEARERS },
    dealer_receivables: { status: E.RECEIVABLE_STATUSES },
    rule_config: { confidence: E.RULE_CONFIDENCES, status: E.RULE_STATUSES, max_severity: E.SEVERITIES },
    clocks: { clock_type: E.CLOCK_TYPES, status: E.CLOCK_STATUSES },
    notifications: { severity: E.NOTIFICATION_SEVERITIES, target_role: E.APP_ROLES },
    message_templates: { channel: E.MESSAGE_CHANNELS, category: E.TEMPLATE_CATEGORIES, purpose: E.MESSAGE_PURPOSES },
    message_log: { channel: E.MESSAGE_CHANNELS, purpose: E.MESSAGE_PURPOSES, category: E.TEMPLATE_CATEGORIES, status: E.MESSAGE_STATUSES },
    compliance_calendar_items: { confidence: E.RULE_CONFIDENCES },
    verify_register: { confidence: E.RULE_CONFIDENCES },
    gate_applicability: { gate: E.GATES, segment: E.SEGMENTS, applicability: E.APPLICABILITIES },
    documents: { bucket: E.DOCUMENT_BUCKETS },
  };
  it('every enum-typed column holds a valid value', () => {
    const bad: string[] = [];
    for (const [table, cols] of Object.entries(ENUMS) as [TableName, Record<string, readonly string[]>][]) {
      for (const r of rows(table)) for (const [col, allowed] of Object.entries(cols)) {
        const v = r[col];
        if (v === null || v === undefined) continue;
        for (const x of Array.isArray(v) ? v : [v]) if (!allowed.includes(String(x))) bad.push(`${table}.${col}=${String(x)}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it('findings and nested enums are valid', () => {
    for (const d of rows('dispatches')) for (const f of d['compliance_findings'] as { gate: string; severity: string }[]) {
      expect(E.GATES).toContain(f.gate);
      expect(E.SEVERITIES).toContain(f.severity);
    }
    for (const f of rows('segment_form_config')) for (const field of f['fields'] as { type: string }[]) expect(['text', 'number', 'select', 'boolean', 'date', 'textarea', 'file']).toContain(field.type);
  });
  it('JSON columns hold objects, scalar arrays are real arrays (mirrors supabase/sql)', async () => {
    const { JSON_COLUMNS } = await import('../src/seed/sql');
    const bad: string[] = [];
    for (const t of TABLE_NAMES) {
      const json = new Set(JSON_COLUMNS[t] ?? []);
      for (const r of rows(t)) for (const [c, v] of Object.entries(r)) {
        if (v === null || typeof v !== 'object') continue;
        const scalarArray = Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object');
        if (scalarArray && !json.has(c)) continue;
        if (!json.has(c)) bad.push(`${t}.${c}`);
      }
    }
    expect([...new Set(bad)]).toEqual([]);
  });
});

describe('rule_config', () => {
  const rules = buildRuleConfigRows(NOW);
  const path = (r: { category: string; key: string }): string => `${r.category}.${r.key}`;
  const byPath = (p: string) => rules.filter((r) => path(r) === p);

  it('contains every canonical path of Appendix B and every path the code reads', () => {
    const required = [
      'sla.lead_acceptance_minutes.hot', 'sla.lead_acceptance_minutes.warm', 'sla.lead_acceptance.cold', 'sla.followup_days.hot', 'sla.followup_days.warm', 'sla.followup_days.cold', 'sla.quote_followup_days', 'sla.escalation_step_minutes',
      'pmsg.cfa.per_kw_first_2kw', 'pmsg.cfa.third_kw', 'pmsg.cfa.max_total', 'pmsg.cfa.max_kw_eligible', 'pmsg.cfa.special_category.per_kw_first_2kw', 'pmsg.cfa.special_category.third_kw', 'pmsg.benchmark_cost.first_2kw', 'pmsg.benchmark_cost.additional',
      'rwa_ghs.cfa_per_kw', 'rwa_ghs.max_kw', 'rwa_ghs.kw_per_household', 'pmsg.dcr_required_for_cfa', 'pmsg.vendor_bg.national', 'pmsg.vendor_bg.per_state', 'pmsg.vendor_bg.validity_years', 'pmsg.claim_deadline.legacy_cohort', 'pmsg.programme_end',
      'discom.feasibility_study_exempt_up_to_kw', 'discom.feasibility_study_days_above_10kw', 'discom.commissioning_days', 'pmsg.cfa_release_days_after_discom_approval', 'pmsg.grievance_days',
      'mnre_sop.vendor_reply_days', 'mnre_sop.reminder_days', 'mnre_sop.show_cause_days', 'mnre_sop.deactivation_months', 'mnre_sop.appeal_days',
      'almm.list2.effective_date', 'almm.list2.exemption_net_metering_open_access_until', 'almm.list2.bid_date_carveout', 'almm.list3.effective_date', 'almm.captive_behind_meter_exempt',
      'bis.inverter_self_cert_above_kw', 'bis.inverter_self_cert_until', 'bis.module_standard_no', 'gst.modules_cells_rate', 'gst.inverter_rate', 'gst.structures_rate', 'gst.batteries_rate', 'gst.works_contract_split_70_30',
      'customs.adc_on_cells_modules', 'customs.modules.bcd', 'customs.modules.aidc', 'loan.interest_rate_display', 'trai.promotional_series', 'trai.header_suffix', 'trai.optout_reconsent_block_days', 'trai.transactional_consent_days',
      'whatsapp.service_window_hours', 'whatsapp.click_to_whatsapp_free_window_days', 'dpdp.consent_manager_registration_date', 'dpdp.core_duties_date', 'dpdp.breach_report_hours', 'dpdp.audit_log_retention_days',
      'kusum.componentB_cpump_commissioning_deadline', 'kusum.componentAC_commissioning_deadline', 'gujarat.state_subsidy', 'gujarat.net_metering.surplus_rate', 'gujarat.net_metering.delay_compensation', 'gujarat.open_access.additional_surcharge_per_kwh', 'gerc.regulation_versions',
      'work_calendar.hours', 'work_calendar.holidays', 'compliance.dnd_scrub_max_age_days', 'compliance.almm_snapshot_max_age_days', 'scoring.weights', 'temperature.deadline_uplift_days',
    ];
    const have = new Set(rules.map(path));
    expect(required.filter((p) => !have.has(p))).toEqual([]);
  });
  it('never seeds channel margins, credit days or conversion rates as rules', () => {
    expect(rules.filter((r) => r.category === 'channel')).toEqual([]);
  });
  it('has no duplicate (path, effective_from) and unique ids', () => {
    expect(new Set(rules.map((r) => `${path(r)}@${r.effective_from}`)).size).toBe(rules.length);
    expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
  });
  it('keeps the seed module\'s own rows when a module fragment repeats a path', () => {
    const own = new Set([...rules_core, ...rules_regulatory].map((r) => `${r.path}@${r.effective_from ?? '2020-01-01'}`));
    for (const frag of ruleFragments().filter((f) => f.name !== 'core' && f.name !== 'regulatory')) {
      for (const r of frag.rules) {
        const k = `${r.path}@${r.effective_from ?? '2020-01-01'}`;
        if (!own.has(k)) continue;
        const kept = rules.find((x) => `${path(x)}@${x.effective_from}` === k)!;
        const mine = [...rules_core, ...rules_regulatory].find((x) => `${x.path}@${x.effective_from ?? '2020-01-01'}` === k)!;
        expect(kept.value, `${frag.name} fragment repeats ${k}`).toEqual(mine.value);
      }
    }
  });
  it('inactive and conflicting rules are exactly the ones the prompt marks', () => {
    const own = rules.filter((r) => [...rules_core, ...rules_regulatory].some((x) => x.path === path(r)));
    const inactive = [...new Set(own.filter((r) => !r.is_active).map(path))].sort();
    expect(inactive).toEqual([
      'almm.list2.bid_date_carveout', 'bis.module_standard_no', 'customs.adc_on_cells_modules', 'customs.modules.aidc', 'customs.modules.bcd', 'gst.batteries_rate', 'gst.inverter_rate', 'gst.structures_rate', 'gst.works_contract_split_70_30',
      'gujarat.net_metering.delay_compensation', 'gujarat.net_metering.surplus_rate', 'gujarat.open_access.additional_surcharge_per_kwh', 'gujarat.state_subsidy', 'loan.interest_rate_display', 'trai.header_suffix', 'trai.promotional_series',
    ].sort());
    const conflicting = [...new Set(own.filter((r) => r.status === 'conflicting').map(path))].sort();
    expect(conflicting).toEqual(['almm.list2.bid_date_carveout', 'bis.module_standard_no', 'gst.inverter_rate', 'loan.interest_rate_display', 'trai.header_suffix', 'trai.promotional_series']);
    for (const r of own.filter((x) => x.status === 'conflicting')) expect(r.is_active).toBe(false);
  });
  it('follows the status convention: verified+active are high/medium-high, medium-confidence advisory rules are unverified', () => {
    for (const r of rules_regulatory.map((x) => ({ x, row: rules.find((y) => y.id === rules.find((z) => `${z.category}.${z.key}` === x.path && z.effective_from === (x.effective_from ?? '2020-01-01'))?.id)! }))) {
      if (r.row.status === 'verified') expect(r.row.is_active, r.x.path).toBe(true);
      if (r.row.status === 'unverified' && r.row.is_active) expect(['info', 'warning'], r.x.path).toContain(r.row.max_severity);
      expect(r.row.notes ?? '', r.x.path).toMatch(/Verify against primary source before relying$/);
    }
  });
  it('marks the hard-stop gates correctly', () => {
    for (const p of ['pmsg.dcr_required_for_cfa', 'almm.list2.effective_date', 'almm.list2.exemption_net_metering_open_access_until', 'trai.optout_reconsent_block_days']) {
      const r = byPath(p)[0]!;
      expect(r.status).toBe('verified');
      expect(r.is_active).toBe(true);
      expect(r.max_severity).toBe('hard_stop');
    }
    expect(byPath('bis.inverter_self_cert_until')[0]!.max_severity).toBe('warning');
  });
  it('versions the GST module rate: 12 % until 21-Sep-2025, 5 % from 22-Sep-2025', () => {
    const v = byPath('gst.modules_cells_rate').sort((a, b) => a.effective_from.localeCompare(b.effective_from));
    expect(v.map((x) => [x.value, x.effective_from, x.effective_to])).toEqual([[12, '2020-01-01', '2025-09-21'], [5, '2025-09-22', null]]);
  });
  it('has the right values for the operating defaults', () => {
    expect(byPath('sla.escalation_step_minutes')[0]!.value).toBe(240);
    expect(byPath('work_calendar.hours')[0]!.value).toEqual({ days: [1, 2, 3, 4, 5, 6], start: '09:30', end: '18:30' });
    expect(byPath('compliance.dnd_scrub_max_age_days')[0]!.value).toBe(30);
    expect(byPath('compliance.almm_snapshot_max_age_days')[0]!.value).toBe(7);
    expect(byPath('temperature.deadline_uplift_days')[0]!.value).toBe(60);
    const w = byPath('scoring.weights')[0]!.value as Record<string, number>;
    expect(Object.values(w).reduce((s, x) => s + x, 0)).toBe(100);
    expect(byPath('rwa_ghs.kw_per_household')[0]!.value).toBe(3);
    const holidays = byPath('work_calendar.holidays')[0]!;
    expect(holidays.confidence).toBe('medium');
    expect((holidays.value as string[]).every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
  });
  it('is tolerant of empty fragments', () => {
    expect(ruleFragments().length).toBe(9);
    expect(rules.length).toBeGreaterThan(80);
  });
});

describe('reference data', () => {
  it('seeds the organisation and the five Gujarat DISCOMs', () => {
    expect(rows('organizations')[0]!['name']).toBe('Future Solar');
    const d = rows('discoms');
    expect(d.map((x) => x['code'])).toEqual(['UGVCL', 'DGVCL', 'MGVCL', 'PGVCL', 'TORRENT']);
    expect(d.filter((x) => x['kind'] === 'licensee')).toHaveLength(1);
    expect(d.every((x) => x['state'] === 'Gujarat')).toBe(true);
  });
  it('has the compliance calendar with D-14/7/3 countdowns on the first three items', () => {
    const c = rows('compliance_calendar_items');
    expect(c).toHaveLength(8);
    expect(c.slice(0, 3).map((x) => x['escalate_days'])).toEqual([[14, 7, 3], [14, 7, 3], [14, 7, 3]]);
    expect(c.map((x) => x['due_date'])).toEqual(['2026-11-13', '2026-11-30', '2026-12-31', '2026-12-31', '2026-12-31', '2027-03-31', '2027-05-13', '2028-06-01']);
  });
  it('has all 26 open verify-register items, V-1 … V-26', () => {
    const v = rows('verify_register');
    expect(v.map((x) => x['code'])).toEqual(Array.from({ length: 26 }, (_, i) => `V-${i + 1}`));
    expect(VERIFY_ITEMS).toHaveLength(26);
    for (const x of v) {
      expect(x['status']).toBe('open');
      expect(String(x['where_to_check']).length).toBeGreaterThan(5);
    }
  });
  it('covers 14 gates × 7 segments with the documented defaults', () => {
    const g = rows('gate_applicability');
    expect(g).toHaveLength(98);
    const cell = (gate: string, segment: string) => g.find((x) => x['gate'] === gate && x['segment'] === segment)!['applicability'];
    expect(E.SEGMENTS.every((s) => cell('G13', s) === (s === 'pmsg_residential' ? 'applies' : 'not_applies'))).toBe(true);
    expect(E.GATES.every((gate) => cell(gate, 'pmsg_residential') === 'applies')).toBe(true);
    expect(cell('G2', 'ci_captive')).toBe('not_applies');
    expect(cell('G3', 'ci_captive')).toBe('warning');
    expect(cell('G4', 'ci_captive')).toBe('warning');
    expect(cell('G5', 'ci_captive')).toBe('not_applies');
    expect(cell('G2', 'pm_kusum')).toBe('applies');
    for (const x of g) expect(String(x['note']).length).toBeGreaterThan(10);
  });
  it('seeds the three approval lanes with the discount bands', () => {
    const r = rows('approval_rules');
    const commercial = r.filter((x) => x['lane'] === 'commercial');
    expect(commercial.map((x) => [x['min_value'], x['max_value'], x['role_chain']])).toEqual([
      [0, 2, []], [2, 5, ['dsm']], [5, 10, ['dsm', 'regional_head']], [10, null, ['dsm', 'regional_head', 'management']],
    ]);
    expect(r.find((x) => x['lane'] === 'compliance')!['role_chain']).toEqual(['compliance_officer']);
    expect(r.find((x) => x['lane'] === 'credit')!['role_chain']).toEqual(['accounts']);
    expect(r.filter((x) => x['lane'] !== 'commercial').every((x) => x['sla_hours'] === 24)).toBe(true);
  });
  it('has a version-1 form for every segment with the core fields', () => {
    const f = rows('segment_form_config');
    expect(f.map((x) => x['segment'])).toEqual([...E.SEGMENTS]);
    for (const x of f) {
      expect(x['version']).toBe(1);
      const keys = (x['fields'] as { key: string }[]).map((y) => y.key);
      expect(keys).toContain('discom');
      expect(keys).toContain('documents');
    }
    const keysOf = (s: string) => (f.find((x) => x['segment'] === s)!['fields'] as { key: string }[]).map((y) => y.key);
    expect(keysOf('rwa_ghs')).toEqual(expect.arrayContaining(['rwa_households', 'rwa_ballot_record']));
    expect(keysOf('pm_kusum')).toEqual(expect.arrayContaining(['pump_hp', 'sanction_date']));
    expect(keysOf('ci_net_metered')).toEqual(expect.arrayContaining(['tariff_category', 'entity_type']));
    expect(keysOf('pmsg_residential')).toEqual(expect.arrayContaining(['consumer_no', 'sanctioned_load_kw', 'phase', 'bill_doc', 'name_match', 'roof_ownership', 'title_ok', 'pending_dues', 'existing_solar_kw', 'category', 'special_category_state', 'load_type']));
  });
  it('has message templates: consent v1 in three languages, DLT placeholders on SMS, clauses as e-mail service templates', () => {
    const t = rows('message_templates');
    expect(t.filter((x) => x['key'] === 'consent_notice').map((x) => x['language']).sort()).toEqual(['en', 'gu', 'hi']);
    for (const x of t.filter((y) => y['channel'] === 'sms')) {
      expect(x['dlt_template_id']).toBe('TO-BE-REGISTERED');
      expect(x['dlt_header']).toBe('FUTSLR');
    }
    for (const k of ['clause.duty_change', 'clause.gst_change', 'clause.almm_change', 'clause.price_validity', 'clause.payment_terms_default']) {
      const x = t.find((y) => y['key'] === k)!;
      expect([x['channel'], x['category'], x['purpose']]).toEqual(['email', 'service', 'service']);
    }
    for (const k of ['wa.acknowledgement', 'wa.followup_reminder', 'wa.quote_sent', 'wa.payment_reminder', 'wa.optout_confirmation']) expect(t.some((y) => y['key'] === k && y['channel'] === 'whatsapp')).toBe(true);
    expect(t.filter((x) => x['channel'] === 'whatsapp').every((x) => x['category'] === 'utility' || x['category'] === 'service')).toBe(true);
    expect(t.some((x) => String(x['key']).startsWith('internal.'))).toBe(true);
    expect(new Set(t.map((x) => `${x['key']}|${x['language']}|${x['version']}`)).size).toBe(t.length);
  });
  it('has about 40 valid, unique Gujarat pincodes', () => {
    const p = rows('pincodes');
    expect(p.length).toBeGreaterThanOrEqual(38);
    expect(new Set(p.map((x) => x['pincode'])).size).toBe(p.length);
    for (const x of p) {
      expect(String(x['pincode'])).toMatch(/^[1-9]\d{5}$/);
      expect(x['state']).toBe('Gujarat');
      expect(x['territory_id']).toBeNull();
    }
    const cities = new Set(p.map((x) => x['city']));
    for (const c of ['Ahmedabad', 'Gandhinagar', 'Surat', 'Vadodara', 'Rajkot', 'Bhavnagar', 'Jamnagar', 'Anand', 'Mehsana']) expect(cities.has(c), c).toBe(true);
  });
});

describe('demo dataset', () => {
  it('meets the headline counts', () => {
    expect(rows('leads').length).toBeGreaterThanOrEqual(20);
    expect(rows('distributors')).toHaveLength(3);
    expect(rows('dealers')).toHaveLength(8);
    expect(rows('territories')).toHaveLength(5);
    expect(rows('opportunities').length).toBeGreaterThanOrEqual(6);
    expect(rows('skus')).toHaveLength(14);
    expect(rows('inventory_serials').length).toBeGreaterThanOrEqual(60);
    expect(rows('loans').length).toBeGreaterThanOrEqual(8);
    expect(new Set(rows('leads').map((l) => l['segment']))).toEqual(new Set(E.SEGMENTS));
  });
  it('has a profile for every role plus a second DSM, distributor users and three dealer users', () => {
    const p = rows('profiles');
    expect(new Set(p.map((x) => x['role']))).toEqual(new Set(E.APP_ROLES));
    expect(p.filter((x) => x['role'] === 'dsm')).toHaveLength(2);
    expect(p.filter((x) => x['role'] === 'distributor_user')).toHaveLength(3);
    expect(p.filter((x) => x['role'] === 'dealer_user')).toHaveLength(3);
    expect(p.every((x) => String(x['email']).endsWith('@demo.futuresolar.local'))).toBe(true);
    expect(new Set(p.map((x) => x['email'])).size).toBe(p.length);
  });
  it('walks the full lead status ladder with consents in every state', () => {
    const statuses = new Set(rows('leads').map((l) => l['status']));
    for (const s of ['new', 'unassigned', 'assigned', 'accepted', 'contacted', 'qualified', 'site_visit', 'nurture', 'opportunity', 'lost', 'won']) expect(statuses.has(s), s).toBe(true);
    const leads = rows('leads');
    const consents = rows('lead_consents');
    const withConsent = new Set(consents.map((c) => c['lead_id']));
    expect(leads.some((l) => !withConsent.has(l['id']))).toBe(true); // missing consent
    const withdrawn = consents.filter((c) => c['withdrawn_at']);
    expect(withdrawn).toHaveLength(1);
    expect(daysBetween(today, String(withdrawn[0]!['optout_suppress_until']).slice(0, 10))).toBeGreaterThan(80); // 90-day bar from 5 days ago
    expect(leads.some((l) => l['dnd_status'] === 'registered')).toBe(true);
    expect(leads.some((l) => l['dnd_status'] === 'unchecked')).toBe(true);
    // one lead about to breach its acceptance SLA, with a running clock
    const hot = leads.find((l) => l['id'] === DEMO_IDS.lead.assignedAboutToBreach)!;
    const minutesLeft = (new Date(String(hot['sla_due_at'])).getTime() - NOW.getTime()) / 60000;
    expect(minutesLeft).toBeGreaterThan(0);
    expect(minutesLeft).toBeLessThan(15);
    expect(rows('clocks').some((c) => c['entity_id'] === hot['id'] && c['clock_type'] === 'lead_acceptance' && c['status'] === 'running')).toBe(true);
    // overdue follow-ups
    expect(rows('followups').filter((f) => f['status'] === 'open' && String(f['due_at']) < NOW.toISOString()).length).toBeGreaterThanOrEqual(3);
  });
  it('gives every lead a lead score that matches the Appendix A algorithm', () => {
    for (const s of rows('lead_scores')) {
      const comps = s['components'] as { points: number; weight: number }[];
      expect(Math.round(comps.reduce((a, c) => a + c.points, 0))).toBeCloseTo(Number(s['score']), 0);
      expect(comps.reduce((a, c) => a + c.weight, 0)).toBe(100);
      expect(rows('leads').find((l) => l['id'] === s['lead_id'])!['quality_score']).toBe(s['score']);
    }
  });
  it('uses obviously fictional mobiles and valid GSTIN/PAN formats', () => {
    for (const l of rows('leads')) {
      expect(String(l['mobile'])).toMatch(/^\+919000\d{6}$/);
      expect(normalizeMobile(String(l['mobile']))).not.toBeNull();
    }
    for (const t of ['distributors', 'dealers', 'customers'] as TableName[]) for (const r of rows(t)) {
      if (r['gstin']) expect(String(r['gstin'])).toMatch(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/);
      if (r['pan']) expect(String(r['pan'])).toMatch(/^[A-Z]{5}\d{4}[A-Z]$/);
    }
  });
  it('contains no Aadhaar-like numbers anywhere in the demo data', () => {
    const hits: string[] = [];
    for (const t of TABLE_NAMES) rows(t, demo).forEach((r, i) => {
      for (const p of scanForAadhaar(r, '', new Set(['mobile', 'phone', 'pincode', 'account_no', 'pan']))) hits.push(`${t}[${i}].${p}`);
      if (detectAadhaar(JSON.stringify(r).replace(/\+91\d{10}/g, '')).length) hits.push(`${t}[${i}] (raw JSON)`);
    });
    expect(hits).toEqual([]);
  });
  it('has exactly one Aadhaar-style FILE NAME (the G14 scenario) and no Aadhaar images', () => {
    const named = rows('documents').filter((d) => looksLikeAadhaarFilename(String(d['file_name'])));
    expect(named.map((d) => d['entity_id'])).toEqual([DEMO_IDS.quote.g14]);
  });
  it('marks all SKUs as demo and covers every compliance state', () => {
    expect(rows('skus').every((s) => s['demo'] === true)).toBe(true);
    const comp = rows('sku_compliance');
    const sku = (k: keyof typeof DEMO_IDS.sku) => comp.find((c) => c['sku_id'] === DEMO_IDS.sku[k])!;
    expect(sku('m1Dcr')).toMatchObject({ almm_list1: true, almm_list2: true, dcr_verified: true });
    expect(sku('m2NonDcr')).toMatchObject({ almm_list1: true, dcr_verified: false });
    expect(sku('m3NotListI')['almm_list1']).toBe(false);
    expect(String(sku('m4BisExpired')['bis_valid_till']) < today).toBe(true);
    const mismatch = rows('skus').find((s) => s['id'] === DEMO_IDS.sku.m5BisModelMismatch)!['model'];
    expect(sku('m5BisModelMismatch')['bis_licensed_model']).not.toBe(mismatch);
    expect(sku('m6NoListII')['almm_list2']).toBe(false);
    expect(sku('m7ThinFilm')['thin_film']).toBe(true);
    expect(daysBetween(String(sku('m8StaleSnapshot')['almm_snapshot_date']), today)).toBeGreaterThan(7);
    expect(sku('i2Large250')).toMatchObject({ inverter_kw: 250, self_certified: true });
    expect(rows('sku_prices')).toHaveLength(14);
  });
  it('has serials in every status, with non-List-II exposure and an RMA', () => {
    const s = rows('inventory_serials');
    expect(new Set(s.map((x) => x['status']))).toEqual(new Set(E.SERIAL_STATUSES));
    expect(s.filter((x) => x['sku_id'] === DEMO_IDS.sku.m6NoListII && x['status'] === 'in_stock').length).toBeGreaterThanOrEqual(10);
    expect(new Set(s.map((x) => String(x['serial']))).size).toBe(s.length);
  });
  it('shows the order-to-cash chain with the named exceptions', () => {
    const so = (k: keyof typeof DEMO_IDS.salesOrder) => rows('sales_orders').find((x) => x['id'] === DEMO_IDS.salesOrder[k])!;
    expect(so('so5')['status']).toBe('on_hold');
    expect(Number(so('so5')['advance_received'])).toBe(0);
    expect(rows('dispatches').some((d) => d['status'] === 'blocked' && d['compliance_status'] === 'blocked')).toBe(true);
    expect(rows('discom_applications').some((d) => d['deemed_breach'] === true && String(d['commissioning_due_at']) < NOW.toISOString() && d['commissioning_at'] === null)).toBe(true);
    const claims = rows('subsidy_claims');
    expect(claims.filter((c) => c['cohort'] === 'legacy' && c['claim_deadline'] === '2026-11-30').length).toBeGreaterThanOrEqual(3);
    expect(claims.some((c) => c['status'] === 'rejected')).toBe(true);
    expect(claims.some((c) => c['status'] === 'released')).toBe(true);
    const loans = rows('loans');
    expect(new Set(loans.map((l) => l['status']))).toEqual(new Set(['applied', 'approved', 'rejected', 'disbursed']));
    expect(new Set(loans.filter((l) => l['status'] === 'rejected').map((l) => l['rejection_code']))).toEqual(new Set(['name_mismatch', 'arrears', 'land_title', 'collateral_demanded', 'missing_documents']));
    expect(new Set(rows('approvals').map((a) => a['lane']))).toEqual(new Set(E.APPROVAL_LANES));
    for (const lane of E.APPROVAL_LANES) expect(new Set(rows('approvals').filter((a) => a['lane'] === lane).map((a) => a['decision'])).size, lane).toBeGreaterThanOrEqual(2);
    expect(new Set(rows('credit_overrides').map((c) => c['status']))).toEqual(new Set(['approved', 'pending', 'rejected']));
    expect(new Set(rows('einvoice_status').map((e) => e['status'])).size).toBeGreaterThanOrEqual(3);
  });
  it('makes the dealers match their stories', () => {
    const dealer = (k: keyof typeof DEMO_IDS.dealer) => rows('dealers').find((d) => d['id'] === DEMO_IDS.dealer[k])!;
    expect(dealer('d4')['portal_status']).toBe('under_sop');
    expect(dealer('d5')['portal_status']).toBe('deactivated');
    expect(rows('sop_cases').some((s) => s['dealer_id'] === DEMO_IDS.dealer.d4 && s['closed_at'] === null)).toBe(true);
    const bg = rows('vendor_registrations').find((v) => v['party_id'] === DEMO_IDS.dealer.d3)!;
    expect(daysBetween(today, String(bg['bank_guarantee_valid_till']))).toBe(40);
    expect(new Set(rows('vendor_registrations').map((v) => v['level']))).toEqual(new Set(E.VENDOR_LEVELS));
    const open = (dealerId: string) => rows('dealer_receivables').filter((r) => r['dealer_id'] === dealerId && (r['status'] === 'open' || r['status'] === 'overdue')).reduce((s, r) => s + Number(r['amount']) - Number(r['paid_amount']), 0);
    expect(open(DEMO_IDS.dealer.d1)).toBeGreaterThan(Number(dealer('d1')['credit_limit']));
    expect(rows('dealer_receivables').some((r) => r['dealer_id'] === DEMO_IDS.dealer.d1 && r['subsidy_linked'] === true)).toBe(true);
    for (const k of ['d2', 'd3', 'd6', 'd7', 'd8'] as const) expect(open(DEMO_IDS.dealer[k]), k).toBeLessThan(Number(dealer(k)['credit_limit']));
    const distWithTwo = rows('distributors').filter((d) => (d['territory_ids'] as string[]).length === 2);
    expect(distWithTwo).toHaveLength(1);
  });
  it('has an opportunity that relies on the ALMM exemption with commissioning after 31-Dec-2026', () => {
    const opp = rows('opportunities').filter((o) => o['exemption_reliance'] === true && String(o['expected_commissioning_date']) > '2026-12-31');
    expect(opp.length).toBeGreaterThanOrEqual(1);
    for (const o of rows('opportunities')) expect([o['requirement_confirmed'], o['timeline_confirmed'], o['commercial_potential_confirmed']]).toEqual([true, true, true]);
  });
  it('respects the database guards: SO credit exposure, dealer status and dispatch compliance', () => {
    const open = (dealerId: string) => rows('dealer_receivables').filter((r) => r['dealer_id'] === dealerId && (r['status'] === 'open' || r['status'] === 'overdue')).reduce((s, r) => s + Number(r['amount']) - Number(r['paid_amount']), 0);
    for (const o of rows('sales_orders')) {
      const dealer = rows('dealers').find((d) => d['id'] === o['dealer_id'])!;
      expect(dealer['portal_status'], String(o['so_no'])).not.toBe('deactivated');
      const exposure = open(String(o['dealer_id'])) + Math.max(0, Number(o['total']) - Number(o['advance_received']));
      const approved = rows('credit_overrides').some((c) => c['dealer_id'] === o['dealer_id'] && c['status'] === 'approved');
      expect(exposure <= Number(dealer['credit_limit']) || approved, String(o['so_no'])).toBe(true);
    }
    for (const d of rows('dispatches').filter((x) => x['status'] === 'dispatched' || x['status'] === 'delivered')) {
      const so = rows('sales_orders').find((s) => s['id'] === d['so_id'])!;
      const serials = rows('dispatch_serials').filter((x) => x['dispatch_id'] === d['id']).map((x) => rows('inventory_serials').find((s) => s['id'] === x['serial_id'])!);
      for (const s of serials) {
        const snap = s['compliance_snapshot'] as { almm_list1: boolean; almm_list2: boolean; dcr_verified: boolean };
        const sku = rows('skus').find((k) => k['id'] === s['sku_id'])!;
        if (sku['category'] !== 'module') continue;
        if (so['segment'] === 'pmsg_residential' || so['segment'] === 'pm_kusum') expect(snap.dcr_verified).toBe(true);
        if (so['segment'] !== 'ci_captive') expect(snap.almm_list1).toBe(true);
        if (['pmsg_residential', 'rwa_ghs', 'government_bid'].includes(String(so['segment']))) expect(snap.almm_list2).toBe(true);
      }
    }
  });
});

/* ───────── every gate has a quote that trips exactly that gate ───────── */

describe('gate scenario quotes', () => {
  const quotes = rows('quotations') as unknown as Quotation[];
  const q = (k: keyof typeof DEMO_IDS.quote): Quotation => quotes.find((x) => x.id === DEMO_IDS.quote[k])!;
  const matrix = new Map(rows('gate_applicability').map((g) => [`${g['gate']}|${g['segment']}`, String(g['applicability'])]));
  const applies = (gate: string, segment: string): boolean => matrix.get(`${gate}|${segment}`) !== 'not_applies';

  /** A small stand-in for the compliance engine: derives which gates the DATA of a quote would trip. */
  function tripped(quote: Quotation): string[] {
    const out = new Set<string>();
    const lines = rows('quotation_lines').filter((l) => l['quote_id'] === quote.id);
    const skuOf = (id: unknown) => rows('skus').find((s) => s['id'] === id)!;
    const compOf = (id: unknown) => rows('sku_compliance').find((c) => c['sku_id'] === id);
    const lead = rows('leads').find((l) => l['id'] === quote.lead_id)!;
    const site = rows('sites').find((s) => s['id'] === quote.site_id)!;
    const dealer = quote.dealer_id ? rows('dealers').find((d) => d['id'] === quote.dealer_id) : undefined;
    const seg = quote.segment;
    const commissioning = quote.expected_commissioning_date ?? '';
    const consent = rows('lead_consents').filter((c) => c['lead_id'] === lead['id'] && !c['withdrawn_at']);
    const hasPromo = consent.some((c) => (c['purposes'] as string[]).includes('promotional'));
    const dndStale = lead['dnd_checked_at'] === null || daysBetween(String(lead['dnd_checked_at']), today) > 30;
    if (applies('G1', seg) && (!hasPromo || lead['dnd_status'] !== 'clear' || dndStale)) out.add('G1');
    for (const l of lines) {
      const sku = skuOf(l['sku_id']);
      const c = compOf(l['sku_id']);
      if (sku['category'] === 'module' && c) {
        if (applies('G2', seg) && !c['dcr_verified'] && !c['thin_film']) out.add('G2');
        if (applies('G3', seg) && !c['almm_list1']) out.add('G3');
        if (applies('G4', seg) && !c['almm_list2'] && !c['thin_film'] && commissioning >= '2026-06-01') out.add('G4');
        if (applies('G10', seg) && c['almm_snapshot_date'] && daysBetween(String(c['almm_snapshot_date']), today) > 7) out.add('G10');
      }
      if (c && (sku['category'] === 'module' || sku['category'] === 'inverter') && applies('G6', seg)) {
        if (!c['bis_licence_no'] || String(c['bis_valid_till']) < today || c['bis_licensed_model'] !== sku['model']) out.add('G6');
      }
      if (c && sku['category'] === 'inverter' && applies('G7', seg) && Number(c['inverter_kw']) > 200 && c['self_certified'] && commissioning > '2026-12-31') out.add('G7');
      if (applies('G9', seg) && (l['hsn'] === null || l['gst_rate'] === null || l['tax_position_approved'] !== true)) out.add('G9');
    }
    if (applies('G5', seg) && quote.exemption_reliance && commissioning > '2026-12-31') out.add('G5');
    if (applies('G8', seg) && quote.exemption_reliance && quote.validity_date > '2026-12-31') out.add('G8');
    if (applies('G12', seg) && (site['name_match'] === false || site['pending_dues'] === true)) out.add('G12');
    if (applies('G13', seg) && seg === 'pmsg_residential' && quote.kw > 3) out.add('G13');
    if (dealer) {
      const outstanding = rows('dealer_receivables').filter((r) => r['dealer_id'] === dealer['id'] && (r['status'] === 'open' || r['status'] === 'overdue')).reduce((s, r) => s + Number(r['amount']) - Number(r['paid_amount']), 0);
      if (applies('G11', seg) && (outstanding > Number(dealer['credit_limit']) || dealer['portal_status'] !== 'active')) out.add('G11');
    }
    const docs = rows('documents').filter((d) => d['entity_id'] === quote.id);
    if (applies('G14', seg) && docs.some((d) => looksLikeAadhaarFilename(String(d['file_name'])))) out.add('G14');
    return [...out].sort();
  }

  it('has one quote per gate G1–G14, drafts with compliance status pending', () => {
    expect(new Set(DEMO_QUOTE_SCENARIOS.map((s) => s.gate))).toEqual(new Set([...E.GATES, 'clean']));
    for (const s of DEMO_QUOTE_SCENARIOS) {
      const x = q(s.key);
      expect(x.quote_no).toBe(s.quote_no);
      expect(x.status).toBe('draft');
      expect(x.compliance_status).toBe('pending');
      expect(x.compliance_findings).toEqual([]);
    }
    expect(DEMO_QUOTE_SCENARIOS.filter((s) => s.gate === 'clean')).toHaveLength(2);
  });
  for (const s of DEMO_QUOTE_SCENARIOS) {
    it(`${s.quote_no} (${s.gate}) trips ${s.gate === 'clean' ? 'nothing' : `exactly ${s.gate}`}`, () => {
      expect(tripped(q(s.key))).toEqual(s.gate === 'clean' ? [] : [s.gate]);
    });
  }
  it('keeps the pending-approval quote clean as well', () => {
    expect(tripped(q('pendingH'))).toEqual([]);
  });
  it('has internally consistent quote totals', () => {
    for (const x of quotes) {
      const lines = rows('quotation_lines').filter((l) => l['quote_id'] === x.id);
      expect(lines.length, x.quote_no).toBeGreaterThanOrEqual(3);
      const sum = lines.reduce((s, l) => s + Number(l['line_total']), 0);
      expect(sum).toBeCloseTo(x.subtotal, 1);
      expect(x.total).toBeGreaterThan(0);
      expect(x.consumer_share).toBeGreaterThan(0);
      expect(x.consumer_share + x.cfa_entitlement + x.loan_share + x.state_share).toBeCloseTo(x.total, 1);
    }
    expect(new Set(quotes.map((x) => x.quote_no)).size).toBe(quotes.length);
  });
  it('computes CFA from the seeded rule values', () => {
    expect(q('clean1').cfa_entitlement).toBe(78000);
    expect(q('g13').cfa_entitlement).toBe(78000);
    expect(q('w3').cfa_entitlement).toBe(67200);
    expect(q('g4').cfa_entitlement).toBeCloseTo(60.32 * 18000, 0);
    expect(q('g5').cfa_entitlement).toBe(0);
  });
});
