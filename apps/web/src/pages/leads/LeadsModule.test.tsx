import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { page, renderPage, type Handlers } from '@/test/utils';
import LeadsModule from './LeadsModule';

const future = new Date(Date.now() + 25 * 60_000).toISOString();
const lead = (over: Record<string, unknown> = {}) => ({
  id: 'l1', name: 'Asha Patel', source: 'website', city: 'Ahmedabad', capacity_kw: 5, status: 'assigned', distributor_name: 'Alpha Solar', owner_name: null,
  sla_due_at: future, assigned_at: new Date().toISOString(), sla_state: 'ok', followup_overdue: false, quality_score: 72, ...over,
});
const open = (handlers: Handlers, route = '/leads') => renderPage(<LeadsModule />, { route, path: '/leads', handlers });

describe('Leads - Follow-ups', () => {
  const fu = (over: Record<string, unknown>) => ({ id: 'f', lead_id: 'l', lead_name: 'X', lead_status: 'contacted', lead_temperature: 'warm', note: 'Call back', due_at: new Date().toISOString(), status: 'open', overdue: false, escalated_level: 0, ...over });
  it('puts overdue first with the escalation tag, temperature chip and a quick contact action', async () => {
    const user = userEvent.setup();
    const day = 86_400_000;
    const { api } = open({
      'GET /followups': page([
        fu({ id: 'a', lead_id: 'la', lead_name: 'Upcoming Uma', due_at: new Date(Date.now() + 3 * day).toISOString() }),
        fu({ id: 'b', lead_id: 'lb', lead_name: 'Overdue Om', lead_temperature: 'hot', overdue: true, status: 'missed', escalated_level: 1, due_at: new Date(Date.now() - 2 * day).toISOString() }),
      ]),
      'GET /leads': page([lead({ id: 'lb', quality_score: 81 })]),
      'POST /leads/lb/contacts': { data: { contact: {}, lead: lead() } },
    }, '/leads?tab=followups');
    await screen.findByText('Overdue Om');
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('Overdue Om')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Overdue — escalated to DSM')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Hot')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Upcoming Uma')).toBeInTheDocument();
    for (const n of ['Overdue', 'Today', 'Upcoming']) expect(screen.getByRole('button', { name: n })).toBeInTheDocument();
    await user.click(within(rows[0]!).getByRole('button', { name: /log a contact/i }));
    await user.click(await screen.findByRole('button', { name: 'Save contact' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/leads/lb/contacts')?.body).toMatchObject({ channel: 'call', outcome: 'connected_interested' }));
  });
});
