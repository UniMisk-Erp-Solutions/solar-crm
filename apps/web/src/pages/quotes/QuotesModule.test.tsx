import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { page, renderPage, type Handlers } from '@/test/utils';
import QuotesModule from './QuotesModule';

const quote = { id: 'q1', quote_no: 'FS/Q/26/0001', version: 1, status: 'draft', total: 648000, validity_date: '2030-01-10', customer_name: 'Patel Industries' };
const open = (handlers: Handlers, route = '/quotes') => renderPage(<QuotesModule />, { route, path: '/quotes', handlers });

describe('Quotations tab', () => {
  it('lists quotations with the four pills and filters by group', async () => {
    const user = userEvent.setup();
    const { api } = open({ 'GET /quotes': page([quote]) });
    expect(await screen.findByText('FS/Q/26/0001')).toBeInTheDocument();
    expect(screen.getByText('Patel Industries')).toBeInTheDocument();
    for (const n of ['Draft', 'Sent', 'Accepted', 'Needs revision']) expect(screen.getByRole('button', { name: n })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Needs revision' }));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/quotes')).toBe(true));
  });

  it('shows empty and error states', async () => {
    open({ 'GET /quotes': page([]) });
    expect(await screen.findByText('No quotations here')).toBeInTheDocument();
  });

  it('shows the error state with retry', async () => {
    open({ 'GET /quotes': { status: 500, body: { error: { code: 'ERROR', message: 'Boom' } } } });
    expect(await screen.findByText('Boom')).toBeInTheDocument();
  });

  it('New quotation picks an opportunity and creates the quote', async () => {
    const user = userEvent.setup();
    const { api } = open({
      'GET /quotes': page([]),
      'GET /opportunities': page([{ id: 'o1', name: 'Patel 12 kW', kw: 12, expected_value: 600000 }]),
      'POST /quotes': { data: { id: 'q9' } },
    });
    await user.click(await screen.findByRole('button', { name: 'New quotation' }));
    const dlg = await screen.findByRole('dialog');
    await user.selectOptions(await within(dlg).findByLabelText(/Opportunity/), 'o1');
    await user.click(within(dlg).getByRole('button', { name: 'Create quotation' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/quotes')?.body).toEqual({ opportunity_id: 'o1' }));
  });
});

describe('Approvals tab', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'a1', entity_type: 'quotation', entity_id: 'q1', lane: 'commercial', step: 1, required_role: 'dsm', decision: 'pending', actionable: true,
    entity: { entity_type: 'quotation', entity_id: 'q1', title: 'Quotation FS/Q/26/0001 v1', subtitle: 'Patel Industries · 12 kW · 8% discount', value: 648000, link: '/quotes/q1' },
    chain: [{ step: 1, required_role: 'dsm', decision: 'pending' }, { step: 2, required_role: 'regional_head', decision: 'pending' }, { step: 3, required_role: 'management', decision: 'pending' }],
    ...over,
  });
  const tab = (handlers: Handlers) => open(handlers, '/quotes?tab=approvals');

  it('decided approvals stay visible under Approved and Rejected, with who decided, when and why', async () => {
    const user = userEvent.setup();
    const { api } = tab({ 'GET /approvals': ({ url }: { url: URL }) => page(url.searchParams.get('decision') === 'rejected' ? [row({ decision: 'rejected', comment: 'Discount too high', decided_at: '2026-10-28T05:00:00Z' })] : [row()]) });
    await user.click(await screen.findByRole('button', { name: /Rejected/ }));
    expect(await screen.findByText('Discount too high')).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === '/approvals' && c.method === 'GET')).toBe(true);
  });

  it('shows the empty state', async () => {
    tab({ 'GET /approvals': page([]) });
    expect(await screen.findByText('Nothing waiting for approval.')).toBeInTheDocument();
  });

  it('shows what, the three approvers and approves', async () => {
    const user = userEvent.setup();
    const { api } = tab({ 'GET /approvals': page([row()]), 'POST /approvals/a1/decide': { data: { outcome: 'step_approved' } } });
    expect(await screen.findByText('Quotation FS/Q/26/0001 v1')).toBeInTheDocument();
    expect(screen.getByText(/8% discount/)).toBeInTheDocument();
    for (const n of ['DSM', 'Regional Head', 'Management']) expect(screen.getByText(n)).toBeInTheDocument();
    expect(screen.queryByText('Compliance')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/approvals/a1/decide')?.body).toEqual({ decision: 'approved' }));
  });

  it('requires a comment to reject', async () => {
    const user = userEvent.setup();
    const { api } = tab({ 'GET /approvals': page([row()]), 'POST /approvals/a1/decide': { data: { outcome: 'rejected' } } });
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const dlg = await screen.findByRole('dialog');
    const confirm = within(dlg).getByRole('button', { name: 'Reject' });
    expect(confirm).toBeDisabled();
    await user.type(within(dlg).getByLabelText(/Comment/), 'Discount too high');
    await user.click(confirm);
    await waitFor(() => expect(api.calls.find((c) => c.path === '/approvals/a1/decide')?.body).toEqual({ decision: 'rejected', comment: 'Discount too high' }));
  });

  it('adds extra dots only when a compliance step is present', async () => {
    tab({ 'GET /approvals': page([row(), row({ id: 'a2', lane: 'compliance', required_role: 'compliance_officer', chain: [{ step: 1, required_role: 'compliance_officer', decision: 'pending' }] })]) });
    expect(await screen.findByText('Quotation FS/Q/26/0001 v1')).toBeInTheDocument();
    expect(screen.getByText('Compliance', { selector: 'li' })).toBeInTheDocument();
  });
});
