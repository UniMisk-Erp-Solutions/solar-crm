import type { Lead, Opportunity, SiteSurvey } from '@solar/shared';

export type VisitLead = Pick<Lead, 'id' | 'name' | 'status' | 'capacity_kw' | 'city' | 'segment' | 'temperature'>;
export type SurveyRow = Pick<SiteSurvey, 'id' | 'lead_id' | 'status' | 'scheduled_at' | 'surveyed_at'>;
export type VisitStage = 'todo' | 'scheduled' | 'done';

export interface Feasibility {
  kw: number | null; required: boolean | null; status: string; threshold_kw: number; days_allowed: number; deemed_enabled: boolean;
  application_submitted_at: string | null; application_complete_at: string | null; due_at: string | null; message: string | null;
}
export interface SurveyView extends SiteSurvey { photo_count: number; feasibility: Feasibility }

export interface OpportunityRow extends Opportunity { lead_name?: string | null; lead_city?: string | null }
export interface OpportunityDetail extends OpportunityRow { quotes?: { id: string; quote_no: string; version: number; status: string }[] }

export interface ConvertCheck {
  lead_id: string; opportunity_id: string | null; status_ok: boolean; can_convert: boolean;
  prerequisites: { key: string; label: string; ok: boolean; hint?: string | null }[];
  confirmations: { key: string; label: string }[]; missing: string[];
}
