import type { RuleSeedInput } from './rules.types';

/**
 * Operational (non-regulatory) rule defaults needed by the sites / surveys / opportunities module.
 * The assembler merges these with the regulatory seed. Anything marked `unverified` is a management estimate or an
 * unconfirmed list: it is shown with an "unverified" badge in Admin → Rule Config and (when inactive) never changes behaviour.
 */
const OPERATING = 'Future Solar operating default';

export const rules_sites: RuleSeedInput[] = [
  {
    path: 'opportunity.indicative_rate_per_kw',
    value: 50000,
    source_name: OPERATING,
    source_ref: 'Management estimate for pipeline sizing only — not a quotation price',
    confidence: 'low',
    status: 'unverified',
    active: true,
    max_severity: 'info',
    notes: 'INDICATIVE rupees per kW used to estimate expected_value when a lead becomes an opportunity (kW × rate). Always labelled "indicative" in the UI; replaced by the real quote total once a quotation exists. Edit to match current market pricing.',
  },
  {
    path: 'opportunity.default_probability',
    value: { hot: 60, warm: 40, cold: 20 },
    source_name: OPERATING,
    source_ref: 'Sales management starting point',
    confidence: 'low',
    status: 'unverified',
    active: true,
    max_severity: 'info',
    notes: 'Starting win probability (%) by lead temperature when a lead is converted. The salesperson overrides it in step 20.',
  },
  {
    path: 'pmsg.special_category_states',
    value: [
      'Arunachal Pradesh', 'Assam', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Sikkim', 'Tripura',
      'Himachal Pradesh', 'Uttarakhand', 'Jammu and Kashmir', 'Ladakh', 'Andaman and Nicobar Islands', 'Lakshadweep',
    ],
    source_name: 'MNRE PM Surya Ghar guidelines — special category states (reading not confirmed)',
    source_ref: 'Verify against the current MNRE programme guideline before activating',
    confidence: 'low',
    status: 'unverified',
    active: false,
    max_severity: 'info',
    notes: 'States treated as "special category" for the higher residential CFA. INACTIVE until a compliance officer verifies the list: while inactive the site form only shows a hint and the flag must be set by hand (special_category_state override on the site). Verify against primary source before relying.',
  },
  {
    path: 'survey.max_photos',
    value: 10,
    source_name: OPERATING,
    source_ref: 'Storage and review workload',
    confidence: 'high',
    status: 'verified',
    active: true,
    max_severity: 'info',
    notes: 'Maximum number of photos kept on one site survey.',
  },
  {
    path: 'survey.reminder_hours_before',
    value: [24, 2],
    source_name: OPERATING,
    source_ref: 'Field operations',
    confidence: 'high',
    status: 'verified',
    active: true,
    max_severity: 'info',
    notes: 'Hours before a scheduled site visit at which the surveyor is reminded (one notification per entry).',
  },
  {
    path: 'survey.post_visit_followup_days',
    value: 2,
    source_name: OPERATING,
    source_ref: 'Sales process',
    confidence: 'high',
    status: 'verified',
    active: true,
    max_severity: 'info',
    notes: 'Days after a completed site visit by which the next follow-up (recommendation / rate discussion) is due.',
  },
  {
    path: 'site.name_match_min_score',
    value: 0.85,
    source_name: OPERATING,
    source_ref: 'Data-quality policy for gate G12',
    confidence: 'medium',
    status: 'verified',
    active: true,
    max_severity: 'info',
    notes: 'Minimum similarity (0–1) between the name on the DISCOM bill and the applicant name to count as a match. Lower values are more forgiving; a mismatch only raises a G12 warning.',
  },
];
