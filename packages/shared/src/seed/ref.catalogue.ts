import type { SkuCategory } from '../enums';
import type { BrandUsp, Sku, SkuCompliance, SkuPrice } from '../rows';
import { baseOf, refId, DAY, type SeedEnv } from './util';

/**
 * Starter product catalogue: 100 solar products that Gujarat distributors commonly stock (modules, inverters, structures,
 * batteries, cables and balance-of-system), so the product recommendation (step 16) has something to show.
 *
 *  - Makes are real Indian-market brands; MODEL CODES AND PRICES ARE CATALOGUE PLACEHOLDERS. Prices are indicative ex-GST list prices
 *    in INR; replace them with the supplier price list (Control > Catalogue) before quoting.
 *  - Compliance flags for modules (ALMM List-I / List-II, DCR) reflect each maker's public listing as a starting point only.
 *    NOTHING is marked verified: the snapshot date is empty, so gate G10 warns until a compliance officer confirms each model
 *    on the MNRE ALMM list and records the BIS licence.
 */
interface Seed {
  category: SkuCategory; make: string; model: string; variant: string; wattage: number | null; hsn: string; uom: string; warranty: number; price: number;
  description: string; dcr?: boolean; inverterKw?: number;
}

const DEFAULT_USP = (make: string, kind: 'module' | 'inverter', years: number): BrandUsp => ({
  quality: kind === 'module' ? `${make}: Indian manufacturer with ALMM-listed module lines — confirm the exact model on the MNRE list` : `${make}: established inverter brand — confirm the model's BIS registration`,
  warranty: kind === 'module' ? `${years}-year product warranty; linear performance warranty (confirm on the datasheet)` : `${years}-year standard warranty (extendable — confirm with the brand)`,
  certifications: kind === 'module' ? 'BIS IS 14286 / IEC 61215 / IEC 61730 — confirm the certificate for this model' : 'BIS / IEC 62109 — confirm the certificate for this model',
  service_support: 'Brand service network — confirm coverage for the customer’s district',
  delivery_reliability: 'Confirm current lead time with the supplier',
});

/* ───────────── modules (36) ───────────── */
const MODULE_BRANDS = ['Waaree', 'Adani Solar', 'Vikram Solar', 'Tata Power Solar', 'Premier Energies', 'Goldi Solar', 'Rayzon Solar', 'Saatvik Solar', 'RenewSys', 'Emmvee', 'Navitas Solar', 'Loom Solar'];
const modules = (): Seed[] => MODULE_BRANDS.flatMap((make, i) => {
  const w1 = [540, 545, 550, 555][i % 4]!;
  const w2 = [575, 580, 585, 590][(i + 1) % 4]!;
  const w3 = [610, 615, 620, 625][(i + 2) % 4]!;
  const row = (watt: number, dcr: boolean, tech: string, price: number): Seed => ({
    category: 'module', make, model: `${tech}-${watt}${dcr ? '-DCR' : ''}`, variant: `${tech === 'TOPCon' ? 'N-type TOPCon' : 'Mono PERC'} ${watt} Wp bifacial${dcr ? ', DCR' : ', non-DCR'}`, wattage: watt, hsn: '85414300', uom: 'nos', warranty: 12,
    price: Math.round(watt * price), dcr,
    description: dcr ? 'Domestic-content (DCR) cells: eligible for PM Surya Ghar subsidy once the DCR certificate is on file.' : 'ALMM-listed module with imported cells: for commercial and net-metered jobs, not for subsidy.',
  });
  return [row(w1, true, 'TOPCon', 26 + (i % 3) * 0.5), row(w2, true, 'TOPCon', 27 + (i % 4) * 0.4), row(w3, false, 'TOPCon', 15.5 + (i % 3) * 0.4)];
});

/* ───────────── inverters (28) ───────────── */
const INVERTER_PRICE: Record<number, number> = { 3: 32000, 5: 45000, 10: 72000, 15: 95000, 25: 140000, 50: 260000, 100: 480000, 110: 520000 };
const INVERTERS: [string, number[], number, number][] = [
  ['Growatt', [3, 5, 10, 15, 25, 50, 100], 1.0, 10], ['Sungrow', [5, 10, 25, 50, 110], 1.12, 10], ['Solis', [3, 5, 10, 25, 50], 0.97, 10], ['Havells', [3, 5, 10], 1.08, 7],
  ['Luminous', [3, 5], 1.05, 7], ['Polycab', [5, 10], 1.04, 7], ['Delta', [10, 25], 1.15, 10], ['Sofar Solar', [5, 10], 0.95, 10],
];
const inverters = (): Seed[] => INVERTERS.flatMap(([make, sizes, mult, years]) => sizes.map((kw): Seed => ({
  category: 'inverter', make, model: `${make.split(' ')[0]!.toUpperCase().slice(0, 4)}-${kw}K-${kw <= 5 ? '1P' : '3P'}`, variant: `${kw} kW ${kw <= 5 ? 'single-phase' : 'three-phase'} on-grid string inverter`,
  wattage: null, hsn: '85044090', uom: 'nos', warranty: years, price: Math.round((INVERTER_PRICE[kw] ?? kw * 4500) * mult / 100) * 100, inverterKw: kw,
  description: `${kw} kW grid-tied inverter with Wi-Fi monitoring and MPPT.`,
})));

/* ───────────── structures, batteries, cables, balance of system (36) ───────────── */
const other = (): Seed[] => {
  const s = (category: SkuCategory, make: string, model: string, variant: string, hsn: string, uom: string, warranty: number, price: number, description: string): Seed => ({ category, make, model, variant, wattage: null, hsn, uom, warranty, price, description });
  return [
    s('structure', 'Standard', 'GI-ELEV-KW', 'Hot-dip galvanised elevated rooftop structure, per kW', '73089090', 'kW', 10, 6500, 'Elevated GI structure for RCC roofs, 80 micron galvanising.'),
    s('structure', 'Standard', 'GI-LOW-KW', 'Pre-galvanised low-rise rooftop structure, per kW', '73089090', 'kW', 5, 4200, 'Low-rise structure for RCC roofs where wind load allows.'),
    s('structure', 'Standard', 'AL-RAIL-KW', 'Aluminium mini-rail structure, per kW', '76109090', 'kW', 10, 7800, 'Aluminium mini-rail for metal-sheet roofs.'),
    s('structure', 'Standard', 'SHED-PURLIN-KW', 'Tin-shed purlin-mount structure, per kW', '73089090', 'kW', 10, 5200, 'Purlin clamps and rails for industrial sheds.'),
    s('structure', 'Standard', 'GM-FIXED-KW', 'Ground-mount GI fixed-tilt structure, per kW', '73089090', 'kW', 10, 9500, 'Fixed-tilt ground mount with concrete foundations (foundation extra).'),
    s('structure', 'Standard', 'BALLAST-KW', 'Ballasted flat-roof structure, per kW', '73089090', 'kW', 10, 6800, 'Non-penetrating ballast mount for waterproofed flat roofs.'),
    s('structure', 'Standard', 'CARPORT-KW', 'Carport / parking structure, per kW', '73089090', 'kW', 10, 16500, 'Steel carport canopy carrying modules.'),
    s('structure', 'Standard', 'GI-HD-KW', 'Heavy-duty hot-dip galvanised structure, per kW', '73089090', 'kW', 15, 8200, 'Heavy-duty profile for high-wind coastal sites.'),

    s('battery', 'Exide', 'EXD-150-TUB', '12 V 150 Ah tubular lead-acid battery', '85071000', 'nos', 3, 14500, 'Tubular battery for hybrid / backup systems.'),
    s('battery', 'Amara Raja', 'AR-150-TUB', '12 V 150 Ah tubular lead-acid battery', '85071000', 'nos', 3, 14200, 'Tubular battery for hybrid / backup systems.'),
    s('battery', 'Luminous', 'LUM-150-RC', '12 V 150 Ah Red Charge tubular battery', '85071000', 'nos', 3, 14800, 'Tubular battery for hybrid / backup systems.'),
    s('battery', 'Livguard', 'LG-150-TUB', '12 V 150 Ah tubular lead-acid battery', '85071000', 'nos', 3, 14000, 'Tubular battery for hybrid / backup systems.'),
    s('battery', 'Okaya', 'OKY-LFP-5K', '5.12 kWh LiFePO4 battery', '85076000', 'nos', 5, 98000, 'Wall-mount lithium iron phosphate battery.'),
    s('battery', 'Luminous', 'LUM-LFP-5K', '5.12 kWh LiFePO4 battery', '85076000', 'nos', 5, 102000, 'Wall-mount lithium iron phosphate battery.'),
    s('battery', 'Livguard', 'LG-LFP-5K', '5.12 kWh LiFePO4 battery', '85076000', 'nos', 5, 99500, 'Wall-mount lithium iron phosphate battery.'),
    s('battery', 'Exide', 'EXD-100-SMF', '12 V 100 Ah SMF gel battery', '85071000', 'nos', 3, 11200, 'Sealed maintenance-free battery.'),

    s('cable', 'Polycab', 'PC-DC-4', 'DC solar cable 4 sq mm, twin-core / single-core copper', '85444999', 'm', 25, 58, 'UV-resistant, double-insulated DC cable.'),
    s('cable', 'Polycab', 'PC-DC-6', 'DC solar cable 6 sq mm, copper', '85444999', 'm', 25, 84, 'UV-resistant, double-insulated DC cable.'),
    s('cable', 'KEI', 'KEI-DC-4', 'DC solar cable 4 sq mm, copper', '85444999', 'm', 25, 56, 'UV-resistant, double-insulated DC cable.'),
    s('cable', 'Havells', 'HVL-DC-4', 'DC solar cable 4 sq mm, copper', '85444999', 'm', 25, 60, 'UV-resistant, double-insulated DC cable.'),
    s('cable', 'Finolex', 'FIN-DC-4', 'DC solar cable 4 sq mm, copper', '85444999', 'm', 25, 55, 'UV-resistant, double-insulated DC cable.'),
    s('cable', 'RR Kabel', 'RRK-DC-6', 'DC solar cable 6 sq mm, copper', '85444999', 'm', 25, 80, 'UV-resistant, double-insulated DC cable.'),
    s('cable', 'Polycab', 'PC-AC-4C10-AL', 'AC armoured cable 4 core 10 sq mm, aluminium', '85446090', 'm', 20, 135, 'Armoured AC cable from inverter to ACDB / meter.'),
    s('cable', 'Havells', 'HVL-AC-4C16-CU', 'AC armoured cable 4 core 16 sq mm, copper', '85446090', 'm', 20, 520, 'Armoured copper AC cable for three-phase runs.'),

    s('other', 'Standard', 'MC4-PAIR', 'MC4-compatible connector pair (male + female)', '85366990', 'nos', 5, 90, 'IP67 DC connector pair.'),
    s('other', 'Standard', 'DCDB-2IN2', 'DC distribution box 2-in 2-out with SPD and fuses', '85371000', 'nos', 3, 4800, 'Up to 10 kW; IP65 enclosure.'),
    s('other', 'Standard', 'DCDB-4IN4', 'DC distribution box 4-in 4-out with SPD and fuses', '85371000', 'nos', 3, 8200, 'For 10–25 kW arrays; IP65 enclosure.'),
    s('other', 'Standard', 'ACDB-1P', 'AC distribution box, single-phase, with MCB and SPD', '85371000', 'nos', 3, 2600, 'Up to 5 kW single-phase.'),
    s('other', 'Standard', 'ACDB-3P', 'AC distribution box, three-phase, with MCCB and SPD', '85371000', 'nos', 3, 7400, 'Up to 25 kW three-phase.'),
    s('other', 'Standard', 'EARTH-CHEM', 'Chemical earthing kit with pit cover', '85369090', 'nos', 5, 5200, 'Maintenance-free chemical earthing electrode.'),
    s('other', 'Standard', 'LA-ESE', 'Lightning arrestor, ESE type', '85363090', 'nos', 5, 9500, 'Early streamer emission lightning protection.'),
    s('other', 'Standard', 'SMART-NM-1P', 'Bi-directional smart meter, single-phase (net metering)', '90283090', 'nos', 5, 6200, 'Net-meter; DISCOM-approved make to be confirmed.'),
    s('other', 'Standard', 'SMART-NM-3P', 'Bi-directional smart meter, three-phase (net metering)', '90283090', 'nos', 5, 11800, 'Net-meter; DISCOM-approved make to be confirmed.'),
    s('other', 'Standard', 'WIFI-DONGLE', 'Wi-Fi monitoring dongle', '85176290', 'nos', 2, 3200, 'Plant monitoring for compatible inverters.'),
    s('other', 'Standard', 'CABLE-TRAY', 'GI cable tray / conduit set, per 10 m', '73089090', 'set', 10, 1900, 'Cable routing for DC and AC runs.'),
    s('other', 'Standard', 'SPD-DC-T2', 'DC surge protection device, type 2', '85363090', 'nos', 5, 2400, 'Surge protection for the DC side.'),
  ];
};

export const CATALOGUE_SEEDS = (): Seed[] => [...modules(), ...inverters(), ...other()];

export function buildCatalogue(env: SeedEnv): { skus: Sku[]; sku_compliance: SkuCompliance[]; sku_prices: SkuPrice[] } {
  const seeds = CATALOGUE_SEEDS();
  const skus: Sku[] = [], sku_compliance: SkuCompliance[] = [], sku_prices: SkuPrice[] = [];
  seeds.forEach((s, i) => {
    const n = i + 1;
    const id = refId('sku', n);
    const isModule = s.category === 'module';
    skus.push({
      ...baseOf(env, id, 30 * DAY), category: s.category, make: s.make, model: s.model, variant: s.variant, wattage: s.wattage, hsn: s.hsn, uom: s.uom, active: true, demo: false,
      description: s.description, warranty_years: s.warranty,
      brand_usp: isModule ? DEFAULT_USP(s.make, 'module', s.warranty) : s.category === 'inverter' ? DEFAULT_USP(s.make, 'inverter', s.warranty) : null,
    });
    sku_compliance.push({
      ...baseOf(env, refId('sku-compliance', n), 30 * DAY), sku_id: id,
      almm_list1: isModule, almm_list1_ref: isModule ? 'Starting point only: confirm the model on the MNRE ALMM List-I' : null, almm_list1_valid_till: null, almm_snapshot_date: null,
      cell_maker: null, almm_list2: isModule, dcr_verified: isModule && !!s.dcr, cell_origin: isModule ? (s.dcr ? 'domestic' : 'import') : null,
      bis_licence_no: null, bis_licensed_model: null, bis_standard_no: isModule ? 'IS 14286' : null, bis_valid_till: null,
      inverter_kw: s.inverterKw ?? null, self_certified: false, thin_film: false, verified_by: null, verified_at: null,
    });
    sku_prices.push({
      ...baseOf(env, refId('sku-price', n), 30 * DAY), sku_id: id, base_price: s.price, valid_from: env.d(-30), valid_to: null, landed_cost: {},
      source: 'Indicative list price (ex-GST) — replace with the supplier price list', snapshot_label: 'STARTER-CATALOGUE', floor_price: Math.round(s.price * 0.93),
    });
  });
  return { skus, sku_compliance, sku_prices };
}
