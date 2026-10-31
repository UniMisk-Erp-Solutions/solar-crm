import { Router } from 'express';
import { z } from 'zod';
import { maskMobile, type Lead, type LeadAssignment } from '@solar/shared';
import type { AppContext } from '../auth/context';
import type { AppDeps } from '../deps';
import { buildContext, systemUser } from '../deps';
import { AppError } from '../http/errors';
import { publicLimiter } from '../http/guards';
import { body, wrap } from '../http/handler';
import { verifyRequestToken } from '../lib/actionToken';
import { acceptLead, rejectLead } from '../services/leadServiceAcceptance';
import { getLead, notifyStaff } from '../services/leadServiceStore';

export const isPublicRouter = true;

const respondSchema = z.object({
  action: z.enum(['accept', 'reject']),
  reason: z.string().trim().max(300).optional(),
}).refine((v) => v.action === 'accept' || (v.reason?.length ?? 0) >= 3, { message: 'Tell us why you are declining', path: ['reason'] });

type State = 'open' | 'accepted' | 'declined' | 'taken' | 'expired';

const stateOf = (a: LeadAssignment, lead: Lead): State => {
  if (a.status === 'accepted') return 'accepted';
  if (a.status === 'rejected') return 'declined';
  if (a.status === 'reassigned') return 'taken';
  if (a.status === 'expired') return 'expired';
  return lead.status === 'assigned' ? 'open' : 'expired';
};

/**
 * The page behind the link in a distributor's e-mail. No login: the signed token names one request. GET shows the lead (the customer's contact
 * details only after this distributor has accepted); POST records the answer exactly as if it had been recorded in the app, so the lead page updates.
 *   GET  /public/lead-requests/:token
 *   POST /public/lead-requests/:token/respond   { action: 'accept' | 'reject', reason? }
 */
export function createLeadRequestRouter(deps: AppDeps): Router {
  const r = Router();
  const limiter = publicLimiter(deps.config);

  const load = async (token: string | undefined): Promise<{ ctx: AppContext; a: LeadAssignment; lead: Lead; distributorName: string }> => {
    const t = token ? verifyRequestToken(token, deps.now()) : null;
    if (!t) throw new AppError(404, 'NOT_FOUND', 'This link is not valid any more. Ask Future Solar to send the request again.');
    const ctx = buildContext(deps, t.o, systemUser(t.o), { system: true });
    const a = await ctx.db.table('lead_assignments').get(t.a);
    if (!a || !a.distributor_id) throw new AppError(404, 'NOT_FOUND', 'This request does not exist any more.');
    const [lead, dist] = await Promise.all([getLead(ctx, a.lead_id), ctx.db.table('distributors').get(a.distributor_id)]);
    return { ctx, a, lead, distributorName: dist?.legal_name ?? 'Distributor' };
  };

  const view = (a: LeadAssignment, lead: Lead, distributorName: string) => {
    const state = stateOf(a, lead);
    return {
      state, distributor_name: distributorName, requested_at: a.assigned_at, due_at: a.due_at, answered_at: a.responded_at,
      lead: {
        name: lead.name, city: lead.city, pincode: lead.pincode, capacity_kw: lead.capacity_kw, customer_type: lead.customer_type, product_interest: lead.product_interest,
        temperature: lead.temperature, requirement_text: lead.requirement_text,
        // the customer's number is shared only with the distributor that accepted
        mobile: state === 'accepted' ? lead.mobile : maskMobile(lead.mobile), email: state === 'accepted' ? lead.email : null,
      },
    };
  };

  r.get('/public/lead-requests/:token', limiter, wrap(async (req, res) => {
    const { a, lead, distributorName } = await load(req.params['token']);
    res.json({ data: view(a, lead, distributorName) });
  }));

  r.post('/public/lead-requests/:token/respond', limiter, wrap(async (req, res) => {
    const input = body(respondSchema, req);
    const { ctx, a, lead, distributorName } = await load(req.params['token']);
    const current = stateOf(a, lead);
    if (current === 'accepted' && input.action === 'accept') { res.json({ data: view(a, lead, distributorName) }); return; } // pressed twice
    if (current !== 'open') { res.status(409).json({ error: { code: 'INVALID_STATE', message: current === 'taken' ? 'Another distributor accepted this lead first.' : 'This request is already closed.', details: view(a, lead, distributorName) } }); return; }
    try {
      if (input.action === 'accept') await acceptLead(ctx, lead.id, { note: `answered from the e-mail link by ${distributorName}`, distributor_id: a.distributor_id });
      else await rejectLead(ctx, lead.id, `${distributorName}: ${input.reason}`, a.distributor_id);
    } catch (e) {
      // someone else accepted between the page loading and this click
      const fresh = await ctx.db.table('lead_assignments').get(a.id);
      const freshLead = await getLead(ctx, lead.id);
      if (fresh && stateOf(fresh, freshLead) !== 'open') { res.status(409).json({ error: { code: 'INVALID_STATE', message: 'Another distributor accepted this lead first.', details: view(fresh, freshLead, distributorName) } }); return; }
      throw e;
    }
    const [fresh, freshLead] = [await ctx.db.table('lead_assignments').get(a.id), await getLead(ctx, lead.id)];
    await notifyStaff(ctx, {
      user_ids: [lead.owner_id ?? ''].filter(Boolean), kind: input.action === 'accept' ? 'lead.request_accepted' : 'lead.request_declined', severity: input.action === 'accept' ? 'success' : 'warning',
      lead_id: lead.id, title: `${distributorName} ${input.action === 'accept' ? 'accepted' : 'declined'} ${lead.name}`, body: input.action === 'accept' ? 'Answered from the e-mail link.' : input.reason,
    });
    res.json({ data: view(fresh ?? a, freshLead, distributorName) });
  }));

  return r;
}
