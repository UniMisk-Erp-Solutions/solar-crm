import type { Distributor, Territory } from '../rows';
import { DEMO_IDS } from './demo.ids';
import { baseOf, refId, DAY, type SeedEnv } from './util';

/**
 * Starter distributor network for Gujarat. The REGIONS are the postal sorting districts (the first three digits of a pincode), which
 * cover the whole state; the more specific city territories of the base seed win where they overlap.
 * The distributors are PLACEHOLDER records: one or more per city, each with a real city pincode, so the lead router can suggest the nearest.
 * Replace their names, GSTIN/PAN and contacts in the app (Control > Distributors) as the real onboarding completes.
 */
interface Region { prefix: string; name: string; discom: keyof typeof DEMO_IDS.discom | null }

const REGIONS: readonly Region[] = [
  { prefix: '360', name: 'Rajkot region', discom: 'pgvcl' },
  { prefix: '361', name: 'Jamnagar region', discom: 'pgvcl' },
  { prefix: '362', name: 'Junagadh and Gir Somnath region', discom: 'pgvcl' },
  { prefix: '363', name: 'Surendranagar and Morbi region', discom: 'pgvcl' },
  { prefix: '364', name: 'Bhavnagar region', discom: 'pgvcl' },
  { prefix: '365', name: 'Amreli region', discom: 'pgvcl' },
  { prefix: '370', name: 'Kutch region', discom: 'pgvcl' },
  { prefix: '380', name: 'Ahmedabad region', discom: null },
  { prefix: '382', name: 'Gandhinagar and Ahmedabad rural region', discom: null },
  { prefix: '383', name: 'Sabarkantha and Aravalli region', discom: 'ugvcl' },
  { prefix: '384', name: 'Mehsana and Patan region', discom: 'ugvcl' },
  { prefix: '385', name: 'Banaskantha region', discom: 'ugvcl' },
  { prefix: '387', name: 'Kheda region', discom: 'mgvcl' },
  { prefix: '388', name: 'Anand region', discom: 'mgvcl' },
  { prefix: '389', name: 'Panchmahal and Dahod region', discom: 'mgvcl' },
  { prefix: '390', name: 'Vadodara region', discom: 'mgvcl' },
  { prefix: '391', name: 'Vadodara rural and Chhota Udepur region', discom: 'mgvcl' },
  { prefix: '392', name: 'Bharuch region', discom: 'dgvcl' },
  { prefix: '393', name: 'Bharuch and Narmada region', discom: 'dgvcl' },
  { prefix: '394', name: 'Surat rural and Tapi region', discom: 'dgvcl' },
  { prefix: '395', name: 'Surat region', discom: 'dgvcl' },
  { prefix: '396', name: 'Valsad, Navsari and Dang region', discom: 'dgvcl' },
];

export function buildRegionTerritories(env: SeedEnv): Territory[] {
  return REGIONS.map((r, i) => ({
    ...baseOf(env, refId('territory-region', i + 1), 60 * DAY),
    name: r.name, state: 'Gujarat', district: null, pincode_ranges: [{ from: `${r.prefix}000`, to: `${r.prefix}999` }],
    discom_id: r.discom ? DEMO_IDS.discom[r.discom] : null, dsm_id: null, active: true,
  }));
}

const regionId = (prefix: string): string => refId('territory-region', REGIONS.findIndex((r) => r.prefix === prefix) + 1);
/** The narrower city territories of the base seed sit inside these regions and win when a pincode falls in both, so a distributor must serve them too. */
const CITY_TERRITORY: Record<string, string> = { '380': DEMO_IDS.territory.ahmedabad, '382': DEMO_IDS.territory.gandhinagar, '395': DEMO_IDS.territory.surat, '390': DEMO_IDS.territory.vadodara, '360': DEMO_IDS.territory.rajkot };
const servedBy = (prefix: string): string[] => [regionId(prefix), ...(CITY_TERRITORY[prefix] ? [CITY_TERRITORY[prefix]!] : [])];

type Tag = 'residential' | 'rwa' | 'pmsg' | 'rooftop' | 'small_commercial' | 'commercial' | 'industrial' | 'net_metering' | 'open_access' | 'captive' | 'kusum' | 'government';
const PROFILES: { band: [number, number]; tags: Tag[]; credit: [number, number] }[] = [
  { band: [1, 100], tags: ['residential', 'rwa', 'pmsg', 'rooftop', 'small_commercial'], credit: [30, 2_500_000] },
  { band: [3, 500], tags: ['residential', 'pmsg', 'rooftop', 'commercial', 'small_commercial', 'rwa'], credit: [30, 5_000_000] },
  { band: [10, 1000], tags: ['commercial', 'industrial', 'net_metering', 'captive', 'rooftop', 'rwa'], credit: [45, 10_000_000] },
  { band: [1, 300], tags: ['residential', 'pmsg', 'rooftop', 'kusum', 'small_commercial'], credit: [21, 3_000_000] },
];

/** [city, home pincode, prefix of the main region, other region prefixes it also serves] — one row per distributor. */
const SITES: [string, string, string, string[]][] = [
  ['Ahmedabad', '380015', '380', ['382']], ['Ahmedabad', '380009', '380', ['382']], ['Ahmedabad', '380054', '380', ['382']], ['Ahmedabad', '380051', '380', ['382']],
  ['Gandhinagar', '382010', '382', ['380']], ['Kalol', '382721', '382', ['384']], ['Sanand', '382110', '382', ['380']], ['Viramgam', '382150', '382', ['380']],
  ['Surat', '395007', '395', ['394']], ['Surat', '395003', '395', ['394']], ['Surat', '395009', '395', ['394']], ['Bardoli', '394601', '394', ['395']],
  ['Vadodara', '390007', '390', ['391']], ['Vadodara', '390020', '390', ['391']], ['Vadodara', '390001', '390', ['391', '389']], ['Halol', '389350', '389', ['390']],
  ['Rajkot', '360001', '360', ['363']], ['Rajkot', '360005', '360', ['363']], ['Rajkot', '360002', '360', ['363']], ['Gondal', '360311', '360', ['365']],
  ['Bhavnagar', '364001', '364', ['365']], ['Bhavnagar', '364002', '364', ['365']], ['Jamnagar', '361001', '361', ['360']], ['Jamnagar', '361005', '361', ['360']],
  ['Junagadh', '362001', '362', ['365']], ['Veraval', '362265', '362', ['365']], ['Surendranagar', '363001', '363', ['364']], ['Morbi', '363641', '363', ['360']],
  ['Amreli', '365601', '365', ['364']], ['Bhuj', '370001', '370', []], ['Gandhidham', '370201', '370', []], ['Anand', '388001', '388', ['387']],
  ['Nadiad', '387001', '387', ['388']], ['Mehsana', '384001', '384', ['383']], ['Palanpur', '385001', '385', ['384']], ['Himmatnagar', '383001', '383', ['382']],
  ['Godhra', '389001', '389', ['388']], ['Dahod', '389151', '389', ['391']], ['Bharuch', '392001', '392', ['393']], ['Ankleshwar', '393001', '393', ['392']],
  ['Rajpipla', '393145', '393', ['392']], ['Navsari', '396445', '396', ['395']], ['Valsad', '396001', '396', []], ['Vapi', '396191', '396', []],
  ['Vyara', '394650', '394', ['395']], ['Patan', '384265', '384', ['385']], ['Deesa', '385535', '385', []], ['Modasa', '383315', '383', []],
  ['Porbandar', '360575', '360', ['362']], ['Chhota Udepur', '391165', '391', ['390']],
];

export function buildNetworkDistributors(env: SeedEnv): Distributor[] {
  const seen = new Map<string, number>();
  return SITES.map(([city, pincode, prefix, extra], i) => {
    const nth = (seen.get(city) ?? 0) + 1;
    seen.set(city, nth);
    const p = PROFILES[i % PROFILES.length]!;
    const label = nth > 1 || SITES.filter((s) => s[0] === city).length > 1 ? `${city} ${nth}` : city;
    return {
      ...baseOf(env, refId('distributor', i + 1), 45 * DAY),
      legal_name: `Solar Distributor ${label}`, trade_name: `Solar Distributor ${label}`, gstin: null, pan: null, contact_name: null, phone: null, email: null,
      address: { line1: 'To be updated', city, district: city, state: 'Gujarat', pincode },
      state: 'Gujarat', city,
      territory_ids: [...new Set([...servedBy(prefix), ...extra.flatMap(servedBy)])],
      capacity_band_min_kw: p.band[0], capacity_band_max_kw: p.band[1], capability_tags: [...p.tags], score: 50,
      status: 'active', credit_days: p.credit[0], credit_limit: p.credit[1], rebate_slab_key: null,
    };
  });
}
