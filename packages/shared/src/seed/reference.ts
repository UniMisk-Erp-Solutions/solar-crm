import type { Discom, Organization } from '../rows';
import { DEMO_IDS } from './demo.ids';
import { buildTerritories } from './demo.people';
import { buildApprovalRules } from './ref.approvals';
import { buildCalendar } from './ref.calendar';
import { buildSegmentForms } from './ref.forms';
import { buildGateApplicability } from './ref.gates';
import { buildCatalogue } from './ref.catalogue';
import { buildNetworkDistributors, buildRegionTerritories } from './ref.network';
import { buildPincodes } from './ref.pincodes';
import { buildTemplates } from './ref.templates';
import { buildVerifyRegister } from './ref.verify';
import { buildRuleConfigRows } from './rules.build';
import type { SeedData } from './types';
import { baseOf, makeEnv, type SeedEnv } from './util';

export function buildOrganization(env: SeedEnv): Organization {
  return {
    id: env.org, name: 'Future Solar', legal_name: 'Future Solar Pvt. Ltd.', gstin: null, pan: null, address: null, state: 'Gujarat',
    settings: { timezone: 'Asia/Kolkata', currency: 'INR', default_language: 'en', languages: ['en', 'hi', 'gu'] },
    created_at: env.t(-90 * 1440), updated_at: env.t(-90 * 1440),
  };
}

export function buildDiscoms(env: SeedEnv): Discom[] {
  const mk = (id: string, code: string, name: string, kind: Discom['kind']): Discom => ({ ...baseOf(env, id, 90 * 1440), code, name, state: 'Gujarat', kind });
  return [
    mk(DEMO_IDS.discom.ugvcl, 'UGVCL', 'Uttar Gujarat Vij Company Limited', 'discom'),
    mk(DEMO_IDS.discom.dgvcl, 'DGVCL', 'Dakshin Gujarat Vij Company Limited', 'discom'),
    mk(DEMO_IDS.discom.mgvcl, 'MGVCL', 'Madhya Gujarat Vij Company Limited', 'discom'),
    mk(DEMO_IDS.discom.pgvcl, 'PGVCL', 'Paschim Gujarat Vij Company Limited', 'discom'),
    mk(DEMO_IDS.discom.torrent, 'TORRENT', 'Torrent Power Limited', 'licensee'),
  ];
}

/** Reference data: safe for production, idempotent (`on conflict do nothing`), never deleted by 99_delete_demo_data.sql. */
/** `network`: also the 22 regional territories, the 50 starter distributors across Gujarat and the 100-product starter catalogue (the SQL seed has them; the in-memory demo uses its own three). */
export function buildReferenceSeed(now: Date = new Date(), network = true): SeedData {
  const env = makeEnv(now);
  return {
    organizations: [buildOrganization(env)],
    discoms: buildDiscoms(env),
    pincodes: buildPincodes(env),
    territories: [...buildTerritories(env, false), ...(network ? buildRegionTerritories(env) : [])],
    distributors: network ? buildNetworkDistributors(env) : [],
    ...(network ? buildCatalogue(env) : {}),
    rule_config: buildRuleConfigRows(now),
    message_templates: buildTemplates(env),
    compliance_calendar_items: buildCalendar(env),
    verify_register: buildVerifyRegister(env),
    gate_applicability: buildGateApplicability(env),
    approval_rules: buildApprovalRules(env),
    segment_form_config: buildSegmentForms(env),
  };
}
