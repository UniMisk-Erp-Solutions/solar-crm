import { GATES, SEGMENTS, type Applicability, type Gate, type Segment } from '@solar/shared';
import type { AppContext } from '../../auth/context';

/**
 * Fallback gate × segment matrix, used for every cell that has no row in `gate_applicability` (it mirrors the seeded matrix).
 * One letter per segment in SEGMENTS order: pmsg_residential, rwa_ghs, ci_captive, ci_net_metered, open_access, pm_kusum, government_bid.
 *   A = applies · N = not applies (skip, info finding) · W = evaluate but cap the severity at warning.
 *
 * Reading of the matrix (prompt.md §7, blueprint §3.2, Appendix A):
 *  - G2 DCR: subsidy schemes (PMSG, RWA/GHS, KUSUM); government jobs are warning-only (tender conditions decide).
 *  - G3 List-I: every segment; captive behind-the-meter is warning-only (exemption definition unverified).
 *  - G4 List-II: subsidy and government jobs; for net-metered / open-access the List-II cliff is gate G5.
 *  - G5 exemption date: net-metered and open-access (and PMSG residential, where the flag is never set).
 *  - G13 system size: PMSG residential only.
 */
const MATRIX: Record<Gate, string> = {
  G1: 'AAAAAAA', G2: 'AANNNAW', G3: 'AAWAAAA', G4: 'AAWNNAA', G5: 'ANNAANN', G6: 'AAAAAAA', G7: 'AAAAAAA',
  G8: 'AAAAAAA', G9: 'AAAAAAA', G10: 'AAAAAAA', G11: 'AAAAAAW', G12: 'AAWAAAN', G13: 'ANNNNNN', G14: 'AAAAAAA',
};
const LETTER: Record<string, Applicability> = { A: 'applies', N: 'not_applies', W: 'warning' };

export interface ApplicabilityCell { applicability: Applicability; note: string | null; source: 'default' | 'table' }
export type ApplicabilityMatrix = Record<Gate, Record<Segment, ApplicabilityCell>>;

export function defaultMatrix(): ApplicabilityMatrix {
  const out = {} as ApplicabilityMatrix;
  for (const g of GATES) {
    out[g] = {} as Record<Segment, ApplicabilityCell>;
    SEGMENTS.forEach((s, i) => { out[g][s] = { applicability: LETTER[MATRIX[g][i] ?? 'A'] ?? 'applies', note: null, source: 'default' }; });
  }
  return out;
}

/** The effective matrix: `gate_applicability` rows (edited by a compliance officer in Admin) over the documented defaults. */
export async function loadApplicability(ctx: AppContext): Promise<ApplicabilityMatrix> {
  const m = defaultMatrix();
  const rows = await ctx.db.table('gate_applicability').all();
  for (const r of rows) {
    if (m[r.gate]?.[r.segment]) m[r.gate][r.segment] = { applicability: r.applicability, note: r.note, source: 'table' };
  }
  return m;
}
