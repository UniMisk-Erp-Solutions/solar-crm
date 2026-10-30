import type { SkuCategory } from '../enums';
import type { BrandUsp, LandedCost, Sku, SkuCompliance, SkuPrice, StockBatch } from '../rows';
import { DEMO_IDS } from './demo.ids';
import { baseOf, demoId, type SeedEnv } from './util';

const S = DEMO_IDS.sku;
const P = DEMO_IDS.profile;
export type SkuKey = keyof typeof DEMO_IDS.sku;

/**
 * 14 demo SKUs. Every one is fictional (`demo: true`). Together they cover each compliance state the gates look for:
 *  m1 clean DCR · m2 List-I but non-DCR · m3 not on List-I · m4 BIS expired · m5 BIS licensed model differs from the quoted model ·
 *  m6 no List-II cells (stock exposure) · m7 thin-film · m8 stale ALMM snapshot · i2 inverter above 200 kW on self-certification ·
 *  i1/i2/i3 inverters whose GST rate is disputed (every quote line needs a CA tax-position approval).
 */
interface SkuSeed {
  key: SkuKey; category: SkuCategory; make: string; model: string; variant: string; wattage: number | null; hsn: string; uom: string; warranty: number;
  description: string; price: number; floor: number; gst: number; landed: LandedCost; unitLabel: string;
}

const usp = (quality: string, warranty: string, certifications: string, service: string, delivery: string): BrandUsp => ({ quality, warranty, certifications, service_support: service, delivery_reliability: delivery });

export const SKU_SEEDS: readonly SkuSeed[] = [
  { key: 'm1Dcr', category: 'module', make: 'DemoSolar', model: 'DS-N600-DCR', variant: 'N-type TOPCon 600 Wp, DCR', wattage: 600, hsn: '85414300', uom: 'nos', warranty: 12, description: 'Clean subsidy-grade module: ALMM List-I model, List-II cells, DCR verified, BIS valid.', price: 15600, floor: 14300, gst: 5, landed: { freight: 120 }, unitLabel: 'Module' },
  { key: 'm2NonDcr', category: 'module', make: 'DemoSolar', model: 'DS-N600-STD', variant: 'N-type TOPCon 600 Wp, non-DCR', wattage: 600, hsn: '85414300', uom: 'nos', warranty: 12, description: 'ALMM List-I and List-II compliant, BIS valid, but the DCR certificate is not verified — fine for non-subsidy jobs, blocked on PMSG and KUSUM quotes.', price: 9900, floor: 9100, gst: 5, landed: { bcd: 1980, aidc: 1980, sws: 198, adc: 0, freight: 120 }, unitLabel: 'Module' },
  { key: 'm3NotListI', category: 'module', make: 'NovaPV Demo', model: 'NP-M590', variant: 'Mono PERC 590 Wp', wattage: 590, hsn: '85414300', uom: 'nos', warranty: 10, description: 'Model is NOT on ALMM List-I (gate G3).', price: 9500, floor: 8700, gst: 5, landed: { bcd: 1900, aidc: 1900, sws: 190, adc: 0, freight: 120 }, unitLabel: 'Module' },
  { key: 'm4BisExpired', category: 'module', make: 'PhotonWorks Demo', model: 'PW-M580', variant: 'Mono PERC 580 Wp', wattage: 580, hsn: '85414300', uom: 'nos', warranty: 10, description: 'BIS licence expired 45 days ago (gate G6).', price: 9800, floor: 9000, gst: 5, landed: { bcd: 1960, aidc: 1960, sws: 196, adc: 0, freight: 120 }, unitLabel: 'Module' },
  { key: 'm5BisModelMismatch', category: 'module', make: 'PhotonWorks Demo', model: 'PW-M585', variant: 'Mono PERC 585 Wp', wattage: 585, hsn: '85414300', uom: 'nos', warranty: 10, description: 'BIS licence covers model PW-M580, not the quoted PW-M585 (gate G6).', price: 9900, floor: 9100, gst: 5, landed: { bcd: 1980, aidc: 1980, sws: 198, adc: 0, freight: 120 }, unitLabel: 'Module' },
  { key: 'm6NoListII', category: 'module', make: 'DemoSolar', model: 'DS-N580-STK', variant: 'N-type TOPCon 580 Wp (older stock)', wattage: 580, hsn: '85414300', uom: 'nos', warranty: 12, description: 'ALMM List-I model but the cell maker is not on List-II: allowed only for net-metering / open-access jobs commissioned by 31-Dec-2026 (gates G4, G5).', price: 12400, floor: 11400, gst: 5, landed: { bcd: 2480, aidc: 2480, sws: 248, adc: 0, freight: 120 }, unitLabel: 'Module' },
  { key: 'm7ThinFilm', category: 'module', make: 'ThinLayer Demo', model: 'TL-F120', variant: 'Thin-film 120 Wp', wattage: 120, hsn: '85414300', uom: 'nos', warranty: 10, description: 'Thin-film module: exempt from the crystalline DCR norm; not used in any demo quote.', price: 3100, floor: 2850, gst: 5, landed: { freight: 60 }, unitLabel: 'Module' },
  { key: 'm8StaleSnapshot', category: 'module', make: 'DemoSolar', model: 'DS-N595-ST', variant: 'N-type TOPCon 595 Wp', wattage: 595, hsn: '85414300', uom: 'nos', warranty: 12, description: 'Compliant, but the ALMM snapshot is 12 days old (gate G10, limit 7 days).', price: 10400, floor: 9500, gst: 5, landed: { bcd: 2080, aidc: 2080, sws: 208, adc: 0, freight: 120 }, unitLabel: 'Module' },
  { key: 'i1Residential', category: 'inverter', make: 'GridMate Demo', model: 'GM-5K-1P', variant: '5 kW single-phase on-grid', wattage: null, hsn: '85044090', uom: 'nos', warranty: 7, description: 'Residential string inverter. GST position disputed (5 % vs 18 %): every quote line needs a CA approval.', price: 38500, floor: 35000, gst: 18, landed: { freight: 250 }, unitLabel: 'Inverter' },
  { key: 'i2Large250', category: 'inverter', make: 'GridMate Demo', model: 'GM-250K-3P', variant: '250 kW three-phase central inverter', wattage: null, hsn: '85044090', uom: 'nos', warranty: 5, description: 'Above 200 kW and on BIS self-certification until 31-Dec-2026 (gate G7). GST position disputed.', price: 925000, floor: 860000, gst: 18, landed: { freight: 6500 }, unitLabel: 'Inverter' },
  { key: 'i3Commercial100', category: 'inverter', make: 'GridMate Demo', model: 'GM-100K-3P', variant: '100 kW three-phase string inverter', wattage: null, hsn: '85044090', uom: 'nos', warranty: 5, description: 'C&I string inverter with a BIS licence. GST position disputed.', price: 410000, floor: 380000, gst: 18, landed: { freight: 3200 }, unitLabel: 'Inverter' },
  { key: 's1Structure', category: 'structure', make: 'RoofRack Demo', model: 'RR-GI-KW', variant: 'Hot-dip galvanised rooftop structure, per kW', wattage: null, hsn: '73089090', uom: 'kW', warranty: 10, description: 'Mounting structure priced per kW.', price: 6200, floor: 5700, gst: 18, landed: { freight: 300 }, unitLabel: 'Structure' },
  { key: 'c1Cable', category: 'cable', make: 'WireWorks Demo', model: 'WW-DC-4SQ', variant: 'DC solar cable 4 sq mm', wattage: null, hsn: '85444999', uom: 'm', warranty: 25, description: 'Twin-core DC solar cable, priced per metre.', price: 62, floor: 56, gst: 18, landed: { freight: 2 }, unitLabel: 'DC cable' },
  { key: 'b1Battery', category: 'battery', make: 'CellStore Demo', model: 'CS-LFP-5K', variant: '5.12 kWh LiFePO4 battery', wattage: null, hsn: '85076000', uom: 'nos', warranty: 5, description: 'Storage battery; GST position unverified (vendor blog 18 %).', price: 78000, floor: 72000, gst: 18, landed: { freight: 600 }, unitLabel: 'Battery' },
];

export const skuSeed = (key: SkuKey): SkuSeed => {
  const s = SKU_SEEDS.find((x) => x.key === key);
  if (!s) throw new Error(`Unknown SKU ${key}`);
  return s;
};
export const priceIdOf = (key: SkuKey): string => demoId('sku-price', SKU_SEEDS.findIndex((x) => x.key === key) + 1);

export function buildSkus(env: SeedEnv): Sku[] {
  return SKU_SEEDS.map((s) => ({
    ...baseOf(env, S[s.key], 60 * 1440, P.techno_commercial), category: s.category, make: s.make, model: s.model, variant: s.variant, wattage: s.wattage, hsn: s.hsn, uom: s.uom, active: true, demo: true,
    description: s.description, warranty_years: s.warranty,
    brand_usp: s.category === 'module' || s.category === 'inverter'
      ? usp(`${s.make} demo quality statement`, `${s.warranty}-year product warranty (demo)`, s.category === 'module' ? 'BIS, IEC 61215 / 61730 (demo)' : 'BIS, IEC 62109 (demo)', 'Service desk in Gujarat (demo)', 'Stocked at the Ahmedabad warehouse (demo)')
      : null,
  }));
}

export function buildSkuPrices(env: SeedEnv): SkuPrice[] {
  return SKU_SEEDS.map((s, i) => ({
    ...baseOf(env, demoId('sku-price', i + 1), 5 * 1440, P.techno_commercial), sku_id: S[s.key], base_price: s.price, valid_from: env.d(-5), valid_to: env.d(30), landed_cost: s.landed,
    source: 'Demo price list', snapshot_label: `DEMO-PL-${env.d(-5)}`, floor_price: s.floor,
  }));
}

/** Compliance flags per SKU. Dates are relative to the anchor so the staleness / expiry states stay true whenever the seed is generated. */
export function buildSkuCompliance(env: SeedEnv): SkuCompliance[] {
  const fresh = env.d(-2);
  const stale = env.d(-12);
  const mk = (key: SkuKey, n: number, o: Partial<SkuCompliance>): SkuCompliance => {
    const s = skuSeed(key);
    const isModule = s.category === 'module';
    return {
      ...baseOf(env, demoId('sku-compliance', n), 30 * 1440, P.compliance_officer), sku_id: S[key],
      almm_list1: isModule, almm_list1_ref: isModule ? `DEMO-ALMM-L1-${String(n).padStart(4, '0')}` : null, almm_list1_valid_till: isModule ? env.d(400) : null, almm_snapshot_date: fresh,
      cell_maker: isModule ? 'DemoCells Ltd (Demo)' : null, almm_list2: isModule, dcr_verified: isModule, cell_origin: isModule ? 'domestic' : null,
      bis_licence_no: `DEMO-BIS-R-${String(41000000 + n)}`, bis_licensed_model: s.model, bis_standard_no: isModule ? 'IS 14286' : 'IS 16221', bis_valid_till: env.d(300),
      inverter_kw: null, self_certified: false, thin_film: false, verified_by: P.compliance_officer, verified_at: env.t(-2 * 1440), ...o,
    };
  };
  return [
    mk('m1Dcr', 1, {}),
    mk('m2NonDcr', 2, { dcr_verified: false }),
    mk('m3NotListI', 3, { almm_list1: false, almm_list1_ref: null, almm_list1_valid_till: null, dcr_verified: false, cell_maker: 'Unlisted cell maker (Demo)' }),
    mk('m4BisExpired', 4, { dcr_verified: false, bis_valid_till: env.d(-45) }),
    mk('m5BisModelMismatch', 5, { dcr_verified: false, bis_licensed_model: 'PW-M580' }),
    mk('m6NoListII', 6, { almm_list2: false, cell_maker: 'Listing-pending cell maker (Demo)' }),
    mk('m7ThinFilm', 7, { almm_list2: false, dcr_verified: false, thin_film: true, cell_origin: null, cell_maker: null }),
    mk('m8StaleSnapshot', 8, { almm_snapshot_date: stale }),
    mk('i1Residential', 9, { inverter_kw: 5 }),
    mk('i2Large250', 10, { inverter_kw: 250, self_certified: true, bis_licence_no: 'DEMO-SELFCERT-0250' }),
    mk('i3Commercial100', 11, { inverter_kw: 100 }),
  ];
}

/* ───────────────────────── stock ───────────────────────── */

export const BATCH_IDS = {
  m1: demoId('batch', 1), m2: demoId('batch', 2), m3: demoId('batch', 3), m6: demoId('batch', 4), i1: demoId('batch', 5), i3: demoId('batch', 6), m8: demoId('batch', 7),
} as const;

export function buildStockBatches(env: SeedEnv): StockBatch[] {
  const mk = (id: string, sku: SkuKey, batchNo: string, receivedDaysAgo: number, qty: number, origin: StockBatch['origin'], boe: string | null, unitCost: number, location: string): StockBatch => ({
    ...baseOf(env, id, receivedDaysAgo * 1440, P.dispatch), sku_id: S[sku], batch_no: batchNo, received_at: env.d(-receivedDaysAgo), qty, supplier: origin === 'domestic' ? 'DemoSolar Manufacturing (Demo)' : 'Overseas supplier (Demo)', origin, boe_no: boe, unit_cost: unitCost, location,
  });
  return [
    mk(BATCH_IDS.m1, 'm1Dcr', 'DS600D-2026-01', 60, 400, 'domestic', null, 13800, 'Ahmedabad warehouse'),
    mk(BATCH_IDS.m2, 'm2NonDcr', 'DS600S-2026-02', 45, 600, 'import', 'DEMO-BOE-1001', 8900, 'Ahmedabad warehouse'),
    mk(BATCH_IDS.m3, 'm3NotListI', 'NP590-2026-01', 80, 120, 'import', 'DEMO-BOE-0998', 8400, 'Surat warehouse'),
    mk(BATCH_IDS.m6, 'm6NoListII', 'DS580K-2026-03', 120, 900, 'import', 'DEMO-BOE-1002', 10800, 'Surat warehouse'),
    mk(BATCH_IDS.i1, 'i1Residential', 'GM5K-2026-01', 50, 60, 'domestic', null, 33000, 'Ahmedabad warehouse'),
    mk(BATCH_IDS.i3, 'i3Commercial100', 'GM100K-2026-01', 50, 12, 'domestic', null, 355000, 'Surat warehouse'),
    mk(BATCH_IDS.m8, 'm8StaleSnapshot', 'DS595T-2026-04', 30, 500, 'domestic', null, 9000, 'Rajkot warehouse'),
  ];
}
