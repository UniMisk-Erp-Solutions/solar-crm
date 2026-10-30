import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ClockType, SlaDashboard } from '@solar/shared';
import { Card, ErrorState, SkeletonRows } from '@/components/ui/surface';
import { useGet } from '@/lib/query';
import { StepRow } from './StepRow';

export const PATH = ['Distributor', 'DSM', 'Sales Manager', 'Management'];

const ROWS: { key: string; label: string; clocks: ClockType[] }[] = [
  { key: 'unaccepted', label: 'Unaccepted lead', clocks: ['lead_acceptance'] },
  { key: 'followup', label: 'Overdue follow-up', clocks: ['followup'] },
  { key: 'approval', label: 'Pending approval', clocks: ['approval'] },
  { key: 'payment', label: 'Pending payment / credit', clocks: ['payment_reminder'] },
  { key: 'response', label: 'No customer response', clocks: ['quote_followup'] },
];

interface Item { id: string; title: string; detail: string; level: number; path: string }

function itemsFor(d: SlaDashboard, clocks: ClockType[]): Item[] {
  const fromClocks: Item[] = d.breaches.filter((b) => clocks.includes(b.clock_type)).map((b) => ({
    id: b.clock_id, title: b.entity_label ?? b.label, detail: `${b.label} — overdue ${b.age_label}${b.owner_name ? ` · ${b.owner_name}` : ''}`, level: Math.min(3, b.escalated_level), path: b.path,
  }));
  if (!clocks.includes('followup')) return fromClocks;
  const seen = new Set(fromClocks.map((i) => i.path));
  const fus: Item[] = d.overdue_followups.filter((f) => !seen.has(f.path)).map((f) => ({
    id: f.followup_id, title: f.lead_name, detail: `Follow-up (${f.kind}) — overdue ${f.overdue_label}${f.owner_name ? ` · ${f.owner_name}` : ''}`, level: Math.min(3, f.escalated_level), path: f.path,
  }));
  return [...fromClocks, ...fus];
}

export default function EscalationsTab() {
  const q = useGet<SlaDashboard>('/dashboards/sla');
  const [open, setOpen] = useState<string | null>(null);
  if (q.error) return <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />;
  if (q.isLoading || !q.data) return <SkeletonRows />;
  const d = q.data;
  return (
    <div className="space-y-4">
      <p className="text-[15px] text-muted">When something waits too long it moves one step up this path.</p>
      {ROWS.map((r) => {
        const items = itemsFor(d, r.clocks);
        const isOpen = open === r.key;
        const top = items.length ? Math.max(...items.map((i) => i.level)) : undefined;
        return (
          <Card key={r.key} className="p-0">
            <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.key)} className="flex w-full flex-wrap items-center gap-x-8 gap-y-3 px-6 py-5 text-left">
              <span className="min-w-[210px]">
                <span className="block font-semibold">{r.label}</span>
                <span className="text-sm text-muted"><span className="tabular font-bold text-fg">{items.length}</span> waiting right now</span>
              </span>
              <span className="flex-1"><StepRow steps={PATH} current={top} /></span>
              {isOpen ? <ChevronUp className="h-5 w-5 text-muted" aria-hidden /> : <ChevronDown className="h-5 w-5 text-muted" aria-hidden />}
            </button>
            {isOpen && (
              <div className="border-t border-border px-6 py-4">
                {items.length === 0 ? <p className="text-sm text-muted">Nothing is waiting here.</p> : (
                  <ul className="divide-y divide-border">
                    {items.map((i) => (
                      <li key={i.id} className="flex flex-wrap items-center justify-between gap-4 py-3">
                        <div>
                          <Link to={i.path} className="font-semibold text-primary-text hover:underline">{i.title}</Link>
                          <p className="text-sm text-muted">{i.detail}</p>
                        </div>
                        <StepRow steps={PATH} current={i.level} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
