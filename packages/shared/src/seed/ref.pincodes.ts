import type { Pincode } from '../rows';
import { DEMO_IDS } from './demo.ids';
import { baseOf, refId, type SeedEnv } from './util';

interface Area { city: string; district: string; discom: 'ugvcl' | 'dgvcl' | 'mgvcl' | 'pgvcl' | 'torrent' | null; pincodes: string[] }

/**
 * Gujarat pincodes whose city and district are certain. The DISCOM is set only where one DISCOM serves the whole city:
 * Ahmedabad, Gandhinagar and Surat cities are served by more than one licensee, so the DISCOM is captured from the electricity bill instead.
 * territory_id stays empty — territories belong to the (deletable) demo dataset.
 */
const AREAS: readonly Area[] = [
  { city: 'Ahmedabad', district: 'Ahmedabad', discom: null, pincodes: ['380001', '380004', '380006', '380008', '380009', '380013', '380015', '380051', '380054', '380058'] },
  { city: 'Gandhinagar', district: 'Gandhinagar', discom: null, pincodes: ['382007', '382010', '382011', '382016', '382021', '382024'] },
  { city: 'Surat', district: 'Surat', discom: null, pincodes: ['395001', '395003', '395004', '395006', '395007', '395009', '394210'] },
  { city: 'Vadodara', district: 'Vadodara', discom: 'mgvcl', pincodes: ['390001', '390002', '390005', '390007', '390019', '390020'] },
  { city: 'Rajkot', district: 'Rajkot', discom: 'pgvcl', pincodes: ['360001', '360002', '360004', '360005', '360007'] },
  { city: 'Bhavnagar', district: 'Bhavnagar', discom: 'pgvcl', pincodes: ['364001', '364002'] },
  { city: 'Jamnagar', district: 'Jamnagar', discom: 'pgvcl', pincodes: ['361001', '361005'] },
  { city: 'Anand', district: 'Anand', discom: 'mgvcl', pincodes: ['388001'] },
  { city: 'Vallabh Vidyanagar', district: 'Anand', discom: 'mgvcl', pincodes: ['388120'] },
  { city: 'Mehsana', district: 'Mehsana', discom: 'ugvcl', pincodes: ['384001', '384002'] },
];

export const REFERENCE_PINCODES: readonly string[] = AREAS.flatMap((a) => a.pincodes);

export function buildPincodes(env: SeedEnv): Pincode[] {
  const rows: Pincode[] = [];
  let n = 0;
  for (const a of AREAS) {
    for (const pincode of a.pincodes) {
      n += 1;
      rows.push({
        ...baseOf(env, refId('pincode', n), 30 * 1440),
        pincode, city: a.city, district: a.district, state: 'Gujarat', discom_id: a.discom ? DEMO_IDS.discom[a.discom] : null, territory_id: null,
      });
    }
  }
  return rows;
}
