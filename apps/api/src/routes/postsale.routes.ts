/**
 * Post-sale routes (mounted under /api/v1): installations, DISCOM applications, subsidy claims, loans, warranty / RMA tickets,
 * dealer receivables and the post-sale board. Reference: docs/api/postsale-channel.md
 */
import { Router, type RequestHandler } from 'express';
import {
  discomAgeingQuerySchema, discomApplicationCreateSchema, discomApplicationUpdateSchema, installationCertificateSchema, installationCommissionSchema, installationCreateSchema,
  installationPhotoMetaSchema, installationUpdateSchema, loanCreateSchema, loanSummaryQuerySchema, loanUpdateSchema, omRegisterQuerySchema, receivableCreateSchema, receivableUpdateSchema,
  stateShareAgeingQuerySchema, subsidyClaimCreateSchema, subsidyClaimSubmitSchema, subsidyClaimUpdateSchema, subsidyDiscomApprovalSchema, subsidyGrievanceSchema, subsidyRejectSchema,
  subsidyReleaseSchema, subsidyStateShareSchema, subsidyWorklistQuerySchema, warrantyTicketCreateSchema, warrantyTicketUpdateSchema,
} from '@solar/shared';
import { assertCanRead } from '../auth/access';
import { allow } from '../auth/authorize';
import type { Config } from '../config';
import { crudRouter, runList } from '../http/crud';
import { notFound } from '../http/errors';
import { body, handle, param, query, respondPage, wrap } from '../http/handler';
import { filesOf, uploader } from '../http/upload';
import {
  certifyInstallation, commissionInstallation, createDiscomApplication, discomStageAgeing, hydrateDiscomApplications, updateDiscomApplication,
} from '../services/discomService';
import { addInstallationPhotos, createInstallation, hydrateInstallations, omRegister, updateInstallationFields } from '../services/installationService';
import { afterLoanWrite, hydrateLoans, loanSummary, prepareLoanCreate, prepareLoanUpdate } from '../services/loanService';
import { CHANNEL_ADMIN_ROLES, POSTSALE_WRITE_ROLES } from '../services/postsaleShared';
import { postSaleBoard } from '../services/postsaleBoard';
import { hydrateReceivables, prepareReceivableCreate, prepareReceivableUpdate } from '../services/receivableService';
import {
  createSubsidyClaim, hydrateSubsidyClaims, raiseGrievance, recordDiscomApproval, recordStateShare, rejectClaim, releaseClaim, reopenClaim, resolveGrievance, stateShareAgeing,
  submitClaim, subsidyWorklist, updateSubsidyClaim,
} from '../services/subsidyService';
import { createWarrantyTicket, hydrateWarrantyTickets, updateWarrantyTicket } from '../services/warrantyService';

const router = Router();

const LOAN_WRITE_ROLES = [...CHANNEL_ADMIN_ROLES, 'techno_commercial', 'distributor_user', 'dealer_user'] as const;
const write = allow(...POSTSALE_WRITE_ROLES);

/** multer built lazily from the request's config (the router is created before any config exists). */
const photoUploaders = new WeakMap<Config, ReturnType<typeof uploader>>();
const photoUpload: RequestHandler = (req, res, next) => {
  const cfg = req.ctx!.config;
  let u = photoUploaders.get(cfg);
  if (!u) { u = uploader(cfg); photoUploaders.set(cfg, u); }
  u.array('photos', 10)(req, res, next);
};

/* ───────────────────────── installations ───────────────────────── */
router.get('/installations/om-register', wrap(async (req, res) => { res.json(await omRegister(req.ctx!, query(omRegisterQuerySchema, req))); }));

router.get('/installations', wrap(async (req, res) => {
  const ctx = req.ctx!;
  const page = await runList(ctx, req, {
    table: 'installations', searchCols: ['installer_name', 'regulation_version'],
    filterCols: ['status', 'dealer_id', 'distributor_id', 'sales_order_id', 'site_id', 'customer_id', 'vendor_registration_id', 'agreement_status', 'no_connectivity_agreement', 'install_date', 'certificate_at', 'commissioned_at', 'om_end', 'kw'],
    defaultSort: { col: 'created_at', dir: 'desc' },
  });
  respondPage(res, await hydrateInstallations(ctx, page.rows as never), page.total, page.limit, page.offset);
}));

router.get('/installations/:id', handle(async (ctx, req) => {
  const row = await ctx.db.table('installations').get(param(req, 'id'));
  if (!row) throw notFound('Installation');
  await assertCanRead(ctx, 'installations', row);
  return (await hydrateInstallations(ctx, [row]))[0];
}));

router.post('/installations', write, handle(async (ctx, req, res) => {
  const row = await createInstallation(ctx, body(installationCreateSchema, req));
  res.status(201);
  return { ...(await hydrateInstallations(ctx, [row]))[0], warnings: row.warnings };
}));

router.patch('/installations/:id', write, handle(async (ctx, req) => {
  const id = param(req, 'id');
  const { certificate_at, commissioned_at, ...fields } = body(installationUpdateSchema, req);
  const warnings: string[] = [];
  if (Object.keys(fields).length) await updateInstallationFields(ctx, id, fields);
  if (certificate_at) warnings.push(...(await certifyInstallation(ctx, id, certificate_at)).warnings);
  if (commissioned_at) warnings.push(...(await commissionInstallation(ctx, id, { commissioned_at })).warnings);
  const row = await ctx.db.table('installations').getOrThrow(id);
  return { ...(await hydrateInstallations(ctx, [row]))[0], warnings };
}));

router.post('/installations/:id/certificate', write, handle(async (ctx, req) => {
  const { certificate_at } = body(installationCertificateSchema, req);
  const res = await certifyInstallation(ctx, param(req, 'id'), certificate_at);
  return { installation: (await hydrateInstallations(ctx, [res.installation]))[0], discom_application: res.discom_application, warnings: res.warnings };
}));

router.post('/installations/:id/commission', write, handle(async (ctx, req) => {
  const res = await commissionInstallation(ctx, param(req, 'id'), body(installationCommissionSchema, req));
  return { installation: (await hydrateInstallations(ctx, [res.installation]))[0], discom_application: res.discom_application, serials_installed: res.serials_installed, receivables_closed: res.receivables_closed, warnings: res.warnings };
}));

router.post('/installations/:id/photos', write, photoUpload, handle(async (ctx, req, res) => {
  const meta = body(installationPhotoMetaSchema, req);
  const out = await addInstallationPhotos(ctx, param(req, 'id'), filesOf(req), meta);
  res.status(201);
  return out;
}));

/* ───────────────────────── DISCOM applications ───────────────────────── */
router.get('/discom-applications/ageing', handle((ctx, req) => discomStageAgeing(ctx, query(discomAgeingQuerySchema, req))));

router.get('/discom-applications', wrap(async (req, res) => {
  const ctx = req.ctx!;
  const page = await runList(ctx, req, {
    table: 'discom_applications', searchCols: ['application_no', 'meter_type'],
    filterCols: ['discom_id', 'dealer_id', 'distributor_id', 'sales_order_id', 'installation_id', 'site_id', 'customer_id', 'feasibility_status', 'agreement_status', 'deemed_breach', 'regulation_version', 'submitted_at', 'complete_at', 'certificate_submitted_at', 'commissioning_due_at', 'commissioning_at', 'inspection_at', 'meter_at', 'applied_kw'],
    defaultSort: { col: 'created_at', dir: 'desc' },
  });
  respondPage(res, await hydrateDiscomApplications(ctx, page.rows as never), page.total, page.limit, page.offset);
}));

router.get('/discom-applications/:id', handle(async (ctx, req) => {
  const row = await ctx.db.table('discom_applications').get(param(req, 'id'));
  if (!row) throw notFound('DISCOM application');
  await assertCanRead(ctx, 'discom_applications', row);
  return (await hydrateDiscomApplications(ctx, [row]))[0];
}));

router.post('/discom-applications', write, handle(async (ctx, req, res) => {
  const row = await createDiscomApplication(ctx, body(discomApplicationCreateSchema, req));
  res.status(201);
  return { ...(await hydrateDiscomApplications(ctx, [row]))[0], warnings: row.warnings };
}));

router.patch('/discom-applications/:id', write, handle(async (ctx, req) => {
  const row = await updateDiscomApplication(ctx, param(req, 'id'), body(discomApplicationUpdateSchema, req));
  return { ...(await hydrateDiscomApplications(ctx, [row]))[0], warnings: row.warnings };
}));

/* ───────────────────────── subsidy claims ───────────────────────── */
router.get('/subsidy-claims/worklist', wrap(async (req, res) => { res.json(await subsidyWorklist(req.ctx!, query(subsidyWorklistQuerySchema, req))); }));
router.get('/subsidy-claims/state-share-ageing', wrap(async (req, res) => { res.json(await stateShareAgeing(req.ctx!, query(stateShareAgeingQuerySchema, req))); }));

router.get('/subsidy-claims', wrap(async (req, res) => {
  const ctx = req.ctx!;
  const page = await runList(ctx, req, {
    table: 'subsidy_claims', searchCols: ['e_token', 'rejection_reason'],
    filterCols: ['status', 'cohort', 'dealer_id', 'distributor_id', 'customer_id', 'installation_id', 'sales_order_id', 'claim_deadline', 'claim_at', 'discom_approval_at', 'released_at', 'rejection_reason', 'state_share_received_at'],
    defaultSort: { col: 'created_at', dir: 'desc' },
  });
  respondPage(res, await hydrateSubsidyClaims(ctx, page.rows as never), page.total, page.limit, page.offset);
}));

router.get('/subsidy-claims/:id', handle(async (ctx, req) => {
  const row = await ctx.db.table('subsidy_claims').get(param(req, 'id'));
  if (!row) throw notFound('Subsidy claim');
  await assertCanRead(ctx, 'subsidy_claims', row);
  return (await hydrateSubsidyClaims(ctx, [row]))[0];
}));

const claimResponse = async (ctx: Parameters<typeof hydrateSubsidyClaims>[0], row: Parameters<typeof hydrateSubsidyClaims>[1][number], extra: Record<string, unknown> = {}) => ({ ...(await hydrateSubsidyClaims(ctx, [row]))[0], ...extra });

router.post('/subsidy-claims', write, handle(async (ctx, req, res) => {
  const row = await createSubsidyClaim(ctx, body(subsidyClaimCreateSchema, req));
  res.status(201);
  return claimResponse(ctx, row, { warnings: row.warnings });
}));
router.patch('/subsidy-claims/:id', write, handle(async (ctx, req) => {
  const row = await updateSubsidyClaim(ctx, param(req, 'id'), body(subsidyClaimUpdateSchema, req));
  return claimResponse(ctx, row, { warnings: row.warnings });
}));
router.post('/subsidy-claims/:id/discom-approval', write, handle(async (ctx, req) => {
  const row = await recordDiscomApproval(ctx, param(req, 'id'), body(subsidyDiscomApprovalSchema, req).approved_at);
  return claimResponse(ctx, row, { warnings: row.warnings });
}));
router.post('/subsidy-claims/:id/claim', write, handle(async (ctx, req) => {
  const row = await submitClaim(ctx, param(req, 'id'), body(subsidyClaimSubmitSchema, req).claim_at);
  return claimResponse(ctx, row, { warnings: row.warnings });
}));
router.post('/subsidy-claims/:id/reject', write, handle(async (ctx, req) => {
  const input = body(subsidyRejectSchema, req);
  return claimResponse(ctx, await rejectClaim(ctx, param(req, 'id'), input.reason, input.note));
}));
router.post('/subsidy-claims/:id/reopen', write, handle(async (ctx, req) => {
  const row = await reopenClaim(ctx, param(req, 'id'));
  return claimResponse(ctx, row, { warnings: row.warnings });
}));
router.post('/subsidy-claims/:id/release', allow(...CHANNEL_ADMIN_ROLES, 'dispatch', 'techno_commercial'), handle(async (ctx, req) => {
  const row = await releaseClaim(ctx, param(req, 'id'), body(subsidyReleaseSchema, req));
  return claimResponse(ctx, row, { warnings: row.warnings, receivables_closed: row.receivables_closed });
}));
router.post('/subsidy-claims/:id/state-share', allow(...CHANNEL_ADMIN_ROLES), handle(async (ctx, req) => claimResponse(ctx, await recordStateShare(ctx, param(req, 'id'), body(subsidyStateShareSchema, req)))));
router.post('/subsidy-claims/:id/grievance', write, handle(async (ctx, req) => {
  const row = await raiseGrievance(ctx, param(req, 'id'), body(subsidyGrievanceSchema, req));
  return claimResponse(ctx, row, { warnings: row.warnings });
}));
router.post('/subsidy-claims/:id/grievance/resolve', write, handle(async (ctx, req) => claimResponse(ctx, await resolveGrievance(ctx, param(req, 'id')))));

/* ───────────────────────── loans ───────────────────────── */
router.get('/loans/summary', handle((ctx, req) => loanSummary(ctx, query(loanSummaryQuerySchema, req))));
router.use(crudRouter({
  table: 'loans', path: '/loans', entity: 'loan', writeRoles: [...LOAN_WRITE_ROLES],
  list: {
    searchCols: ['bank', 'co_applicant', 'notes'],
    filterCols: ['status', 'bank', 'dealer_id', 'distributor_id', 'customer_id', 'lead_id', 'opportunity_id', 'owner_id', 'rejection_code', 'application_date', 'disbursed_at'],
    defaultSort: { col: 'created_at', dir: 'desc' },
  },
  createSchema: loanCreateSchema, updateSchema: loanUpdateSchema,
  prepareCreate: (ctx, input) => prepareLoanCreate(ctx, input),
  prepareUpdate: (ctx, input, current) => prepareLoanUpdate(ctx, input, current),
  afterCreate: (ctx, row) => afterLoanWrite(ctx, row, null),
  afterUpdate: (ctx, row, before) => afterLoanWrite(ctx, row, before),
  hydrate: hydrateLoans,
}));

/* ───────────────────────── warranty / RMA ───────────────────────── */
router.get('/warranty-tickets', wrap(async (req, res) => {
  const ctx = req.ctx!;
  const serialNo = typeof req.query['serial'] === 'string' ? req.query['serial'].trim() : '';
  const serial = serialNo ? await ctx.db.table('inventory_serials').one({ serial: serialNo }) : null;
  const page = await runList(ctx, req, {
    table: 'warranty_tickets', searchCols: ['ticket_no', 'issue', 'brand_claim_no'], baseWhere: serialNo ? { serial_id: serial?.id ?? '00000000-0000-0000-0000-000000000000' } : undefined,
    filterCols: ['status', 'type', 'cost_bearer', 'dealer_id', 'customer_id', 'installation_id', 'sales_order_id', 'serial_id', 'owner_id', 'opened_at', 'rma_due_at', 'closed_at'],
    defaultSort: { col: 'opened_at', dir: 'desc' },
  });
  respondPage(res, await hydrateWarrantyTickets(ctx, page.rows as never), page.total, page.limit, page.offset);
}));
router.get('/warranty-tickets/:id', handle(async (ctx, req) => {
  const row = await ctx.db.table('warranty_tickets').get(param(req, 'id'));
  if (!row) throw notFound('Warranty ticket');
  await assertCanRead(ctx, 'warranty_tickets', row);
  return (await hydrateWarrantyTickets(ctx, [row]))[0];
}));
router.post('/warranty-tickets', write, handle(async (ctx, req, res) => {
  const row = await createWarrantyTicket(ctx, body(warrantyTicketCreateSchema, req));
  res.status(201);
  return { ...(await hydrateWarrantyTickets(ctx, [row]))[0], warnings: row.warnings };
}));
router.patch('/warranty-tickets/:id', write, handle(async (ctx, req) => {
  const row = await updateWarrantyTicket(ctx, param(req, 'id'), body(warrantyTicketUpdateSchema, req));
  return { ...(await hydrateWarrantyTickets(ctx, [row]))[0], warnings: row.warnings };
}));

/* ───────────────────────── receivables ───────────────────────── */
router.use(crudRouter({
  table: 'dealer_receivables', path: '/receivables', entity: 'receivable', writeRoles: [...CHANNEL_ADMIN_ROLES],
  list: {
    searchCols: ['doc_ref'],
    filterCols: ['dealer_id', 'distributor_id', 'status', 'subsidy_linked', 'linked_project_id', 'invoice_date', 'due_date'],
    defaultSort: { col: 'due_date', dir: 'asc' },
  },
  createSchema: receivableCreateSchema, updateSchema: receivableUpdateSchema,
  prepareCreate: (ctx, input) => prepareReceivableCreate(ctx, input),
  prepareUpdate: (ctx, input, current) => prepareReceivableUpdate(ctx, input, current),
  hydrate: hydrateReceivables,
  allowDelete: false,
}));

/* ───────────────────────── board ───────────────────────── */
router.get('/post-sale/board', handle((ctx) => postSaleBoard(ctx)));

export default router;
