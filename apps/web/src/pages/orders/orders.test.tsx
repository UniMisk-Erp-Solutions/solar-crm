import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { page, renderPage } from '@/test/utils';
import OrdersModule from './OrdersModule';
import PiDetailPage from './PiDetailPage';
import SoDetailPage from './SoDetailPage';

const checklist = { legal_name: true, billing_address: true, shipping_address: false, gst: false, product: true, quantity: true, price: true, freight: true, payment_terms: true };
const basePi = {
  id: 'p1', pi_no: 'FS/PI/26/0001', status: 'draft', legal_name: 'Sun Homes', dealer_id: null, dealer_name: null, total: 500000, paid_amount: 0, balance: 500000, pre_pi_checklist: checklist,
  lines: [], payments: [], advance_pct: 30, required_advance: 150000, advance_ok: false, credit_checks: [], credit_check: null, credit_overrides: [], approvals: [], sales_order: null, missing_labels: [], unregistered: false, issue_date: null, valid_till: null,
};
const baseSo = {
  id: 's1', so_no: 'FS/SO/26/0001', pi_id: 'p1', pi_no: 'FS/PI/26/0001', status: 'approved', total: 500000, customer_name: 'Sun Homes', dealer_name: null, customer_po_no: 'PO-9', customer_po_date: '2026-10-01',
  hold_reason: null, circulated_at: '2026-10-20T05:00:00.000Z', dispatch_handover_at: null, lines: [{ id: 'l1', description: 'Panel 540W', qty: 10, line_total: 200000 }], approvals: [],
};

describe('PI page', () => {
  it('blocks Issue PI and names the missing items', async () => {
    renderPage(<PiDetailPage />, { role: 'admin', route: '/orders/pi/p1', path: '/orders/pi/:id', handlers: { 'GET /pis/p1': { data: basePi } } });
    const btn = await screen.findByRole('button', { name: 'Issue PI' });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/Cannot issue yet — missing: Shipping address, GST/)).toBeInTheDocument();
  });

  it('shows NO when neither advance nor credit, YES when advance is received', async () => {
    const issued = { ...basePi, status: 'issued', pre_pi_checklist: { ...checklist, shipping_address: true, gst: true } };
    const { unmount } = renderPage(<PiDetailPage />, { role: 'admin', route: '/orders/pi/p1', path: '/orders/pi/:id', handlers: { 'GET /pis/p1': { data: issued } } });
    expect(await screen.findByText('Advance received OR credit approved?')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('decision')).toHaveTextContent('NO'));
    expect(screen.getByTestId('decision')).toHaveTextContent('SO on hold, reminder will go to the customer');
    unmount();
    renderPage(<PiDetailPage />, { role: 'admin', route: '/orders/pi/p1', path: '/orders/pi/:id', handlers: { 'GET /pis/p1': { data: { ...issued, advance_ok: true, paid_amount: 200000 } } } });
    await waitFor(() => expect(screen.getByTestId('decision')).toHaveTextContent('YES'));
    expect(screen.getByRole('button', { name: 'Create sales order' })).toBeInTheDocument();
  });
});

describe('PI approval (step 29)', () => {
  const ready = { ...basePi, pre_pi_checklist: { ...checklist, shipping_address: true, gst: true } };
  const open = (pi: Record<string, unknown>, handlers: Record<string, unknown> = {}) =>
    renderPage(<PiDetailPage />, { role: 'admin', route: '/orders/pi/p1', path: '/orders/pi/:id', handlers: { 'GET /pis/p1': { data: pi }, ...handlers } as never });
  const waiting = { ...ready, status: 'pending_approval', approvals: [
    { id: 'a2', entity_type: 'proforma_invoice', lane: 'commercial', step: 2, required_role: 'management', decision: 'pending', comment: null, decided_at: null },
    { id: 'a1', entity_type: 'proforma_invoice', lane: 'commercial', step: 1, required_role: 'accounts', decision: 'pending', comment: null, decided_at: null },
  ] };

  it('an approver sees Approve and Reject on the PI, and Approve signs off every step they may decide, in order', async () => {
    const user = userEvent.setup();
    const { api } = open(waiting, { 'POST /approvals/a1/decide': { data: {} }, 'POST /approvals/a2/decide': { data: {} } });
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.calls.filter((c) => c.path.endsWith('/decide')).length).toBe(2));
    expect(api.calls.filter((c) => c.path.endsWith('/decide')).map((c) => [c.path, c.body])).toEqual([['/approvals/a1/decide', { decision: 'approved' }], ['/approvals/a2/decide', { decision: 'approved' }]]);
  });

  it('Reject needs a reason and sends it back to draft', async () => {
    const user = userEvent.setup();
    const { api } = open(waiting, { 'POST /approvals/a1/decide': { data: {} } });
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const dlg = await screen.findByRole('dialog');
    const go = within(dlg).getByRole('button', { name: 'Reject' });
    expect(go).toBeDisabled();
    await user.type(within(dlg).getByRole('textbox'), 'Wrong freight');
    await user.click(go);
    await waitFor(() => expect(api.calls.find((c) => c.path === '/approvals/a1/decide')?.body).toEqual({ decision: 'rejected', comment: 'Wrong freight' }));
  });

  it('a rejected PI is back in draft and says why, so it can be corrected and issued again', async () => {
    open({ ...ready, status: 'draft', approvals: [{ id: 'a1', lane: 'commercial', step: 1, required_role: 'accounts', decision: 'rejected', comment: 'Wrong freight', decided_at: '2026-10-28T05:00:00Z' }] });
    expect(await screen.findByText(/It was not approved: Wrong freight/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Issue PI' })).toBeEnabled();
  });

  it('the PI can be cancelled with a reason while it is draft, waiting or issued', async () => {
    const user = userEvent.setup();
    const { api } = open(waiting, { 'POST /pis/p1/cancel': { data: {} } });
    await user.click(await screen.findByRole('button', { name: 'Cancel PI' }));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByRole('textbox'), 'Customer called it off');
    await user.click(within(dlg).getByRole('button', { name: 'Cancel the PI' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/pis/p1/cancel')?.body).toEqual({ note: 'Customer called it off' }));
  });
});

describe('SO page', () => {
  it('a sales order can be cancelled with a reason, and a cancelled one says so', async () => {
    const user = userEvent.setup();
    const { api } = renderPage(<SoDetailPage />, { role: 'admin', route: '/orders/so/s1', path: '/orders/so/:id', handlers: { 'GET /sales-orders/s1': { data: baseSo }, 'POST /sales-orders/s1/cancel': { data: {} } } });
    await user.click(await screen.findByRole('button', { name: 'Cancel order' }));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByRole('textbox'), 'Customer withdrew the PO');
    await user.click(within(dlg).getByRole('button', { name: 'Cancel the order' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/sales-orders/s1/cancel')?.body).toEqual({ note: 'Customer withdrew the PO' }));
  });

  it('a cancelled sales order shows no cancel button and says it was cancelled', async () => {
    renderPage(<SoDetailPage />, { role: 'admin', route: '/orders/so/s1', path: '/orders/so/:id', handlers: { 'GET /sales-orders/s1': { data: { ...baseSo, status: 'cancelled' } } } });
    expect(await screen.findByText(/This sales order was cancelled/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument();
  });

  it('shows the items with GST and the final total (amount before GST, GST, freight, total)', async () => {
    const so = { ...baseSo, total: 59000 + 5000, pi: { freight: 5000 }, lines: [
      { id: 'a', description: 'Panel 540W', qty: 10, unit_price: 3000, gst_rate: 12, line_total: 30000 },
      { id: 'b', description: 'Inverter 10K', qty: 1, unit_price: 20000, gst_rate: 18, line_total: 20000 },
    ] };
    renderPage(<SoDetailPage />, { role: 'admin', route: '/orders/so/s1', path: '/orders/so/:id', handlers: { 'GET /sales-orders/s1': { data: so } } });
    const row = async (label: string) => (await screen.findAllByText(label)).find((el) => el.tagName === 'DT')!.parentElement!.textContent!;
    expect(await row('Amount before GST')).toContain('50,000');
    expect(await row('GST')).toContain('7,200'); // 12% of 30,000 + 18% of 20,000
    expect(await row('Freight')).toContain('5,000');
    expect(await row('Total')).toContain('64,000');
    expect(screen.getByText('12%')).toBeInTheDocument();
  });

  it('a sales order waiting for approval has an Approve button and no Reject; Approve signs off every step the person may decide', async () => {
    const waiting = { ...baseSo, status: 'pending_approval', approvals: [
      { id: 'x2', lane: 'commercial', step: 2, required_role: 'management', decision: 'pending' },
      { id: 'x1', lane: 'commercial', step: 1, required_role: 'accounts', decision: 'pending' },
    ] };
    const { api } = renderPage(<SoDetailPage />, {
      role: 'admin', route: '/orders/so/s1', path: '/orders/so/:id',
      handlers: { 'GET /sales-orders/s1': { data: waiting }, 'POST /approvals/x1/decide': { data: {} }, 'POST /approvals/x2/decide': { data: {} } },
    });
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.calls.filter((c) => c.path.endsWith('/decide')).length).toBe(2));
    expect(api.calls.filter((c) => c.path.endsWith('/decide')).map((c) => [c.path, c.body])).toEqual([['/approvals/x1/decide', { decision: 'approved' }], ['/approvals/x2/decide', { decision: 'approved' }]]);
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
  });

  it('hands an approved order over to dispatch planning', async () => {
    const { api } = renderPage(<SoDetailPage />, {
      role: 'admin', route: '/orders/so/s1', path: '/orders/so/:id',
      handlers: { 'GET /sales-orders/s1': { data: baseSo }, 'POST /sales-orders/s1/handover': { data: { ...baseSo, status: 'dispatch_planning' } } },
    });
    expect(await screen.findByText(/Circulated to: Dispatch/)).toBeInTheDocument();
    await userEvent.click((await screen.findAllByRole('button', { name: 'Hand over to dispatch planning' }))[0]!);
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/sales-orders/s1/handover')).toBe(true));
  });

  it('shows the hold reason and releases the hold, with the API refusal in a red callout', async () => {
    const held = { ...baseSo, status: 'on_hold', hold_reason: 'Advance not received', circulated_at: null };
    const { api } = renderPage(<SoDetailPage />, {
      role: 'admin', route: '/orders/so/s1', path: '/orders/so/:id',
      handlers: { 'GET /sales-orders/s1': { data: held }, 'POST /sales-orders/s1/release-hold': { status: 422, body: { error: { code: 'GUARD_BLOCKED', message: 'Dealer is over the credit limit' } } } },
    });
    expect(await screen.findByText(/Advance not received/)).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Release hold' })[0]!);
    expect(await screen.findByText('Dealer is over the credit limit')).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === '/sales-orders/s1/release-hold')).toBe(true);
  });
});

describe('Orders module', () => {
  it('lists proforma invoices and shows an empty state for sales orders', async () => {
    renderPage(<OrdersModule />, {
      role: 'admin', route: '/orders',
      handlers: { 'GET /pis': page([{ ...basePi }]), 'GET /quotes': page([]), 'GET /sales-orders': page([]) },
    });
    expect(await screen.findByText('FS/PI/26/0001')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Sales orders' }));
    expect(await screen.findByText('No sales orders here')).toBeInTheDocument();
  });
});
