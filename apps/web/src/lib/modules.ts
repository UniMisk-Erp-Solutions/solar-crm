import { BarChart3, ClipboardList, FileText, Inbox, MapPinned, type LucideIcon } from 'lucide-react';

/**
 * The product is the company's flow chart. Five modules, in flow order, each with at most three sections.
 * Everything else (reminders, scoring, routing, recommendations, compliance checks, clocks) runs in the backend.
 */
export interface ModuleSection { key: string; label: string; steps: string }
export interface ModuleDef {
  key: 'leads' | 'site' | 'quotes' | 'orders' | 'control';
  label: string;
  path: string;
  icon: LucideIcon;
  steps: string;
  blurb: string;
  sections: ModuleSection[];
}

export const MODULES: ModuleDef[] = [
  {
    key: 'leads', label: 'Leads', path: '/leads', icon: Inbox, steps: 'Steps 1–13',
    blurb: 'Capture every enquiry, assign it to a distributor, then follow it up until it is qualified.',
    sections: [
      { key: 'inquiries', label: 'Inquiries', steps: 'Steps 1–7' },
      { key: 'followups', label: 'Follow-ups', steps: 'Steps 8–13' },
    ],
  },
  {
    key: 'site', label: 'Site & Opportunity', path: '/site', icon: MapPinned, steps: 'Steps 14–20',
    blurb: 'Visit the site, capture the requirement, agree the rate, and turn a real project into an opportunity.',
    sections: [
      { key: 'visits', label: 'Site visits', steps: 'Steps 14–18' },
      { key: 'opportunities', label: 'Opportunities', steps: 'Steps 19–20' },
    ],
  },
  {
    key: 'quotes', label: 'Quotation', path: '/quotes', icon: FileText, steps: 'Steps 21–27',
    blurb: 'Prepare the offer, get discounts approved, send it, and confirm the commercial terms.',
    sections: [
      { key: 'quotations', label: 'Quotations', steps: 'Steps 21–22, 24–27' },
      { key: 'approvals', label: 'Approvals', steps: 'Step 23' },
    ],
  },
  {
    key: 'orders', label: 'Order', path: '/orders', icon: ClipboardList, steps: 'Steps 28–34',
    blurb: 'Raise the proforma invoice, verify payment or credit, create the sales order and hand it to dispatch.',
    sections: [
      { key: 'invoices', label: 'Proforma & payment', steps: 'Steps 28–30' },
      { key: 'orders', label: 'Sales orders', steps: 'Steps 31–34' },
    ],
  },
  {
    key: 'control', label: 'Control', path: '/control', icon: BarChart3, steps: 'Stage 6',
    blurb: 'Conversion gates, the seven KPIs and everything that has been escalated.',
    sections: [
      { key: 'kpis', label: 'KPIs', steps: 'Conversion gates and KPIs' },
      { key: 'escalations', label: 'Escalations', steps: 'Who is waiting on whom' },
    ],
  },
];

export const moduleByKey = (key: ModuleDef['key']): ModuleDef => MODULES.find((m) => m.key === key)!;
