import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderPage } from '@/test/utils';
import ControlModule from './ControlModule';

const gates = ['valid_lead', 'qualified_lead', 'opportunity', 'quotation', 'pi', 'sales_order'].map((key, i) => ({ key, label: ['Valid Lead', 'Qualified Lead', 'Opportunity', 'Quotation', 'PI', 'Sales Order'][i], count: 60 - i * 8 }));
const kpi = (key: string, value: number) => ({ key, label: key, value, unit: 'pct', definition: '' });
const funnel = { gates, kpis: ['conv_inquiry_to_qualified', 'conv_qualified_to_opportunity', 'conv_opportunity_to_quotation', 'conv_quotation_to_pi', 'conv_pi_to_sales_order'].map((k, i) => kpi(k, 70 - i * 10)) };
const sla = {
  kpis: [kpi('first_response_24h_pct', 91.5), kpi('followup_compliance_pct', 84)],
  breaches: [
    { clock_id: 'c1', clock_type: 'lead_acceptance', label: 'Lead acceptance', entity_type: 'lead', entity_id: 'l1', entity_label: 'Ramesh Patel', owner_name: 'Alpha Solar', age_label: '2 h', escalated_level: 2, path: '/leads/l1' },
    { clock_id: 'c2', clock_type: 'approval', label: 'Approval', entity_type: 'quotation', entity_id: 'q1', entity_label: 'FS/Q/26/0001', owner_name: null, age_label: '5 h', escalated_level: 1, path: '/quotes/q1' },
  ],
  overdue_followups: [],
  escalations_by_level: [], escalation_triggers: [],
};
const handlers = { 'GET /dashboards/funnel': { data: funnel }, 'GET /dashboards/sla': { data: sla } };

describe('Control', () => {
  it('shows six gates and seven KPIs with definitions', async () => {
    renderPage(<ControlModule />, { role: 'admin', route: '/control', handlers });
    const row = await screen.findByRole('list', { name: 'Conversion gates' });
    expect(within(row).getAllByRole('listitem')).toHaveLength(6);
    const tiles = screen.getByRole('region', { name: 'The seven KPIs' });
    expect(within(tiles).getAllByRole('article')).toHaveLength(7);
    expect(within(tiles).getByText('First response SLA')).toBeInTheDocument();
    expect(within(tiles).getByText(/Follow-ups completed on or before their due time/)).toBeInTheDocument();
    expect(within(tiles).getByText('91.5%')).toBeInTheDocument();
  });

  it('shows five escalation rows with the four-level path and expands items', async () => {
    renderPage(<ControlModule />, { role: 'admin', route: '/control?tab=escalations', handlers });
    for (const label of ['Unaccepted lead', 'Overdue follow-up', 'Pending approval', 'Pending payment / credit', 'No customer response']) expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { expanded: false })).toHaveLength(5);
    expect(screen.getAllByLabelText('Escalation path')).toHaveLength(5);
    const first = screen.getAllByLabelText('Escalation path')[0]!;
    expect(within(first).getAllByRole('listitem').map((n) => n.textContent)).toEqual(['Distributor', 'DSM', 'Sales Manager', 'Management']);
    expect(within(first).getByText('Sales Manager')).toHaveAttribute('aria-current', 'step');
    await userEvent.click(screen.getByText('Unaccepted lead'));
    expect(screen.getByRole('link', { name: 'Ramesh Patel' })).toHaveAttribute('href', '/leads/l1');
  });
});
