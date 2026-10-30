import type { SkuCategory } from '@solar/shared';
import type { EvalLine } from './types';

/** rule path that governs the GST rate of a SKU category. Categories without a rule (cable, other, free-form lines) never get a silently applied rate. */
export const GST_RULE_PATH: Partial<Record<SkuCategory, string>> = {
  module: 'gst.modules_cells_rate',
  inverter: 'gst.inverter_rate',
  structure: 'gst.structures_rate',
  battery: 'gst.batteries_rate',
};

const BUNDLE_RE = /\b(bundle|bundled|kit|turnkey|complete system|works contract|epc)\b/i;

/** A bundled / works-contract line mixes goods with services, so its tax position must be decided by a CA-type user. */
export const isBundledLine = (l: { sku: { category: SkuCategory } | null; description: string }): boolean =>
  (!l.sku || l.sku.category === 'other') && BUNDLE_RE.test(l.description);

/** Tax position must be approved by a CA-type user for inverters and bundled lines. */
export const requiresTaxApproval = (l: Pick<EvalLine, 'sku' | 'description'>): boolean => l.sku?.category === 'inverter' || isBundledLine(l);
