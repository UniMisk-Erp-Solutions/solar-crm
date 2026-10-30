// Zod schemas, response types and pure helpers for the commercial area:
// proforma invoice (PI), payments, credit checks / overrides, sales orders, serial-number dispatch and ERP export.
import { z } from 'zod';
import { PAYMENT_KINDS, PAYMENT_MODES } from '../enums';
import type { CustomerType, SkuCategory } from '../enums';
import type {
  Address, Approval, CreditCheck, CreditOverride, Dispatch, DispatchSerial, EinvoiceStatus, Finding, InvoiceChainLink, InventorySerial, Payment, PreFlightChecklist,
  ProformaInvoice, ProformaInvoiceLine, SalesOrder, SalesOrderLine, SerialSnapshot,
} from '../rows';
import { PINCODE_RE, addressSchema, gstinSchema, isGstin, isoDateSchema, isoDateTimeSchema, safeText, uuidSchema } from '../validators';

/* ───────────────────────── constants ───────────────────────── */

/** Stored in `proforma_invoices.gstin` when the bill-to customer is an unregistered individual (explicit flag, not a blank). */
export const GSTIN_UNREGISTERED = 'UNREGISTERED';
/** Customer types that may be billed without a GSTIN (individuals). Everyone else needs a valid GSTIN. */
export const UNREGISTERED_ALLOWED_CUSTOMER_TYPES: readonly CustomerType[] = ['residential', 'farmer'];
/** SKU categories whose units carry serial numbers (reserved FIFO from `inventory_serials`). Other lines ship in bulk with the first consignment. */
export const SERIAL_TRACKED_CATEGORIES: readonly SkuCategory[] = ['module', 'inverter', 'battery'];
export const isSerialTracked = (category: SkuCategory | null | undefined): boolean => !!category && SERIAL_TRACKED_CATEGORIES.includes(category);

export const PRE_PI_LABELS: Record<keyof PreFlightChecklist, string> = {
  legal_name: 'Customer legal name',
  billing_address: 'Billing address',
  shipping_address: 'Shipping address',
  gst: 'GST registration (valid GSTIN, or the "unregistered" flag for an individual)',
  product: 'Product description on every line',
  quantity: 'Quantity on every line',
  price: 'Unit price on every line',
  freight: 'Freight',
  payment_terms: 'Payment terms',
};
export const PRE_PI_KEYS = Object.keys(PRE_PI_LABELS) as (keyof PreFlightChecklist)[];

/* ───────────────────────── pre-PI checklist (pure) ───────────────────────── */

export interface PreFlightInput {
  legal_name: string | null | undefined;
  gstin: string | null | undefined;
  billing_address: Address | null | undefined;
  shipping_address: Address | null | undefined;
  payment_terms: string | null | undefined;
  freight: number | null | undefined;
  customer_type: CustomerType | null | undefined;
  lines: { description: string | null | undefined; qty: number; unit_price: number }[];
}

export function addressComplete(a: Address | null | undefined): boolean {
  return !!a && !!a.line1?.trim() && !!a.city?.trim() && !!a.state?.trim() && PINCODE_RE.test(a.pincode ?? '');
}

/** The nine items of the "work instruction before PI" (step 28). Every item must be true before a PI can be issued. */
export function evaluatePreFlight(i: PreFlightInput): { checklist: PreFlightChecklist; missing: (keyof PreFlightChecklist)[]; complete: boolean } {
  const gst = i.gstin === GSTIN_UNREGISTERED
    ? !!i.customer_type && UNREGISTERED_ALLOWED_CUSTOMER_TYPES.includes(i.customer_type)
    : !!i.gstin && isGstin(i.gstin);
  const checklist: PreFlightChecklist = {
    legal_name: !!i.legal_name?.trim(),
    billing_address: addressComplete(i.billing_address),
    shipping_address: addressComplete(i.shipping_address),
    gst,
    product: i.lines.length > 0 && i.lines.every((l) => !!l.description?.trim()),
    quantity: i.lines.length > 0 && i.lines.every((l) => Number.isFinite(l.qty) && l.qty > 0),
    price: i.lines.length > 0 && i.lines.every((l) => Number.isFinite(l.unit_price) && l.unit_price > 0),
    freight: typeof i.freight === 'number' && Number.isFinite(i.freight) && i.freight >= 0,
    payment_terms: !!i.payment_terms?.trim(),
  };
  const missing = PRE_PI_KEYS.filter((k) => !checklist[k]);
  return { checklist, missing, complete: missing.length === 0 };
}

/* ───────────────────────── request schemas ───────────────────────── */

const requiredText = (max: number) => safeText(max).refine((v) => v.length > 0, { message: 'This field is required' });

const piDetailShape = {
  legal_name: requiredText(200).optional(),
  gstin: gstinSchema.optional(),
  /** true = the bill-to customer is an unregistered individual (stores GSTIN "UNREGISTERED"); false clears the flag */
  gst_unregistered: z.boolean().optional(),
  billing_address: addressSchema.optional(),
  shipping_address: addressSchema.optional(),
  payment_terms: requiredText(500).optional(),
  freight: z.number().min(0).max(100_000_000).optional(),
};
const gstConflict = (v: { gstin?: string; gst_unregistered?: boolean }, ctx: z.RefinementCtx) => {
  if (v.gst_unregistered && v.gstin) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['gstin'], message: 'Remove the GSTIN or clear the "unregistered" flag' });
};

/** POST /pis — body is `quote_id` plus optional overrides of what the quote/customer already carry. */
export const createPiSchema = z.object({ quote_id: uuidSchema, ...piDetailShape }).superRefine(gstConflict);
/** PATCH /pis/:id (draft only). */
export const updatePiSchema = z.object(piDetailShape).superRefine(gstConflict).refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type CreatePiInput = z.infer<typeof createPiSchema>;
export type UpdatePiInput = z.infer<typeof updatePiSchema>;

export const recordPaymentSchema = z.object({
  kind: z.enum(PAYMENT_KINDS).default('advance'),
  amount: z.number().positive().max(10_000_000_000),
  mode: z.enum(PAYMENT_MODES),
  /** UTR / cheque / transaction reference */
  reference: safeText(120).optional(),
  received_at: isoDateTimeSchema.optional(),
  status: z.enum(['received', 'pending']).default('received'),
});
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

export const updatePaymentSchema = z.object({
  status: z.enum(['received', 'pending', 'bounced']).optional(),
  reference: safeText(120).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const runCreditCheckSchema = z.object({ basis: z.enum(['advance', 'credit']) });
export const decideCreditCheckSchema = z.object({ result: z.enum(['approved', 'rejected']), notes: safeText(1000).optional() })
  .refine((v) => v.result === 'approved' || !!v.notes, { path: ['notes'], message: 'Give a reason when rejecting' });

export const createCreditOverrideSchema = z.object({
  dealer_id: uuidSchema,
  pi_id: uuidSchema,
  reason: safeText(1000).refine((v) => v.length >= 10, { message: 'Give a reason of at least 10 characters' }),
});

export const createSalesOrderSchema = z.object({
  pi_id: uuidSchema,
  customer_po_no: requiredText(100),
  customer_po_date: isoDateSchema,
  /** a `documents` row uploaded via /documents (customer PO file) */
  po_document_id: uuidSchema.optional(),
});
export type CreateSalesOrderInput = z.infer<typeof createSalesOrderSchema>;
export const noteSchema = z.object({ note: safeText(1000).optional() }).default({});

const plannedAt = z.union([isoDateTimeSchema, isoDateSchema]);
export const createDispatchSchema = z.object({
  so_id: uuidSchema,
  planned_at: plannedAt.optional(),
  lines: z.array(z.object({
    so_line_id: uuidSchema,
    /** quantity to reserve FIFO by batch; optional when `serial_ids` is given */
    qty: z.number().int().positive().max(100_000).optional(),
    /** explicit serials instead of FIFO */
    serial_ids: z.array(uuidSchema).min(1).max(5000).optional(),
  }).refine((l) => l.qty !== undefined || !!l.serial_ids, { message: 'Give a quantity or explicit serial ids' })).max(200),
  vehicle_no: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{6,15}$/, 'Enter a valid vehicle number').optional(),
  transporter: safeText(120).optional(),
});

export const editDispatchSerialsSchema = z.object({
  add: z.array(z.object({ serial_id: uuidSchema, so_line_id: uuidSchema.optional() })).max(500).optional(),
  remove: z.array(uuidSchema).max(500).optional(),
  replace: z.array(z.object({ old_serial_id: uuidSchema, new_serial_id: uuidSchema })).max(500).optional(),
}).refine((v) => !!(v.add?.length || v.remove?.length || v.replace?.length), { message: 'Nothing to change' });

export const dispatchActionSchema = z.object({
  vehicle_no: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{6,15}$/, 'Enter a valid vehicle number').optional(),
  transporter: safeText(120).optional(),
  /** brand invoice number; generated (FS/INV/yy/nnnn) when omitted */
  invoice_no: safeText(40).refine((v) => v.length > 0, { message: 'This field is required' }).optional(),
  /** invoice numbers of the downstream hops of the chain (brand → distributor is the dispatch invoice itself) */
  chain_invoices: z.object({ dealer: safeText(40).optional(), site: safeText(40).optional() }).optional(),
});

export const invoiceChainSchema = z.object({
  distributor_to_dealer: safeText(40).optional(),
  dealer_to_site: safeText(40).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

/** PATCH /dispatches/:id/einvoice — manual entry when the provider cannot generate. e-invoice group and/or e-way bill. */
export const manualEinvoiceSchema = z.object({
  irn: z.string().trim().regex(/^[A-Fa-f0-9]{64}$/, 'An IRN is 64 hexadecimal characters').optional(),
  ack_no: z.string().trim().regex(/^\d{1,20}$/, 'Acknowledgement number is numeric').optional(),
  ack_date: z.union([isoDateTimeSchema, isoDateSchema]).optional(),
  /** 12 digits. May be sent as a JSON string or number: the edge Aadhaar guard (G14) matches any Verhoeff-valid 12-digit STRING, so a number avoids that false positive. */
  ewb_no: z.union([z.string().trim(), z.number().int().positive()]).transform((v) => String(v)).pipe(z.string().regex(/^\d{12}$/, 'An e-way bill number is 12 digits')).optional(),
}).refine((v) => !!(v.irn || v.ewb_no), { message: 'Give an IRN (with acknowledgement) and/or an e-way bill number' })
  .refine((v) => !v.irn || (!!v.ack_no && !!v.ack_date), { path: ['ack_no'], message: 'Acknowledgement number and date are required with the IRN' });

export const dispatchComplianceOverrideSchema = z.object({ reason: safeText(1000).refine((v) => v.length >= 10, { message: 'Give a reason of at least 10 characters' }) });

export type CreateDispatchInput = z.infer<typeof createDispatchSchema>;
export type EditDispatchSerialsInput = z.infer<typeof editDispatchSerialsSchema>;
export type DispatchActionInput = z.infer<typeof dispatchActionSchema>;
export type InvoiceChainInput = z.infer<typeof invoiceChainSchema>;
export type ManualEinvoiceInput = z.infer<typeof manualEinvoiceSchema>;

export const ERP_DOCS = ['pi', 'so', 'invoice'] as const;
export const ERP_LAYOUTS = ['tally', 'sap'] as const;
export const ERP_FORMATS = ['csv', 'xlsx'] as const;
export type ErpDoc = (typeof ERP_DOCS)[number];
export type ErpLayout = (typeof ERP_LAYOUTS)[number];
export type ErpFormat = (typeof ERP_FORMATS)[number];
export const erpExportQuerySchema = z.object({
  doc: z.enum(ERP_DOCS),
  layout: z.enum(ERP_LAYOUTS).default('tally'),
  format: z.enum(ERP_FORMATS).default('csv'),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

/* ───────────────────────── response types ───────────────────────── */

export interface PreFlightResult {
  quote_id: string; quote_no: string; quote_status: string; accepted: boolean; pi_id: string | null;
  checklist: PreFlightChecklist; missing: (keyof PreFlightChecklist)[]; missing_labels: string[]; complete: boolean;
  /** what the PI would be created with (quote + customer); override any of it in POST /pis */
  defaults: {
    legal_name: string | null; gstin: string | null; billing_address: Address | null; shipping_address: Address | null; payment_terms: string | null; freight: number;
    customer_type: CustomerType | null; unregistered_allowed: boolean;
  };
}

export interface PiSummary extends ProformaInvoice { quote_no: string | null; dealer_name: string | null; paid_amount: number; balance: number }
export interface PiDetail extends PiSummary {
  lines: ProformaInvoiceLine[]; payments: Payment[]; advance_pct: number; required_advance: number; advance_ok: boolean;
  credit_checks: CreditCheck[]; credit_check: CreditCheck | null; credit_overrides: CreditOverride[]; approvals: Approval[]; sales_order: SalesOrder | null;
  missing_labels: string[]; unregistered: boolean;
}

export interface CreditGuardResult {
  gate: 'G11'; blocked: boolean; reasons: string[]; warnings: string[];
  order_total: number; advance_received: number; outstanding: number; exposure_after: number; credit_limit: number; portal_status: string | null; override_id: string | null;
}
export interface CreditCheckDetail extends CreditCheck {
  pi_no: string | null; dealer_name: string | null; pi_total: number | null; advance_received: number; required_advance: number; exposure_after: number | null; guard: CreditGuardResult | null;
}

export interface SalesOrderLineDetail extends SalesOrderLine { remaining_qty: number; reserved_qty: number; serial_tracked: boolean }
export interface SalesOrderSummary extends SalesOrder { pi_no: string | null; dealer_name: string | null; customer_name: string | null }
export interface SalesOrderDetail extends SalesOrderSummary {
  lines: SalesOrderLineDetail[]; pi: ProformaInvoice | null; payments: Payment[]; approvals: Approval[]; credit_checks: CreditCheck[];
  dispatches: (Dispatch & { serial_count: number })[]; installation_id: string | null;
  compliance_snapshot: {
    quote: { quote_id: string; status: string; evaluated_at: string | null; findings: Finding[] } | null;
    dispatches: { dispatch_id: string; dispatch_no: string; status: string; compliance_status: string; findings: Finding[] }[];
  };
  warnings: string[];
}

export interface SerialComplianceDetail { compliant: boolean; applicable: boolean; missing: string[] }
export interface DispatchSerialDetail extends DispatchSerial {
  serial: string; sku_id: string; sku_label: string; category: SkuCategory | null; batch_id: string | null; batch_no: string | null; received_at: string | null;
  status: InventorySerial['status']; compliance_snapshot: SerialSnapshot; invoice_chain: InvoiceChainLink[]; compliance: SerialComplianceDetail;
}
export interface DispatchDetail extends Dispatch {
  so_no: string; segment: string; so_status: string;
  serials: DispatchSerialDetail[];
  lines: { so_line_id: string; description: string; serial_tracked: boolean; qty_ordered: number; qty_dispatched: number; qty_in_this_dispatch: number }[];
  einvoice: EinvoiceStatus | null;
  hard_stops: Finding[];
  override: { approved: boolean; approval_ids: string[]; pending: boolean };
}
