import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderPage } from '@/test/utils';
import PublicLeadFormPage from './PublicLeadFormPage';

const KEY = 'fs_website_0123456789abcdef';
const base = {
  'GET /public/consent-notice': { data: { notice_version: 'v3', body: 'We may contact you about this enquiry.', purposes: [{ value: 'service' }], channels: [{ value: 'call' }] } },
  'GET /public/pincode/380001': { data: { pincode: '380001', city: 'Ahmedabad', district: 'Ahmedabad', state: 'Gujarat' } },
};

describe('PublicLeadFormPage', () => {
  it('has no app shell, sends the key, and thanks without revealing routing', async () => {
    const user = userEvent.setup();
    const { api, container } = renderPage(<PublicLeadFormPage />, {
      route: `/apply?key=${KEY}`, path: '/apply',
      handlers: { ...base, 'POST /public/leads': { data: { lead_id: 'secret', reference: 'FS-1', assigned_to: 'Alpha Solar', duplicate_of: 'x' } } },
    });
    await user.type(await screen.findByLabelText(/your name/i), 'Asha Patel');
    await user.type(screen.getByLabelText(/mobile number/i), '98765 43210');
    await user.type(screen.getByLabelText(/pincode/i), '380001');
    expect(await screen.findByText('Ahmedabad, Gujarat')).toBeInTheDocument();
    expect(await screen.findByText('We may contact you about this enquiry.')).toBeInTheDocument();
    await user.click(screen.getByLabelText(/i agree/i));
    await user.click(screen.getByRole('button', { name: /call back/i }));
    expect(await screen.findByText(/within 30 minutes/i)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Alpha Solar|FS-1|secret/);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    const post = api.calls.find((c) => c.method === 'POST' && c.path === '/public/leads')!;
    await waitFor(() => expect(post.body).toMatchObject({ name: 'Asha Patel', mobile: '+919876543210', pincode: '380001', consent: { notice_version: 'v3', channels: ['call'] } }));
    const hdr = (api.fetch.mock.calls.find((c) => String(c[0]).includes('/public/leads'))![1] as RequestInit).headers as Record<string, string>;
    expect(hdr['X-Api-Key']).toBe(KEY);
  });

  it('asks for a complete link when the key is missing', async () => {
    renderPage(<PublicLeadFormPage />, { route: '/apply', path: '/apply', handlers: {} });
    expect(await screen.findByText(/form link is not complete/i)).toBeInTheDocument();
  });
});
