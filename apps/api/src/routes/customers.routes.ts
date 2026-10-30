/**
 * Customers, sites, surveys, requirement capture, negotiation log, segment forms and survey photos.
 * Full resource paths, mounted under /api/v1. Visibility of customers / sites / surveys follows the linked lead
 * (a distributor or dealer only ever reaches records that belong to their own leads).
 */
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import {
  customerCreateSchema, customerUpdateSchema, findAadhaarKeys, leadSiteSaveSchema, negotiationCreateSchema, requirementSaveSchema, shortlistSaveSchema, segmentFormSaveSchema, segmentSchema,
  siteCreateSchema, siteUpdateSchema, surveyFeasibilitySchema, surveyListQuerySchema, surveyScheduleSchema, surveyUpdateSchema,
} from '@solar/shared';
import { ALL_ROLES, SALES_ROLES, allow } from '../auth/authorize';
import { AppError, badRequest, notFound } from '../http/errors';
import { body, handle, parse, query } from '../http/handler';
import { assertCanReadSite, createCustomer, createSite, getCustomerView, getLeadSiteView, getSiteView, listCustomers, listSites, maskCustomer, saveLeadSite, siteBillUrl, updateCustomer, updateSite, uploadSiteBill } from '../services/siteService';
import { getVisibleLead, idParam } from '../services/siteAccess';
import { getSurveyView, listSurveys, loadSurvey, scheduleSurvey, updateSurvey } from '../services/surveyService';
import { recordFeasibility } from '../services/surveyFeasibility';
import { surveyPhotoUrl, uploadSurveyPhotos } from '../services/surveyPhotos';
import { billUpload, photosUpload } from '../services/siteUploads';
import { getRequirementView, getSegmentForm, getShortlist, publishSegmentForm, saveRequirement, saveShortlist } from '../services/requirementService';
import { listNegotiations, logNegotiation } from '../services/negotiationService';

const router = Router();

const READ = allow(...ALL_ROLES);
const WRITE = allow(...SALES_ROLES);
const CUSTOMER_WRITE = allow(...SALES_ROLES, 'accounts');
const FORM_ADMIN = allow('management', 'sales_manager', 'techno_commercial', 'compliance_officer');

/** G14 at the key level: refuse any `aadhaar`-looking field name (the edge guard only sees Verhoeff-valid numbers in values). */
const noAadhaarKeys: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  const hits = findAadhaarKeys(req.body);
  if (hits.length) return next(new AppError(422, 'AADHAAR_BLOCKED', 'Aadhaar fields are not accepted. We do not store Aadhaar numbers or images — use the last four digits only where asked.', { fields: hits }));
  next();
};

/* ───────────── customers ───────────── */

router.get('/customers', READ, handle(async (ctx, req, res) => {
  const page = await listCustomers(ctx, req);
  res.json({ data: page.rows, total: page.total, limit: page.limit, offset: page.offset });
}));
router.get('/customers/:id', READ, handle(async (ctx, req) => getCustomerView(ctx, idParam(req))));
router.post('/customers', CUSTOMER_WRITE, noAadhaarKeys, handle(async (ctx, req, res) => {
  const row = await createCustomer(ctx, body(customerCreateSchema, req));
  res.status(201).json({ data: maskCustomer(ctx, row) });
}));
router.patch('/customers/:id', CUSTOMER_WRITE, noAadhaarKeys, handle(async (ctx, req) => maskCustomer(ctx, await updateCustomer(ctx, idParam(req), body(customerUpdateSchema, req)))));

/* ───────────── sites ───────────── */

router.get('/sites', READ, handle(async (ctx, req, res) => {
  const page = await listSites(ctx, req);
  res.json({ data: page.rows, total: page.total, limit: page.limit, offset: page.offset });
}));
router.get('/sites/:id', READ, handle(async (ctx, req) => getSiteView(ctx, idParam(req))));
router.post('/sites', WRITE, noAadhaarKeys, handle(async (ctx, req, res) => {
  const r = await createSite(ctx, body(siteCreateSchema, req));
  res.status(201).json({ data: { ...r, customer: r.customer ? maskCustomer(ctx, r.customer) : null } });
}));
router.patch('/sites/:id', WRITE, noAadhaarKeys, handle(async (ctx, req) => updateSite(ctx, idParam(req), body(siteUpdateSchema, req))));

router.post('/sites/:id/bill', WRITE, billUpload, handle(async (ctx, req, res) => {
  const site = await ctx.db.table('sites').get(idParam(req));
  if (!site) throw notFound('Site');
  await assertCanReadSite(ctx, site);
  if (!site.lead_id) throw badRequest('This site is not linked to a lead — upload the bill through the lead (POST /leads/:id/site/bill)');
  res.status(201).json({ data: await uploadSiteBill(ctx, await getVisibleLead(ctx, site.lead_id), req) });
}));
router.get('/sites/:id/bill/url', READ, handle(async (ctx, req) => siteBillUrl(ctx, idParam(req))));

/* lead-centred site form: the customer + site pair is created on the first save */
router.get('/leads/:id/site', READ, handle(async (ctx, req) => getLeadSiteView(ctx, await getVisibleLead(ctx, idParam(req)))));
router.put('/leads/:id/site', WRITE, noAadhaarKeys, handle(async (ctx, req, res) => {
  const lead = await getVisibleLead(ctx, idParam(req));
  const r = await saveLeadSite(ctx, lead, body(leadSiteSaveSchema, req));
  res.status(r.created.site ? 201 : 200).json({ data: { ...r, customer: r.customer ? maskCustomer(ctx, r.customer) : null } });
}));
router.post('/leads/:id/site/bill', WRITE, billUpload, handle(async (ctx, req, res) => {
  const lead = await getVisibleLead(ctx, idParam(req));
  res.status(201).json({ data: await uploadSiteBill(ctx, lead, req) });
}));

/* ───────────── site visits and surveys (step 14) ───────────── */

router.get('/surveys', READ, handle(async (ctx, req, res) => {
  query(surveyListQuerySchema, req);
  const page = await listSurveys(ctx, req);
  res.json({ data: page.rows, total: page.total, limit: page.limit, offset: page.offset });
}));
router.post('/surveys', WRITE, noAadhaarKeys, handle(async (ctx, req, res) => {
  const survey = await scheduleSurvey(ctx, body(surveyScheduleSchema, req));
  res.status(201).json({ data: await getSurveyView(ctx, survey.id) });
}));
router.get('/surveys/:id', READ, handle(async (ctx, req) => getSurveyView(ctx, idParam(req))));
router.patch('/surveys/:id', WRITE, noAadhaarKeys, handle(async (ctx, req) => updateSurvey(ctx, idParam(req), body(surveyUpdateSchema, req))));
router.patch('/surveys/:id/feasibility', WRITE, noAadhaarKeys, handle(async (ctx, req) => {
  const { survey, lead } = await loadSurvey(ctx, idParam(req));
  return recordFeasibility(ctx, survey, lead, body(surveyFeasibilitySchema, req));
}));
router.post('/surveys/:id/photos', WRITE, photosUpload, handle(async (ctx, req, res) => {
  res.status(201).json({ data: await uploadSurveyPhotos(ctx, idParam(req), req) });
}));
router.get('/surveys/:id/photos/:index/url', READ, handle(async (ctx, req) => {
  const index = Number(req.params['index']);
  if (!Number.isInteger(index) || index < 0) throw notFound('Photo');
  return surveyPhotoUrl(ctx, idParam(req), index);
}));

/* ───────────── requirement capture (step 15) ───────────── */

router.get('/segments/:segment/form', READ, handle(async (ctx, req) => getSegmentForm(ctx, parse(segmentSchema, req.params['segment']))));
router.put('/segments/:segment/form', FORM_ADMIN, noAadhaarKeys, handle(async (ctx, req) => publishSegmentForm(ctx, parse(segmentSchema, req.params['segment']), body(segmentFormSaveSchema, req))));

router.get('/leads/:id/requirement', READ, handle(async (ctx, req) => getRequirementView(ctx, await getVisibleLead(ctx, idParam(req)))));
router.get('/leads/:id/shortlist', READ, handle(async (ctx, req) => getShortlist(ctx, await getVisibleLead(ctx, idParam(req)))));
router.put('/leads/:id/shortlist', WRITE, handle(async (ctx, req) => saveShortlist(ctx, await getVisibleLead(ctx, idParam(req)), body(shortlistSaveSchema, req).sku_ids)));
router.put('/leads/:id/requirement', WRITE, noAadhaarKeys, handle(async (ctx, req) => {
  const lead = await getVisibleLead(ctx, idParam(req));
  return saveRequirement(ctx, lead, body(requirementSaveSchema, req));
}));

/* ───────────── rate negotiation log (step 18) ───────────── */

router.get('/leads/:id/negotiations', READ, handle(async (ctx, req) => listNegotiations(ctx, await getVisibleLead(ctx, idParam(req)))));
router.post('/leads/:id/negotiations', WRITE, noAadhaarKeys, handle(async (ctx, req, res) => {
  const lead = await getVisibleLead(ctx, idParam(req));
  res.status(201).json({ data: await logNegotiation(ctx, lead, body(negotiationCreateSchema, req)) });
}));

export default router;
