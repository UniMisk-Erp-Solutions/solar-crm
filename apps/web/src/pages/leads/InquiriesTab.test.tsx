import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { page, renderPage, type Handlers } from '@/test/utils';
import LeadsModule from './LeadsModule';

const now = new Date().toISOString();
const future = new Date(Date.now() + 25 * 60_000).toISOString();
const lead = (over: Record<string, unknown> = {}) => ({
  id: 'l1', name: 'Asha Patel', source: 'website', city: 'Ahmedabad', capacity_kw: 5, status: 'assigned', distributor_id: 'd1', distributor_name: 'Alpha Solar', owner_name: null,
  sla_due_at: future, assigned_at: now, sla_state: 'ok', followup_overdue: false, quality_score: 72, ...over,
});
const open = (handlers: Handlers, route = '/leads') => renderPage(<LeadsModule />, { route, path: '/leads', handlers });

describe('Leads - Inquiries (Stage 1 of the flow chart)', () => {
  it('lists inquiries and filters them by where they are', async () => {
    const user = userEvent.setup();
    const { api } = open({
      'GET /leads': ({ url }: { url: URL }) => page(url.searchParams.get('status') === 'assigned' ? [lead()] : [lead(), lead({ id: 'l2', name: 'Ravi Shah', status: 'accepted', source: 'call_centre', distributor_name: 'Beta Energy' })]),
    });
    expect(await screen.findByText('Asha Patel')).toBeInTheDocument();
    expect(screen.getByText('Ravi Shah')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: /show/i }), 'awaiting');
    await waitFor(() => expect(screen.queryByText('Ravi Shah')).not.toBeInTheDocument());
    expect(api.calls.some((c) => c.path === '/leads')).toBe(true);
  });

  it('puts an inquiry whose window was missed in the Reminder and escalation loop', async () => {
    open({ 'GET /leads': page([lead({ sla_state: 'breached' })]) });
    expect(await screen.findByText('7 · Reminder and escalation loop')).toBeInTheDocument();
    expect(screen.getByText('Reminder sent · DSM alerted')).toBeInTheDocument();
  });

  it('shows an empty state and an error state with retry', async () => {
    open({ 'GET /leads': page([]) });
    expect(await screen.findByText('No inquiries yet')).toBeInTheDocument();
  });

  it('shows the error state', async () => {
    open({ 'GET /leads': { status: 500, body: { error: { code: 'ERROR', message: 'Boom' } } } });
    expect(await screen.findByText('Boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again|retry/i })).toBeInTheDocument();
  });

  it('accepts an awaiting inquiry from the row', async () => {
    const user = userEvent.setup();
    const { api } = open({ 'GET /leads': page([lead()]), 'POST /leads/l1/accept': { data: lead({ status: 'accepted' }) } });
    await user.click(await screen.findByRole('button', { name: /accept asha/i }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/leads/l1/accept')).toBe(true));
  });

  const cand = (id: string, name: string, reasons: string[], score: number) => ({ distributor_id: id, name, eligible: reasons.length === 0, reasons, score });
  const detail = (status: string, over: Record<string, unknown> = {}, candidates = [cand('d1', 'Alpha Solar (Demo)', [], 84), cand('d2', 'Beta Energy (Demo)', ['Does not serve Ahmedabad', 'Lacks capability: rooftop'], 71)]) => ({
    data: {
      lead: lead({ id: 'n1', name: 'Meera Joshi', status, temperature: 'hot', distributor_id: status === 'assigned' ? 'd1' : null, distributor_name: status === 'assigned' ? 'Alpha Solar (Demo)' : null, owner_name: 'Asha Rao', ...over }),
      events: [{ id: 'e1', event_type: 'assigned', created_at: now, summary: 'Assigned' }],
      assignments: [{ assigned_at: now, score_snapshot: { candidates, geo: { territory_name: 'Ahmedabad' }, chosen: status === 'assigned' ? 'd1' : null } }],
      clocks: status === 'assigned' ? [{ clock_type: 'lead_acceptance', started_at: now, due_at: new Date(Date.now() + 30 * 60_000).toISOString(), warn_at: new Date(Date.now() + 21 * 60_000).toISOString(), meta: { step_minutes: 15 } }] : [],
    },
  });
  const geo = { 'GET /lookups/pincode/380001': { data: { pincode: '380001', city: 'Ahmedabad', district: 'Ahmedabad', state: 'Gujarat', serviceable: true } } };

  async function fillNew(user: ReturnType<typeof userEvent.setup>, urgency?: string) {
    await user.click((await screen.findAllByRole('button', { name: 'New inquiry' }))[0]!);
    await user.type(await screen.findByLabelText(/^name/i), 'Meera Joshi');
    await user.type(screen.getByLabelText(/^mobile/i), '98765 43210');
    await user.type(screen.getByLabelText(/^pincode/i), '380001');
    await waitFor(() => expect((screen.getByLabelText(/^city/i) as HTMLInputElement).value).toBe('Ahmedabad'));
    expect((screen.getByLabelText(/^state/i) as HTMLInputElement).value).toBe('Gujarat');
    await user.selectOptions(screen.getByLabelText(/customer type/i), 'residential');
    if (urgency) await user.selectOptions(screen.getByLabelText(/how soon/i), urgency);
    await user.click(screen.getByRole('button', { name: /save and match a distributor/i }));
  }

  it('new inquiry (steps 1–3): the form follows the chart, picks the product from the customer type and sends urgency', async () => {
    const user = userEvent.setup();
    const { api } = open({ 'GET /leads': page([]), ...geo, 'POST /leads': { data: { lead: lead({ id: 'n1' }), created: true, duplicate_of: null, assigned: true } }, 'GET /leads/n1': detail('assigned') });
    await user.click((await screen.findAllByRole('button', { name: 'New inquiry' }))[0]!);
    for (const t of ['Inquiry captured', 'Validate & de-duplicate', 'Capture details']) expect(await screen.findByRole('heading', { name: t })).toBeInTheDocument();
    for (const s of ['Website', 'Call', 'WhatsApp', 'Campaign', 'Referral']) expect(screen.getByRole('radio', { name: s })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await fillNew(user, 'immediate');
    await screen.findByRole('heading', { name: /territory & capability match/i });
    const post = api.calls.find((c) => c.method === 'POST' && c.path === '/leads')!;
    expect(post.body).toMatchObject({ name: 'Meera Joshi', mobile: '+919876543210', city: 'Ahmedabad', state: 'Gujarat', source: 'call_centre', customer_type: 'residential', product_interest: ['rooftop'], timeline_bucket: 'immediate' });
  });

  it('new inquiry (steps 4–7): shows the four criteria per distributor, the chosen one, the SLA and the escalation path', async () => {
    const user = userEvent.setup();
    open({ 'GET /leads': page([]), ...geo, 'POST /leads': { data: { lead: lead({ id: 'n1' }), created: true, duplicate_of: null, assigned: true } }, 'GET /leads/n1': detail('assigned') });
    await fillNew(user);
    const dialog = await screen.findByRole('dialog');
    const table = await within(dialog).findByRole('table');
    for (const h of ['Distributor', 'Territory', 'MW capacity', 'Product capability', 'Score']) expect(within(table).getByRole('columnheader', { name: h })).toBeInTheDocument();
    expect(within(table).getByText('Chosen')).toBeInTheDocument();
    expect(within(table).getByText('Does not serve Ahmedabad')).toBeInTheDocument();
    expect(within(table).getByText('Lacks capability: rooftop')).toBeInTheDocument();
    expect(within(dialog).getByText(/Distributor available & eligible — YES/)).toBeInTheDocument();
    expect(within(dialog).getByText('5 · Auto-assigned')).toBeInTheDocument();
    expect(within(dialog).getByText(/must accept within/)).toBeInTheDocument();
    expect(within(dialog).getByText('HOT')).toBeInTheDocument();
    for (const n of ['Assigned', 'Reminder 1', 'DSM alert', 'Auto reassignment']) expect(within(dialog).getByText(n)).toBeInTheDocument();
  });

  const sug = (id: string, name: string, over: Record<string, unknown> = {}) => ({
    distributor_id: id, name, city: 'Ahmedabad', home_pincode: '380015', eligible: true, recommended: false, reasons: [], score: 70, open_leads: 0, band_fit: 0.5, proximity: 0.9,
    distance_hint: 'same postal region', total: 0.7, request_status: null, ...over,
  });
  const suggestions = {
    data: { lead_id: 'n1', pincode: '380001', territory_name: 'Ahmedabad', candidates: [
      sug('d1', 'Alpha Solar', { recommended: true }), sug('d2', 'Beta Energy', { recommended: true }),
      sug('d3', 'Gamma Power', { eligible: false, reasons: ['Does not serve Ahmedabad'], distance_hint: 'far region' }),
    ] },
  };

  it('new inquiry: the system only SUGGESTS; nothing is sent until you tick the distributors and press send', async () => {
    const user = userEvent.setup();
    const { api } = open({
      'GET /leads': page([]), ...geo,
      'POST /leads': { data: { lead: lead({ id: 'n1', status: 'validated' }), created: true, duplicate_of: null, assigned: false } },
      'GET /leads/n1': detail('validated', { distributor_id: null }), 'GET /leads/n1/suggestions': suggestions,
      'POST /leads/n1/requests': { data: lead({ id: 'n1', status: 'assigned' }) },
    });
    await fillNew(user);
    expect(await screen.findByText('Recommended for this pincode')).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === '/leads/n1/requests')).toBe(false);
    // the best matches are marked, a non-matching one is still selectable and says why it is not perfect
    expect(screen.getByText('Does not serve Ahmedabad')).toBeInTheDocument();
    expect(screen.getByText('Not a perfect match')).toBeInTheDocument();
    const send = screen.getByRole('button', { name: /send request/i });
    expect(send).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /send the request to alpha solar/i }));
    await user.click(screen.getByRole('checkbox', { name: /send the request to gamma power/i }));
    await user.click(screen.getByRole('button', { name: /send request to 2 distributors/i }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/leads/n1/requests')?.body).toEqual({ distributor_ids: ['d1', 'd3'] }));
  });

  it('"Select the best matches" ticks every recommended distributor at once', async () => {
    const user = userEvent.setup();
    const { api } = open({
      'GET /leads': page([]), ...geo,
      'POST /leads': { data: { lead: lead({ id: 'n1', status: 'validated' }), created: true, duplicate_of: null, assigned: false } },
      'GET /leads/n1': detail('validated', { distributor_id: null }), 'GET /leads/n1/suggestions': suggestions,
      'POST /leads/n1/requests': { data: lead({ id: 'n1', status: 'assigned' }) },
    });
    await fillNew(user);
    await user.click(await screen.findByRole('button', { name: /select the best matches/i }));
    await user.click(screen.getByRole('button', { name: /send request to 2 distributors/i }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/leads/n1/requests')?.body).toEqual({ distributor_ids: ['d1', 'd2'] }));
  });

  it('new inquiry (step 2): a duplicate is held for review instead of being assigned', async () => {
    const user = userEvent.setup();
    open({ 'GET /leads': page([]), ...geo, 'POST /leads': { data: { lead: lead({ id: 'n1', status: 'duplicate' }), created: true, duplicate_of: 'old1', assigned: false } }, 'GET /leads/n1': detail('duplicate') });
    await fillNew(user);
    expect(await screen.findByText(/looks like an inquiry we already have/i)).toBeInTheDocument();
  });
});
