import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { page, renderPage, type Handlers } from '@/test/utils';
import SiteModule from './SiteModule';

const lead = { id: 'l1', name: 'Asha Patel', status: 'qualified', capacity_kw: 12, city: 'Ahmedabad', segment: 'ci_captive', temperature: 'warm' };
const check = (over: Record<string, unknown> = {}) => ({
  lead_id: 'l1', opportunity_id: null, status_ok: true, can_convert: false,
  prerequisites: [{ key: 'site', label: 'Site details', ok: false, hint: 'Save the site details first.' }], confirmations: [], missing: [], ...over,
});
const usp = { quality: 'Tier-1 cells', warranty: '25 years', certifications: 'BIS, IEC', service_support: 'Local service team', delivery_reliability: 'Ships in 7 days' };

function base(over: Handlers = {}): Handlers {
  return {
    'GET /leads': page([lead]),
    'GET /surveys': page([]),
    'GET /leads/l1/requirement': { data: { lead_id: 'l1', segment: 'ci_captive', completed: false, message: null, data: {}, config: { fields: [
      { key: 'load_type', label: 'Load type', type: 'select', required: true, options: ['Office', 'Factory'] },
      { key: 'timeline', label: 'Timeline', type: 'text', required: true },
    ] } } },
    'GET /leads/l1/shortlist': { data: { lead_id: 'l1', sku_ids: [], saved_at: null } },
    'PUT /leads/l1/shortlist': { data: { lead_id: 'l1', sku_ids: ['s1'], saved_at: '2026-10-28T06:00:00Z' } },
    'GET /skus/recommend': { data: [{ id: 's1', make: 'Waaree', model: 'Bifacial 540', category: 'module', wattage: 540, usp, warranty_years: 25 }] },
    'GET /leads/l1/negotiations': { data: { rows: [], summary: { rounds: 0, latest_quoted_rate_per_kw: null, latest_counter_per_kw: null, gap_per_kw: null } } },
    'GET /leads/l1/convert-check': { data: check() },
    ...over,
  };
}
const open = (handlers: Handlers, route = '/site') => renderPage(<SiteModule />, { route, path: '/site', handlers });

describe('Site visits - visit workspace', () => {
  it('walks the four steps one at a time and keeps Convert disabled with reasons until the three confirmations are ticked', async () => {
    const user = userEvent.setup();
    const { api } = open(base({ 'GET /leads/l1/convert-check': { data: check({ prerequisites: [{ key: 'site', label: 'Site details', ok: true }], can_convert: true }) }, 'POST /leads/l1/convert': { data: { opportunity: { id: 'o1' } } } }));

    await user.click(await screen.findByText('Asha Patel'));
    // step 14 is open first
    expect(await screen.findByLabelText('Visit date and time')).toBeInTheDocument();

    // 15: requirement form from the segment form definition
    await user.click(screen.getByRole('button', { name: /15.*Requirement capture form/ }));
    expect(await screen.findByRole('combobox', { name: /Load type/ })).toBeInTheDocument();
    for (const h of ['Documents']) expect(screen.getAllByRole('heading', { name: h }).length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/choose files to upload/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Visit date and time')).not.toBeInTheDocument();

    // 16: recommended product with the five USP lines and a Shortlist toggle
    await user.click(screen.getByRole('button', { name: /16.*Product recommendation/ }));
    expect(await screen.findByText('Waaree Bifacial 540')).toBeInTheDocument();
    for (const l of ['Quality', 'Warranty', 'Certifications', 'Service support', 'Delivery reliability']) expect(screen.getByText(l)).toBeInTheDocument();
    const short = screen.getByRole('button', { name: 'Shortlist' });
    await user.click(short);
    expect(screen.getByRole('button', { name: 'Shortlisted' })).toHaveAttribute('aria-pressed', 'true');
    // the choice is saved, and can be changed again
    await user.click(screen.getByRole('button', { name: 'Save shortlist' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/leads/l1/shortlist')?.body).toEqual({ sku_ids: ['s1'] }));

    // 17-18: negotiation
    await user.click(screen.getByRole('button', { name: /17.*Technical discussion/ }));
    expect(await screen.findByLabelText(/Rate offered/)).toBeInTheDocument();

    // decision
    expect(screen.getByText('Qualified project / real opportunity?')).toBeInTheDocument();
    expect(screen.getByText(/Do not convert unless requirement, timeline and commercial potential are confirmed/)).toBeInTheDocument();
    const convert = screen.getByRole('button', { name: 'Convert to opportunity' });
    expect(convert).toBeDisabled();
    expect(screen.getByText(/Tick “Requirement confirmed”/)).toBeInTheDocument();
    expect(screen.getByText(/Tick “Timeline confirmed”/)).toBeInTheDocument();
    expect(screen.getByText(/Tick “Commercial potential confirmed”/)).toBeInTheDocument();

    for (const name of ['Requirement confirmed', 'Timeline confirmed', 'Commercial potential confirmed']) await user.click(screen.getByRole('checkbox', { name }));
    await waitFor(() => expect(convert).toBeEnabled());
    await user.click(convert);
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/leads/l1/convert')?.body).toEqual({ requirement_confirmed: true, timeline_confirmed: true, commercial_potential_confirmed: true }));
  });

  it('shows the exact reason from the convert check when something is missing', async () => {
    const user = userEvent.setup();
    open(base());
    await user.click(await screen.findByText('Asha Patel'));
    expect(await screen.findByText('Save the site details first.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Convert to opportunity' })).toBeDisabled();
  });

  it('NO branch moves the lead to nurture with a reason and a date', async () => {
    const user = userEvent.setup();
    const { api } = open(base({ 'POST /leads/l1/nurture': { data: { id: 'l1' } } }));
    await user.click(await screen.findByText('Asha Patel'));
    const nurture = await screen.findByRole('button', { name: 'Nurture / recycle' });
    expect(nurture).toBeDisabled();
    await user.type(screen.getByLabelText('Reason'), 'Not buying this year');
    await user.type(screen.getByLabelText('Re-engagement date'), '2030-01-15');
    await user.click(nurture);
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/leads/l1/nurture')?.body).toEqual({ reason: 'Not buying this year', nurture_until: '2030-01-15' }));
  });

  it('above 10 kW shows the DISCOM dates and the deemed-feasible line for a scheduled visit', async () => {
    const user = userEvent.setup();
    const scheduled = { id: 'sv1', lead_id: 'l1', status: 'scheduled', scheduled_at: '2030-02-01T10:00:00.000Z', surveyed_at: null };
    open(base({
      'GET /surveys': page([scheduled]),
      'GET /surveys/sv1': { data: { ...scheduled, notes: null, photo_count: 0, feasibility: { kw: 12, required: true, status: 'pending', threshold_kw: 10, days_allowed: 15, deemed_enabled: true, application_submitted_at: '2030-02-02T00:00:00.000Z', application_complete_at: null, due_at: null, message: null } } },
    }));
    await user.click(screen.getByRole('button', { name: /Scheduled/ }));
    await user.click(await screen.findByText('Asha Patel'));
    expect(await screen.findByText(/Deemed feasible after 15 days/)).toBeInTheDocument();
    expect(screen.getByText('DISCOM feasibility study')).toBeInTheDocument();
  });

  it('lists by pill and shows empty and error states', async () => {
    const user = userEvent.setup();
    open(base({ 'GET /leads': page([]) }));
    expect(await screen.findByText('No visits waiting to be scheduled')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Done/ }));
    expect(await screen.findByText('No completed visits yet')).toBeInTheDocument();
  });

  it('shows an error state with retry', async () => {
    open(base({ 'GET /leads': { status: 500, body: { error: { code: 'ERROR', message: 'Boom' } } } }));
    expect(await screen.findByText('Boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again|retry/i })).toBeInTheDocument();
  });
});

describe('Opportunities', () => {
  const opp = { id: 'o1', name: 'Patel Industries 12 kW', kw: 12, expected_value: 600000, probability: 60, expected_close_date: '2030-03-01', competitor: null, stage: 'qualified' };

  it('lists open opportunities and sends the five PDF fields on save', async () => {
    const user = userEvent.setup();
    const { api } = open(
      { 'GET /opportunities': page([opp]), 'GET /opportunities/o1': { data: { ...opp, quotes: [] } }, 'PATCH /opportunities/o1': { data: opp } },
      '/site?tab=opportunities',
    );
    expect(await screen.findByText('Patel Industries 12 kW')).toBeInTheDocument();
    for (const name of ['Open', 'Won', 'Lost']) expect(screen.getByRole('button', { name })).toBeInTheDocument();
    await user.click(screen.getByText('Patel Industries 12 kW'));
    const dlg = await screen.findByRole('dialog', { name: /Update opportunity/ });
    const f = within(dlg);
    for (const [label, value] of [['Probability %', '75'], ['Expected size (kW)', '15'], ['Revenue (₹)', '750000'], ['Expected closing date', '2030-04-01']] as const) {
      const input = f.getByLabelText(new RegExp(label.replace(/[()₹%]/g, '\\$&')));
      await user.clear(input);
      await user.type(input, value);
    }
    await user.type(f.getByLabelText(/Competitor/), 'Tata Power Solar');
    expect(f.getByRole('button', { name: 'Create quotation' })).toBeInTheDocument();
    await user.click(f.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PATCH' && c.path === '/opportunities/o1')?.body).toEqual({
      probability: 75, kw: 15, expected_value: 750000, expected_close_date: '2030-04-01', competitor: 'Tata Power Solar',
    }));
  });

  it('Create quotation posts the opportunity and opens the quote', async () => {
    const user = userEvent.setup();
    const { api } = open(
      { 'GET /opportunities': page([opp]), 'GET /opportunities/o1': { data: { ...opp, quotes: [] } }, 'POST /quotes': { data: { id: 'q1' } } },
      '/site?tab=opportunities',
    );
    await user.click(await screen.findByText('Patel Industries 12 kW'));
    await user.click(await screen.findByRole('button', { name: 'Create quotation' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/quotes')?.body).toEqual({ opportunity_id: 'o1' }));
  });

  it('shows an empty state', async () => {
    open({ 'GET /opportunities': page([]) }, '/site?tab=opportunities');
    expect(await screen.findByText('No opportunities here')).toBeInTheDocument();
  });
});

describe('Site visits - nothing disappears once it is done', () => {
  it('a lead that already became an opportunity stays under Done', async () => {
    const user = userEvent.setup();
    const moved = { ...lead, id: 'l9', name: 'Meera Joshi', status: 'opportunity' };
    const done = { id: 'sv9', lead_id: 'l9', status: 'completed', scheduled_at: '2026-10-20T05:00:00Z', surveyed_at: '2026-10-20T06:00:00Z' };
    const { api } = open(base({ 'GET /leads': page([moved]), 'GET /surveys': page([done]) }));
    await user.click(await screen.findByRole('button', { name: /Done/ }));
    expect(await screen.findByText('Meera Joshi')).toBeInTheDocument();
    expect(screen.getByText(/Done · Opportunity/)).toBeInTheDocument();
    expect(api.calls.find((c) => c.path === '/leads')).toBeTruthy();
  });
});

describe('Opportunities - closing and reopening', () => {
  const base = { id: 'o2', name: 'Shah Textiles 40 kW', kw: 40, expected_value: 2000000, probability: 50, expected_close_date: '2030-03-01', competitor: null };

  it('an open opportunity can be marked lost with a reason', async () => {
    const user = userEvent.setup();
    const { api } = open({ 'GET /opportunities': page([{ ...base, stage: 'quotation' }]), 'GET /opportunities/o2': { data: { ...base, stage: 'quotation', quotes: [] } }, 'POST /opportunities/o2/lose': { data: {} } }, '/site?tab=opportunities');
    await user.click(await screen.findByText('Shah Textiles 40 kW'));
    const drawer = await screen.findByRole('dialog', { name: /Update opportunity/ });
    await user.click(within(drawer).getByRole('button', { name: 'Mark lost' }));
    const dlg = await screen.findByRole('dialog', { name: /Mark this opportunity as lost/ });
    const go = within(dlg).getByRole('button', { name: 'Mark lost' });
    expect(go).toBeDisabled();
    await user.type(within(dlg).getByRole('textbox'), 'Went with a competitor');
    await user.click(go);
    await waitFor(() => expect(api.calls.find((c) => c.path === '/opportunities/o2/lose')?.body).toEqual({ reason: 'Went with a competitor' }));
  });

  it('a lost opportunity shows its details, links to the quotation and can be reopened', async () => {
    const user = userEvent.setup();
    const quotes = [{ id: 'q7', quote_no: 'FS/Q/26/0007', version: 1, status: 'rejected' }];
    const { api } = open({ 'GET /opportunities': page([{ ...base, stage: 'lost' }]), 'GET /opportunities/o2': { data: { ...base, stage: 'lost', quotes } }, 'POST /opportunities/o2/reopen': { data: {} } }, '/site?tab=opportunities');
    await user.click(await screen.findByRole('button', { name: 'Lost' }));
    await user.click(await screen.findByText('Shah Textiles 40 kW'));
    const dlg = await screen.findByRole('dialog', { name: /Update opportunity/ });
    expect(within(dlg).getByText(/This opportunity was lost/)).toBeInTheDocument();
    expect(await within(dlg).findByRole('link', { name: 'Open quotation' })).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: 'Reopen opportunity' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/opportunities/o2/reopen')).toBe(true));
  });
});
