import { DEMO_ORG_ID } from '../ids';
import { demoId, named, refId } from './util';

/** Named ids for the demo dataset, so tests and other modules can refer to "the over-limit dealer" without lookups. */

const profile = named('profile', [
  'admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'dsm2', 'techno_commercial', 'accounts', 'compliance_officer', 'dispatch', 'viewer',
  'distributor_user', 'distributor_user_b', 'distributor_user_c', 'dealer_user', 'dealer_user_2', 'dealer_user_3',
] as const);

const distributor = named('distributor', ['sunrise', 'suryamitra', 'saurashtra'] as const);

/** d1 over credit limit · d2 healthy · d3 bank guarantee expiring in 40 days · d4 under SOP · d5 deactivated · d6/d7/d8 healthy */
const dealer = named('dealer', ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'] as const);

const territory = named('territory', ['ahmedabad', 'gandhinagar', 'surat', 'vadodara', 'rajkot'] as const);

const lead = named('lead', [
  'newNoConsent', 'unassignedVadodara', 'assignedRwa', 'assignedAboutToBreach', 'acceptedKusum', 'contactedOptedOut', 'qualifiedOpenAccess',
  'siteVisitFeasibility', 'nurture', 'lost',
  'oppPmsg', 'oppPmsgOverLimit', 'oppRwa', 'oppNetMetered', 'oppOpenAccess', 'oppKusum', 'oppCaptiveDnd', 'oppGovernment',
  'won1', 'won2', 'won3', 'won4', 'won5',
] as const);

/** opA…opH = open pipeline opportunities (one per gate-scenario family); w1…w5 = won opportunities that carry the order-to-cash chain. */
const opportunity = named('opportunity', ['opA', 'opB', 'opC', 'opD', 'opE', 'opF', 'opG', 'opH', 'w1', 'w2', 'w3', 'w4', 'w5'] as const);

const quote = named('quote', [
  'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9', 'g10', 'g11', 'g12', 'g13', 'g14', 'clean1', 'clean2',
  'pendingH', 'w1v1', 'w1', 'w2v1', 'w2', 'w3', 'w4', 'w5',
] as const);

const sku = named('sku', [
  'm1Dcr', 'm2NonDcr', 'm3NotListI', 'm4BisExpired', 'm5BisModelMismatch', 'm6NoListII', 'm7ThinFilm', 'm8StaleSnapshot',
  'i1Residential', 'i2Large250', 'i3Commercial100', 's1Structure', 'c1Cable', 'b1Battery',
] as const);

const salesOrder = named('sales-order', ['so1', 'so2', 'so3', 'so4', 'so5'] as const);
const proformaInvoice = named('pi', ['pi1', 'pi2', 'pi3', 'pi4', 'pi5', 'piCancelled'] as const);
const dispatch = named('dispatch', ['dsp1', 'dsp2', 'dsp3', 'dsp4'] as const);
const installation = named('installation', ['inst1', 'inst2', 'inst3'] as const);
const creditOverride = named('credit-override', ['approved', 'pending', 'rejected'] as const);

export const DEMO_IDS = {
  org: DEMO_ORG_ID,
  profile,
  distributor,
  dealer,
  territory,
  lead,
  opportunity,
  quote,
  sku,
  salesOrder,
  proformaInvoice,
  dispatch,
  installation,
  creditOverride,
  /** Reference discoms (production-safe ids). */
  discom: {
    ugvcl: refId('discom', 1), dgvcl: refId('discom', 2), mgvcl: refId('discom', 3), pgvcl: refId('discom', 4), torrent: refId('discom', 5),
  },
} as const;

export type DemoIds = typeof DEMO_IDS;

/** Deterministic id of line `line` (1-based) of sales order `so` (1-based). Shared by the order, serial and post-sale builders. */
export const soLineId = (so: number, line: number): string => demoId('so-line', so * 10 + line);
