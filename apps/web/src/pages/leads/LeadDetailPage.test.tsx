import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { page, renderPage, type Handlers } from '@/test/utils';
import LeadDetailPage from './LeadDetailPage';

const iso = '2026-10-26T05:00:00.000Z';
const detail = (over: Record<string, unknown> = {}) => ({
  lead: {
    id: 'l1', name: 'Asha Patel', source: 'website', city: 'Ahmedabad', capacity_kw: 5, mobile: '+919876543210', email: null, status: 'assigned', temperature: null, quality_score: null,
    owner_id: 'u1', owner_name: 'Priya Rao', last_action: 'Accepted inquiry', next_action: 'Call the customer', next_followup_at: '2026-10-30T05:00:00.000Z',
    requirement_text: null, timeline_bucket: null, budget_inr: null, decision_maker: null,
  },
  events: [{ id: 'e1', event_type: 'acceptance_reminder', summary: 'Reminder sent to Alpha Solar', created_at: iso }],
  consents: [], consent_summary: { has_active: true, withdrawn: false, channels: ['call', 'whatsapp'], purposes: [], suppress_until: null },
  assignments: [], followups: [{ id: 'f1', status: 'open', due_at: '2026-10-30T05:00:00.000Z' }], contact_logs: [], score: null, clocks: [], duplicates: { leads: [], customers: [] },
  next_best_action: { code: 'contact', label: 'Make the first contact', due_at: null, urgent: false }, convert_blockers: [], can_convert: false, qualification_gaps: [], ...over,
});
const open = (handlers: Handlers) =>
  renderPage(<LeadDetailPage />, { route: '/leads/l1', path: '/leads/:id', handlers: { 'GET /leads/l1/timeline': page([{ at: iso, kind: 'event', type: 'captured', summary: 'Inquiry captured', actor_id: null, detail: {} }]), 'GET /admin/users': page([{ id: 'u1', full_name: 'Priya Rao' }]), ...handlers } });

describe('LeadDetailPage', () => {
  it('starts with the Next step card and shows the four mandatory fields, consent and the site link', async () => {
    open({ 'GET /leads/l1': { data: detail() } });
    expect(await screen.findByRole('heading', { level: 1, name: 'Asha Patel' })).toBeInTheDocument();
    expect(screen.getByText('Make the first contact')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Log a contact' }).length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/last action/i)).toHaveValue('Accepted inquiry');
    expect(screen.getByLabelText(/^next action/i)).toHaveValue('Call the customer');
    expect(screen.getByLabelText(/next follow-up date/i)).toBeInTheDocument();
    expect(await screen.findByLabelText(/owner/i)).toBeInTheDocument();
    expect(screen.getByText('Reminder sent')).toBeInTheDocument();
    expect(screen.getByText(/Next reminder/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw consent' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to site visit' })).toHaveAttribute('href', '/site');
  });

  it('blocks blanking a mandatory field', async () => {
    const user = userEvent.setup();
    open({ 'GET /leads/l1': { data: detail() } });
    await user.clear(await screen.findByLabelText(/^next action/i));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Next action is required on every lead')).toBeInTheDocument();
  });

  it('saving the qualification call shows temperature and the quality score with component bars', async () => {
    const user = userEvent.setup();
    const { api } = open({
      'GET /leads/l1': { data: detail() },
      'POST /leads/l1/qualification': {
        data: {
          lead: {}, gaps: [], qualified: true, temperature: 'hot', deadline_uplift: false,
          score: { score: 78, components: [{ key: 'requirement_clarity', label: 'Requirement', weight: 20, points: 15 }, { key: 'mw_size', label: 'Size', weight: 15, points: 10 }, { key: 'timeline', label: 'Timeline', weight: 20, points: 20 }, { key: 'budget', label: 'Budget', weight: 10, points: 5 }, { key: 'decision_maker', label: 'Decision maker', weight: 15, points: 10 }] },
        },
      },
    });
    await user.type(await screen.findByLabelText(/^requirement/i), 'Rooftop 5 kW for home');
    await user.selectOptions(screen.getByLabelText(/^timeline/i), 'immediate');
    await user.selectOptions(screen.getByLabelText(/decision maker/i), 'self');
    await user.click(screen.getByRole('button', { name: 'Save qualification' }));
    expect(await screen.findByText('Hot')).toBeInTheDocument();
    expect(screen.getByText('Quality score')).toBeInTheDocument();
    expect(screen.getByText('78')).toBeInTheDocument();
    expect(screen.getAllByRole('progressbar')).toHaveLength(5);
    await waitFor(() => expect(api.calls.find((c) => c.path === '/leads/l1/qualification')?.body).toMatchObject({ timeline_bucket: 'immediate', decision_maker: 'self' }));
  });

  it('shows an error state when the lead cannot be loaded', async () => {
    open({ 'GET /leads/l1': { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Lead not found' } } } });
    expect(await screen.findByText('Lead not found')).toBeInTheDocument();
  });
});
