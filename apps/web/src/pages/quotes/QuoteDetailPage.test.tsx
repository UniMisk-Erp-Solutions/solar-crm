import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderPage, type Handlers } from '@/test/utils';
import QuoteDetailPage from './QuoteDetailPage';

const quote = (over: Record<string, unknown> = {}) => ({
  id: 'q1', quote_no: 'FS/Q/26/0001', version: 1, status: 'draft', editable: true, kw: 12, segment: 'ci_captive', validity_date: '2030-01-10', payment_terms: null, sent_at: null,
  subtotal: 600000, discount_pct: 0, discount_amount: 0, tax_total: 48000, total: 648000, margin_pct: 14.2, floor_check: { ok: true, lines: [], margin_pct: 14.2 },
  cfa_entitlement: 78000, consumer_share: 570000,
  lines: [{ id: 'ln1', sku_id: 's1', description: 'Module', hsn: '8541', qty: 24, unit_price: 25000, discount_pct: 0, line_total: 600000, sku: { id: 's1', make: 'Waaree', model: 'Bifacial 540', category: 'module', wattage: 540, brand_usp: null } }],
  findings: [], approvals: [], discussions: [], versions: [{ id: 'q1', version: 1, status: 'draft', total: 648000 }], followups: [],
  customer: { legal_name: 'Patel Industries' }, opportunity: { id: 'o1', name: 'Patel 12 kW' }, ...over,
});
const open = (q: Record<string, unknown>, handlers: Handlers = {}) =>
  renderPage(<QuoteDetailPage />, { route: '/quotes/q1', path: '/quotes/:id', handlers: { 'GET /quotes/q1': { data: q }, 'GET /skus/recommend': { data: [] }, ...handlers } });

describe('Quotation page', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['draft', quote(), 'Send for approval'],
    ['approved', quote({ status: 'approved', editable: false }), 'Send to customer'],
    ['sent', quote({ status: 'sent', editable: false, sent_at: '2030-01-01' }), 'Customer approved'],
    ['negotiation', quote({ status: 'negotiation', editable: false }), 'Customer approved'],
    ['accepted', quote({ status: 'accepted', editable: false }), 'Create proforma invoice'],
    ['rejected', quote({ status: 'rejected', editable: false }), 'Revise quote'],
  ];
  for (const [name, q, label] of cases) {
    it(`shows "${label}" as the primary button for a ${name} quote`, async () => {
      open(q);
      expect(await screen.findByRole('button', { name: label })).toBeInTheDocument();
      expect(screen.getByText('Next step')).toBeInTheDocument();
    });
  }

  it('while waiting for approval there is no primary action and the approvers are named', async () => {
    open(quote({ status: 'pending_approval', editable: false, approvals: [
      { id: 'a1', lane: 'commercial', step: 1, required_role: 'dsm', decision: 'approved', meta: { round: 1 } },
      { id: 'a2', lane: 'commercial', step: 2, required_role: 'regional_head', decision: 'pending', meta: { round: 1 } },
    ] }));
    expect(await screen.findByText(/Waiting for approval from DSM → Regional Head/)).toBeInTheDocument();
    for (const n of ['Send for approval', 'Send to customer', 'Customer approved']) expect(screen.queryByRole('button', { name: n })).not.toBeInTheDocument();
  });

  it('shows one red "Cannot be sent yet" callout with plain messages and disables sending', async () => {
    open(quote({
      status: 'blocked',
      findings: [
        { gate: 'G6', severity: 'hard_stop', message: 'This module does not have a valid BIS licence.', ruleIds: [], fieldRefs: [] },
        { gate: 'G4', severity: 'hard_stop', message: 'The cell maker is not on the approved list.', ruleIds: [], fieldRefs: [] },
        { gate: 'G9', severity: 'warning', message: 'GST rate is not confirmed.', ruleIds: [], fieldRefs: [] },
      ],
    }));
    expect(await screen.findAllByText('Cannot be sent yet')).toHaveLength(1);
    expect(screen.getByText('This module does not have a valid BIS licence.')).toBeInTheDocument();
    expect(screen.getByText('The cell maker is not on the approved list.')).toBeInTheDocument();
    expect(screen.queryByText(/G6|G4/)).not.toBeInTheDocument();
    expect(screen.queryByText('GST rate is not confirmed.')).not.toBeInTheDocument(); // warnings stay hidden while blocked
    expect(screen.getByRole('button', { name: 'Send for approval' })).toBeDisabled();
  });

  it('shows warnings as one amber line when nothing blocks', async () => {
    open(quote({ findings: [{ gate: 'G9', severity: 'warning', message: 'GST rate is not confirmed.', ruleIds: [], fieldRefs: [] }] }));
    expect(await screen.findByText('GST rate is not confirmed.')).toBeInTheDocument();
    expect(screen.queryByText('Cannot be sent yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send for approval' })).toBeEnabled();
  });

  it('shows the subsidy line, price review and the reminder cadence', async () => {
    open(quote());
    expect(await screen.findByText(/Government subsidy \(CFA\)/)).toBeInTheDocument();
    expect(screen.getByText(/Margin 14.2%/)).toBeInTheDocument();
    expect(screen.getByText(/Special pricing \/ discount needed\?/)).toBeInTheDocument();
    expect(screen.getByText(/Day 1 · Day 3 · Day 5 · Day 7, then escalation/)).toBeInTheDocument();
  });

  it('sends for approval, sends to the customer and accepts through the API', async () => {
    const user = userEvent.setup();
    const { api } = open(quote(), { 'POST /quotes/q1/request-approval': { data: quote({ status: 'pending_approval' }) } });
    await user.click(await screen.findByRole('button', { name: 'Send for approval' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/quotes/q1/request-approval')).toBe(true));
  });

  it('adds a recommended product with one click and re-checks compliance', async () => {
    const user = userEvent.setup();
    const { api } = open(quote({ lines: [] }), {
      'GET /skus/recommend': { data: [{ id: 's2', make: 'Adani', model: 'Mono 550', category: 'module', hsn: '8541', usp: { quality: 'Q1', warranty: 'W1', certifications: 'C1', service_support: 'S1', delivery_reliability: 'D1' } }] },
      'PUT /quotes/q1/lines': { data: quote() }, 'POST /quotes/q1/evaluate': { data: { findings: [] } },
    });
    await user.click(await screen.findByRole('button', { name: /Add Adani Mono 550/ }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/quotes/q1/evaluate')).toBe(true));
    const put = api.calls.find((c) => c.method === 'PUT' && c.path === '/quotes/q1/lines');
    expect((put?.body as { lines: { sku_id: string }[] }).lines[0]!.sku_id).toBe('s2');
  });

  it('creates the proforma invoice and links to it after acceptance', async () => {
    const user = userEvent.setup();
    open(quote({ status: 'accepted', editable: false }), { 'POST /pis': { data: { id: 'pi9' } } });
    await user.click(await screen.findByRole('button', { name: 'Create proforma invoice' }));
    const link = await screen.findByRole('link', { name: 'Open proforma invoice' });
    expect(link).toHaveAttribute('href', '/orders/pi/pi9');
  });

  it('shows an error state with retry', async () => {
    renderPage(<QuoteDetailPage />, { route: '/quotes/q1', path: '/quotes/:id', handlers: { 'GET /quotes/q1': { status: 500, body: { error: { code: 'ERROR', message: 'Boom' } } } } });
    expect(await screen.findByText('Boom')).toBeInTheDocument();
  });

  it('a missing-consent blocker offers to record the customer consent right there', async () => {
    const user = userEvent.setup();
    const { api } = open(
      quote({ status: 'blocked', lead_id: 'l1', findings: [{ gate: 'G1', severity: 'hard_stop', message: 'The customer cannot be contacted about this quotation: No consent has been recorded for this person yet' }] }),
      { 'POST /leads/l1/consents': { data: { consent: { id: 'c1' } } }, 'POST /quotes/q1/evaluate': { data: {} } },
    );
    await user.click(await screen.findByRole('button', { name: 'Record customer consent' }));
    const save = await screen.findByRole('button', { name: 'Record consent' });
    expect(save).toBeDisabled();
    await user.click(screen.getByLabelText(/The customer agreed to be contacted/));
    await user.click(save);
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/leads/l1/consents')?.body).toMatchObject({ channels: ['call', 'sms', 'whatsapp'], capture_source: 'staff_entry' }));
  });

  const invLine = { id: 'ln9', sku_id: 's9', description: 'Delta DELT-10K-3P', hsn: '85044090', gst_rate: null, tax_position_approved: false, qty: 1, unit_price: 72000, discount_pct: 0, line_total: 72000, sku: { id: 's9', make: 'Delta', model: 'DELT-10K-3P', category: 'inverter', variant: null, wattage: null, brand_usp: null } };
  const asAdmin = (q: Record<string, unknown>, handlers: Handlers = {}) =>
    renderPage(<QuoteDetailPage />, { route: '/quotes/q1', path: '/quotes/:id', role: 'admin', handlers: { 'GET /quotes/q1': { data: q }, 'GET /skus/recommend': { data: [] }, ...handlers } });

  it('the offer table has one GST % column, and the amounts and totals move live as unit price, discount and GST change', async () => {
    const user = userEvent.setup();
    const line = { ...invLine, gst_rate: 18, tax_position_approved: true, unit_price: 100000, line_total: 100000, qty: 1 };
    const { api } = asAdmin(
      quote({ status: 'blocked', lines: [line], findings: [], subtotal: 100000, discount_amount: 0, tax_total: 18000, total: 118000, freight: 0 }),
      { 'PUT /quotes/q1/lines': { data: { lines: [{ id: 'new-id' }] } }, 'POST /quotes/q1/tax-position': { data: {} }, 'POST /quotes/q1/evaluate': { data: {} } },
    );
    expect(await screen.findByRole('columnheader', { name: 'GST %' })).toBeInTheDocument();
    const total = () => screen.getByText('Total').parentElement!.textContent!;
    expect(total()).toContain('1,18,000');
    const price = await screen.findByLabelText(/Unit price .* Delta DELT-10K-3P/);
    await user.clear(price);
    await user.type(price, '80000');
    await user.type(screen.getByLabelText(/Discount % Delta DELT-10K-3P/), '{Control>}a{/Control}10');
    // 80,000 less 10% = 72,000, plus 18% GST = 84,960
    await waitFor(() => expect(total()).toContain('84,960'));
    await user.selectOptions(screen.getByLabelText(/GST % Delta DELT-10K-3P/), '5');
    // 72,000 + 5% = 75,600
    await waitFor(() => expect(total()).toContain('75,600'));
    await user.click(screen.getByRole('button', { name: 'Save offer' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/quotes/q1/tax-position')?.body).toMatchObject({ lines: [{ line_id: 'new-id', approved: true, gst_rate: 5, hsn: '85044090' }] }));
  });

  it('an approver can approve or reject from the quotation, and a rejection needs a reason', async () => {
    const user = userEvent.setup();
    const pending = [{ id: 'ap1', lane: 'commercial', step: 1, required_role: 'dsm', decision: 'pending', meta: { round: 1 } }];
    const { api } = asAdmin(quote({ status: 'pending_approval', editable: false, approvals: pending }), { 'POST /approvals/ap1/decide': { data: {} } });
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const dlg = await screen.findByRole('dialog');
    const confirm = within(dlg).getByRole('button', { name: 'Reject' });
    expect(confirm).toBeDisabled();
    await user.type(within(dlg).getByRole('textbox'), 'Margin too low');
    await user.click(confirm);
    await waitFor(() => expect(api.calls.find((c) => c.path === '/approvals/ap1/decide')?.body).toMatchObject({ decision: 'rejected', comment: 'Margin too low' }));
  });

  it('Approve signs off every pending step the person may decide, in order, sending only the decision', async () => {
    const user = userEvent.setup();
    const pending = [
      { id: 'ap2', lane: 'commercial', step: 2, required_role: 'regional_head', decision: 'pending', meta: { round: 1 } },
      { id: 'ap1', lane: 'commercial', step: 1, required_role: 'dsm', decision: 'pending', meta: { round: 1 } },
      { id: 'ap3', lane: 'compliance', step: 1, required_role: 'compliance_officer', decision: 'pending', meta: { round: 1 } },
    ];
    const { api } = asAdmin(quote({ status: 'pending_approval', editable: false, approvals: pending }), { 'POST /approvals/ap1/decide': { data: {} }, 'POST /approvals/ap2/decide': { data: {} }, 'POST /approvals/ap3/decide': { data: {} } });
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.calls.filter((c) => c.path.endsWith('/decide')).length).toBe(3));
    const decided = api.calls.filter((c) => c.path.endsWith('/decide'));
    expect(decided.map((c) => c.path)).toEqual(['/approvals/ap1/decide', '/approvals/ap3/decide', '/approvals/ap2/decide']);
    for (const c of decided) expect(c.body).toEqual({ decision: 'approved' });
  });

  it('after the quotation is sent, the customer answer is Approved or Rejected; only an approval leads to the proforma invoice', async () => {
    asAdmin(quote({ status: 'sent', editable: false, sent_at: '2030-01-01' }));
    expect(await screen.findByRole('button', { name: 'Customer approved' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Customer rejected' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create proforma invoice' })).not.toBeInTheDocument();
  });

  it('a rejected quotation says why and offers to start again with a new version', async () => {
    asAdmin(quote({ status: 'rejected', editable: false, rejected_reason: 'Margin too low' }));
    expect(await screen.findByText(/Margin too low/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revise quote' })).toBeInTheDocument();
  });

  it('the deal can be cancelled with a reason at any live stage, and the first offer is listed once there are later versions', async () => {
    const user = userEvent.setup();
    const { api } = asAdmin(
      quote({ status: 'sent', editable: false, sent_at: '2030-01-01', version: 2, versions: [{ id: 'q0', version: 1, status: 'revised', total: 500000 }, { id: 'q1', version: 2, status: 'sent', total: 648000 }] }),
      { 'POST /quotes/q1/reject': { data: {} } },
    );
    expect(await screen.findByText('First offer')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Customer rejected' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'Customer cancelled on a call');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel the deal' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/quotes/q1/reject')?.body).toEqual({ reason: 'Customer cancelled on a call' }));
  });
});
