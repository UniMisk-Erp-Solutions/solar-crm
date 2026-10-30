/**
 * Stage 5 and serial dispatch: /pis, /payments, /credit-checks, /credit-position, /credit-overrides, /sales-orders, /dispatches, /exports/erp
 * (+ GET /quotes/:id/pre-pi-checklist). Routes stay thin: parse -> authorise -> service. Reference: docs/api/orders.md
 */
import { Router, type Response } from 'express';
import {
  type CreditCheck, type CreditOverride, type Dispatch, type Payment, type ProformaInvoice, type SalesOrder,
  createCreditOverrideSchema, createDispatchSchema, createPiSchema, createSalesOrderSchema, decideCreditCheckSchema, dispatchActionSchema, dispatchComplianceOverrideSchema, editDispatchSerialsSchema,
  erpExportQuerySchema, invoiceChainSchema, manualEinvoiceSchema, noteSchema, recordPaymentSchema, runCreditCheckSchema, updatePaymentSchema, updatePiSchema, type AppRole,
} from '@solar/shared';
import { ALL_ROLES, allow } from '../auth/authorize';
import { runList } from '../http/crud';
import { body, handle, param, query as parseQuery, respondPage, wrap } from '../http/handler';
import { creditCheckDetail, creditOverrideDetail, creditPosition, decideCreditCheck, hydrateCreditChecks, requestCreditOverride, runCreditCheck } from '../services/creditService';
import {
  cancelDispatch, createDispatch, dispatchDetail, dispatchNote, dispatchNow, dispatchVisibility, editDispatchSerials, evaluateDispatch, hydrateDispatches, manualEinvoice, requestComplianceOverride,
  updateInvoiceChain,
} from '../services/dispatchService';
import { exportErp } from '../services/erpExport';
import { hydratePayments, recordPayment, updatePayment } from '../services/paymentService';
import { cancelPi, createPi, hydratePis, piDetail, piPdf, preFlightForQuote, submitPi, updatePi } from '../services/piService';
import { cancelSalesOrder, createSalesOrder, handoverSalesOrder, hydrateSalesOrders, releaseHold, salesOrderDetail } from '../services/salesOrderService';

const router = Router();

/** Accounts / Management / Sales Manager run PI, payment, credit and sales-order work (admin is always allowed). */
const COMMERCIAL: AppRole[] = ['accounts', 'management', 'sales_manager'];
const CREDIT_DECIDERS: AppRole[] = ['accounts', 'management'];
const FINANCE_READ: AppRole[] = ['accounts', 'management', 'sales_manager', 'regional_head'];
const DISPATCH_ROLES: AppRole[] = ['dispatch', 'management', 'sales_manager'];
const EINVOICE_ROLES: AppRole[] = ['dispatch', 'accounts', 'management', 'sales_manager'];

const created = (res: Response, data: unknown): undefined => { res.status(201).json({ data }); return undefined; };

/* ───────────── pre-PI checklist ───────────── */
router.get('/quotes/:id/pre-pi-checklist', allow(...ALL_ROLES), handle((ctx, req) => preFlightForQuote(ctx, param(req, 'id'))));

/* ───────────── proforma invoices ───────────── */
router.get('/pis', allow(...ALL_ROLES), wrap(async (req, res) => {
  const ctx = req.ctx!;
  const page = await runList<ProformaInvoice>(ctx, req, {
    table: 'proforma_invoices', searchCols: ['pi_no', 'legal_name'], filterCols: ['status', 'dealer_id', 'distributor_id', 'quote_id', 'customer_id', 'issue_date', 'valid_till'], defaultSort: { col: 'created_at', dir: 'desc' },
  });
  respondPage(res, await hydratePis(ctx, page.rows), page.total, page.limit, page.offset);
}));
router.get('/pis/:id', allow(...ALL_ROLES), handle((ctx, req) => piDetail(ctx, param(req, 'id'))));
router.post('/pis', allow(...COMMERCIAL), handle(async (ctx, req, res) => created(res, await createPi(ctx, body(createPiSchema, req)))));
router.patch('/pis/:id', allow(...COMMERCIAL), handle((ctx, req) => updatePi(ctx, param(req, 'id'), body(updatePiSchema, req))));
router.post('/pis/:id/submit', allow(...COMMERCIAL), handle((ctx, req) => submitPi(ctx, param(req, 'id'))));
router.post('/pis/:id/cancel', allow(...COMMERCIAL), handle((ctx, req) => cancelPi(ctx, param(req, 'id'), body(noteSchema, req).note)));
router.get('/pis/:id/pdf', allow(...ALL_ROLES), handle(async (ctx, req, res) => {
  const pdf = await piPdf(ctx, param(req, 'id'), { refresh: req.query['refresh'] === '1' });
  if (req.query['inline'] === '1') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${pdf.file_name}"`);
    res.send(pdf.content);
    return undefined;
  }
  return { document_id: pdf.document_id, file_name: pdf.file_name, url: pdf.url, expires_at: pdf.expires_at };
}));

/* ───────────── payments ───────────── */
router.post('/pis/:id/payments', allow(...COMMERCIAL), handle(async (ctx, req, res) => created(res, await recordPayment(ctx, param(req, 'id'), body(recordPaymentSchema, req)))));
router.get('/payments', allow(...FINANCE_READ), wrap(async (req, res) => {
  const ctx = req.ctx!;
  const page = await runList<Payment>(ctx, req, { table: 'payments', unscoped: true, searchCols: ['reference'], filterCols: ['pi_id', 'sales_order_id', 'kind', 'status', 'mode', 'received_at'], defaultSort: { col: 'received_at', dir: 'desc' } });
  respondPage(res, await hydratePayments(ctx, page.rows), page.total, page.limit, page.offset);
}));
router.patch('/payments/:id', allow(...COMMERCIAL), handle((ctx, req) => updatePayment(ctx, param(req, 'id'), body(updatePaymentSchema, req))));

/* ───────────── credit checks, position, overrides ───────────── */
router.post('/pis/:id/credit-check', allow(...COMMERCIAL), handle(async (ctx, req, res) => created(res, await runCreditCheck(ctx, param(req, 'id'), body(runCreditCheckSchema, req).basis))));
router.get('/credit-checks', allow(...ALL_ROLES), wrap(async (req, res) => {
  const ctx = req.ctx!;
  const page = await runList<CreditCheck>(ctx, req, { table: 'credit_checks', filterCols: ['result', 'basis', 'pi_id', 'sales_order_id', 'dealer_id', 'distributor_id'], defaultSort: { col: 'created_at', dir: 'desc' } });
  respondPage(res, await hydrateCreditChecks(ctx, page.rows), page.total, page.limit, page.offset);
}));
router.get('/credit-checks/:id', allow(...ALL_ROLES), handle((ctx, req) => creditCheckDetail(ctx, param(req, 'id'))));
router.post('/credit-checks/:id/decide', allow(...CREDIT_DECIDERS), handle((ctx, req) => decideCreditCheck(ctx, param(req, 'id'), body(decideCreditCheckSchema, req))));
router.get('/credit-position/:dealerId', allow(...ALL_ROLES), handle((ctx, req) => creditPosition(ctx, param(req, 'dealerId'))));

router.post('/credit-overrides', allow(...COMMERCIAL), handle(async (ctx, req, res) => created(res, await requestCreditOverride(ctx, body(createCreditOverrideSchema, req)))));
router.get('/credit-overrides', allow(...FINANCE_READ), wrap(async (req, res) => {
  const ctx = req.ctx!;
  const page = await runList<CreditOverride>(ctx, req, { table: 'credit_overrides', unscoped: true, searchCols: ['reason'], filterCols: ['status', 'dealer_id', 'pi_id', 'sales_order_id'], defaultSort: { col: 'created_at', dir: 'desc' } });
  respondPage(res, page.rows, page.total, page.limit, page.offset);
}));
router.get('/credit-overrides/:id', allow(...FINANCE_READ), handle((ctx, req) => creditOverrideDetail(ctx, param(req, 'id'))));

/* ───────────── sales orders ───────────── */
router.get('/sales-orders', allow(...ALL_ROLES), wrap(async (req, res) => {
  const ctx = req.ctx!;
  const page = await runList<SalesOrder>(ctx, req, {
    table: 'sales_orders', searchCols: ['so_no', 'customer_po_no'], filterCols: ['status', 'dealer_id', 'distributor_id', 'segment', 'pi_id', 'customer_id', 'order_date'], defaultSort: { col: 'created_at', dir: 'desc' },
  });
  respondPage(res, await hydrateSalesOrders(ctx, page.rows), page.total, page.limit, page.offset);
}));
router.get('/sales-orders/:id', allow(...ALL_ROLES), handle((ctx, req) => salesOrderDetail(ctx, param(req, 'id'))));
router.post('/sales-orders', allow(...COMMERCIAL), handle(async (ctx, req, res) => created(res, await createSalesOrder(ctx, body(createSalesOrderSchema, req)))));
router.post('/sales-orders/:id/release-hold', allow(...COMMERCIAL), handle((ctx, req) => releaseHold(ctx, param(req, 'id'), { note: body(noteSchema, req).note })));
router.post('/sales-orders/:id/handover', allow(...COMMERCIAL), handle((ctx, req) => handoverSalesOrder(ctx, param(req, 'id'), body(noteSchema, req).note)));
router.post('/sales-orders/:id/cancel', allow(...COMMERCIAL), handle((ctx, req) => cancelSalesOrder(ctx, param(req, 'id'), body(noteSchema, req).note)));

/* ───────────── dispatches ───────────── */
router.get('/dispatches', allow(...ALL_ROLES), wrap(async (req, res) => {
  const ctx = req.ctx!;
  const visible = await dispatchVisibility(ctx);
  const page = await runList<Dispatch>(ctx, req, {
    table: 'dispatches', unscoped: true, baseWhere: visible ? { so_id: visible } : {}, searchCols: ['dispatch_no', 'invoice_no', 'vehicle_no'],
    filterCols: ['status', 'so_id', 'compliance_status', 'ewb_status'], defaultSort: { col: 'created_at', dir: 'desc' },
  });
  respondPage(res, await hydrateDispatches(ctx, page.rows), page.total, page.limit, page.offset);
}));
router.get('/dispatches/:id', allow(...ALL_ROLES), handle((ctx, req) => dispatchDetail(ctx, param(req, 'id'))));
router.post('/dispatches', allow(...DISPATCH_ROLES), handle(async (ctx, req, res) => created(res, await createDispatch(ctx, body(createDispatchSchema, req)))));
router.post('/dispatches/:id/evaluate', allow(...DISPATCH_ROLES), handle((ctx, req) => evaluateDispatch(ctx, param(req, 'id'))));
router.post('/dispatches/:id/serials', allow(...DISPATCH_ROLES), handle((ctx, req) => editDispatchSerials(ctx, param(req, 'id'), body(editDispatchSerialsSchema, req))));
router.post('/dispatches/:id/dispatch', allow(...DISPATCH_ROLES), handle((ctx, req) => dispatchNow(ctx, param(req, 'id'), body(dispatchActionSchema, req))));
router.post('/dispatches/:id/cancel', allow(...DISPATCH_ROLES), handle((ctx, req) => cancelDispatch(ctx, param(req, 'id'), body(noteSchema, req).note)));
router.post('/dispatches/:id/compliance-override', allow(...DISPATCH_ROLES), handle(async (ctx, req, res) => created(res, await requestComplianceOverride(ctx, param(req, 'id'), body(dispatchComplianceOverrideSchema, req).reason))));
router.patch('/dispatches/:id/einvoice', allow(...EINVOICE_ROLES), handle((ctx, req) => manualEinvoice(ctx, param(req, 'id'), body(manualEinvoiceSchema, req))));
router.patch('/dispatches/:id/invoice-chain', allow(...EINVOICE_ROLES), handle((ctx, req) => updateInvoiceChain(ctx, param(req, 'id'), body(invoiceChainSchema, req))));
router.get('/dispatches/:id/note', allow(...ALL_ROLES), handle(async (ctx, req, res) => {
  const note = await dispatchNote(ctx, param(req, 'id'));
  if (req.query['inline'] === '1') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${note.file_name}"`);
    res.send(note.content);
    return undefined;
  }
  return { document_id: note.document_id, file_name: note.file_name, url: note.url, expires_at: note.expires_at };
}));

/* ───────────── ERP export ───────────── */
router.get('/exports/erp', allow(...COMMERCIAL), handle(async (ctx, req, res) => {
  const out = await exportErp(ctx, parseQuery(erpExportQuerySchema, req));
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('X-Export-Rows', String(out.rows));
  res.send(out.body);
  return undefined;
}));

export default router;
