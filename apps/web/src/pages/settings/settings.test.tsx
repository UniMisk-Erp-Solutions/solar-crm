import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderPage } from '@/test/utils';
import SettingsPage from './SettingsPage';

describe('Settings', () => {
  it('saves an SLA value as a new version set by the admin', async () => {
    const { api } = renderPage(<SettingsPage />, {
      role: 'admin', route: '/settings',
      handlers: {
        'GET /admin/sla': { data: [{ key: 'lead_acceptance_minutes.hot', value: 30 }, { key: 'quote_followup_days', value: [1, 3, 5, 7] }] },
        'PUT /admin/sla': { data: [] },
      },
    });
    const field = await screen.findByLabelText('Hot lead — accept within');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await userEvent.clear(field);
    await userEvent.type(field, '20');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT' && c.path === '/admin/sla')).toBe(true));
    const put = api.calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toMatchObject({ key: 'lead_acceptance_minutes.hot', value: 20, source_name: 'Set by admin in Settings' });
    expect(await screen.findByText('Account')).toBeInTheDocument();
  });
});
