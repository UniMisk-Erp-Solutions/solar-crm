import { GATES, SEGMENTS, type Applicability, type Gate, type Segment } from '../enums';
import type { GateApplicability } from '../rows';
import { baseOf, refId, type SeedEnv } from './util';

type Code = 'a' | 'n' | 'w';
const FULL: Record<Code, Applicability> = { a: 'applies', n: 'not_applies', w: 'warning' };

/** Column order = SEGMENTS: pmsg_residential, rwa_ghs, ci_captive, ci_net_metered, open_access, pm_kusum, government_bid. */
interface GateRow {
  codes: string;
  /** note for a cell that applies */
  applies: string;
  /** per-segment notes for cells that do not apply or only warn */
  notes?: Partial<Record<Segment, string>>;
}

const MATRIX: Record<Gate, GateRow> = {
  G1: { codes: 'aaaaaaa', applies: 'Promotional contact needs consent, a fresh DND scrub and no opt-out suppression, whatever the segment.' },
  G2: {
    codes: 'aannnaw', applies: 'Subsidised (CFA) projects need DCR-verified modules — domestic cells are an essential condition for CFA.',
    notes: {
      ci_captive: 'No subsidy is claimed on captive C&I jobs, so DCR is not required.',
      ci_net_metered: 'No CFA on net-metered C&I jobs, so DCR is not required.',
      open_access: 'No CFA on open-access jobs, so DCR is not required.',
      government_bid: 'DCR depends on the tender conditions — flagged as a warning for the techno-commercial team to check.',
    },
  },
  G3: {
    codes: 'aawaaaa', applies: 'Modules must be a model listed on ALMM List-I (model level, not brand).',
    notes: { ci_captive: 'Captive behind-the-meter plants are reported to be exempt from ALMM, but the definition is unverified — shown as a warning.' },
  },
  G4: {
    codes: 'aawnnaa', applies: 'Subsidy and government projects commissioned on or after the List-II effective date need cells from an ALMM List-II maker.',
    notes: {
      ci_captive: 'Captive behind-the-meter plants are reported to be exempt; the definition is unverified — shown as a warning.',
      ci_net_metered: 'For net-metered C&I jobs the List-II requirement is handled by G5 (the exemption window), not by this gate.',
      open_access: 'For open-access jobs the List-II requirement is handled by G5 (the exemption window), not by this gate.',
    },
  },
  G5: {
    codes: 'annaann', applies: 'Jobs relying on the List-II exemption must be commissioned on or before 31-Dec-2026.',
    notes: {
      rwa_ghs: 'The exemption does not cover subsidy schemes; List-II cells are needed now (G4).',
      ci_captive: 'Captive behind-the-meter plants are outside the exemption logic.',
      pm_kusum: 'The exemption does not cover subsidy schemes; List-II cells are needed now (G4).',
      government_bid: 'Government rooftop jobs are governed by G4 and the unresolved bid-date carve-out (V-4), not by this exemption.',
    },
  },
  G6: { codes: 'aaaaaaa', applies: 'Modules and inverters need a valid BIS licence for the quoted model.' },
  G7: { codes: 'aaaaaaa', applies: 'Inverters above 200 kW may be self-certified only until the configured end date.' },
  G8: { codes: 'aaaaaaa', applies: 'Quote validity must not run past the price or duty horizon (price snapshot age, exemption date).' },
  G9: { codes: 'aaaaaaa', applies: 'Every line needs an HSN and a GST rate whose tax position a CA user has approved; inverter lines are mandatory while the inverter rule is conflicting.' },
  G10: { codes: 'aaaaaaa', applies: 'The ALMM snapshot behind every SKU must be recent.' },
  G11: {
    codes: 'aaaaaaw', applies: 'The dealer must be inside the credit limit and active on the PM Surya Ghar portal before a sales order is created.',
    notes: { government_bid: 'Institutional bids are often supplied without a dealer; shown as a warning.' },
  },
  G12: {
    codes: 'aawaaan', applies: 'Name on the DISCOM bill must match the applicant and there must be no pending dues.',
    notes: {
      ci_captive: 'Captive plants are not always billed to the applicant entity; shown as a warning.',
      government_bid: 'Tendered government sites are not checked against a consumer bill.',
    },
  },
  G13: {
    codes: 'annnnnn', applies: 'PM Surya Ghar CFA is capped at 3 kW; capacity above 3 kW earns no extra CFA.',
    notes: {
      rwa_ghs: 'RWA / GHS CFA is per kW up to 500 kW and 3 kW per household, not the 3 kW residential cap.',
      ci_captive: 'No CFA on captive C&I jobs.',
      ci_net_metered: 'No CFA on net-metered C&I jobs.',
      open_access: 'No CFA on open-access jobs.',
      pm_kusum: 'PM-KUSUM follows its own capacity rules, not the 3 kW residential cap.',
      government_bid: 'No CFA on government bids.',
    },
  },
  G14: { codes: 'aaaaaaa', applies: 'No Aadhaar number or image may be typed or uploaded anywhere (policy).' },
};

export function buildGateApplicability(env: SeedEnv): GateApplicability[] {
  const rows: GateApplicability[] = [];
  let n = 0;
  for (const gate of GATES) {
    const m = MATRIX[gate];
    SEGMENTS.forEach((segment, i) => {
      const code = (m.codes[i] ?? 'a') as Code;
      n += 1;
      rows.push({
        ...baseOf(env, refId('gate', n), 30 * 1440),
        gate, segment, applicability: FULL[code],
        note: code === 'a' ? m.applies : (m.notes?.[segment] ?? m.applies),
      });
    });
  }
  return rows;
}
