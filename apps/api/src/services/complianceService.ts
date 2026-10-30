/**
 * Compliance engine entry point (gates G1–G14). `ctx.svc.compliance` is created here and used by the quote module,
 * the dispatch module and the live-preview endpoint. The gates themselves live in services/compliance/*.
 *
 * Importing this module also loads the approval handlers and the re-quote engine (rule-change hook + nightly jobs), so they are
 * registered whenever the service registry is built — i.e. at application start-up, before any route is hit.
 */
import type { CompliancePreviewInput } from '@solar/shared';
import type { AppContext } from '../auth/context';
import type { ComplianceService, EvaluationResult } from './contracts';
import { runGates } from './compliance/engine';
import { buildDispatchInput, buildPreviewInput, buildQuoteInput } from './compliance/inputs';
import { lineSignature, loadGrants } from './compliance/overrides';
import type { FullEvaluation } from './compliance/types';
import { computeCfa } from './cfa';
import './approvalService';
import './requoteService';

export const toResult = (e: FullEvaluation): EvaluationResult => ({ findings: e.findings, hasHardStop: e.hasHardStop, status: e.status, ruleIdsUsed: e.ruleIdsUsed, evaluated_at: e.evaluated_at });

/** Evaluate a saved quote; persists findings, status, rule ids and timestamp on the quote unless `persist` is false. */
export async function evaluateQuoteFull(ctx: AppContext, quoteId: string, opts: { persist?: boolean } = {}): Promise<FullEvaluation> {
  const { input, quote, skuIds } = await buildQuoteInput(ctx, quoteId);
  const grants = await loadGrants(ctx, [quote.id]);
  const result = await runGates(ctx, input, { grants, lineSignature: lineSignature(skuIds) });
  if (opts.persist !== false) {
    await ctx.db.table('quotations').update(quote.id, {
      compliance_findings: result.findings, compliance_status: result.status, rule_ids_used: result.ruleIdsUsed, compliance_evaluated_at: result.evaluated_at,
    });
  }
  return result;
}

/** Evaluate the serial-level gates for a sales order (optionally scoped to one dispatch or an explicit serial list). */
export async function evaluateDispatchFull(ctx: AppContext, soId: string, opts: { persist?: boolean; dispatchId?: string; serialIds?: string[] } = {}): Promise<FullEvaluation> {
  const { input, entityIds } = await buildDispatchInput(ctx, soId, opts);
  const grants = await loadGrants(ctx, entityIds);
  const result = await runGates(ctx, input, { grants });
  // The dispatch service normally sets dispatch.compliance_status itself from the returned findings; it is written here only on request.
  if (opts.persist === true && opts.dispatchId) {
    await ctx.db.table('dispatches').update(opts.dispatchId, { compliance_status: result.status, compliance_findings: result.findings });
  }
  return result;
}

/** Live gate results without a quote (product-recommendation screen and quote builder). Also returns the CFA the segment would attract. */
export async function previewCompliance(ctx: AppContext, params: CompliancePreviewInput): Promise<FullEvaluation & { cfa: Awaited<ReturnType<typeof computeCfa>> }> {
  const input = await buildPreviewInput(ctx, params);
  const result = await runGates(ctx, input);
  const cfa = await computeCfa(ctx, {
    segment: params.segment, kw: params.kw, referenceDate: input.refDate,
    existing_solar_kw: input.site?.existing_solar_kw, special_category_state: input.site?.special_category_state,
  });
  return { ...result, cfa };
}

export function createComplianceService(ctx: AppContext): ComplianceService {
  return {
    async evaluateQuote(quoteId, opts) { return toResult(await evaluateQuoteFull(ctx, quoteId, opts)); },
    async evaluateDispatch(soId, opts) { return toResult(await evaluateDispatchFull(ctx, soId, opts)); },
  };
}
