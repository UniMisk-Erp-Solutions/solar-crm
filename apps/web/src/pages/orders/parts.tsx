import type { ReactNode } from 'react';
import { Money } from '@/components/domain/values';
import { Callout } from '@/components/ui/surface';
import { errorMessage } from '@/lib/api';

/** The one-line "Next step" statement every record page starts with, with its single button. */
export function NextStep({ text, action }: { text: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-primary/30 bg-primary-soft px-6 py-4">
      <p className="text-[15px] text-primary-text"><span className="font-bold">Next step: </span>{text}</p>
      {action}
    </div>
  );
}

/** The API's own refusal message in one red callout. */
export function Refusal({ error, title = 'The order cannot go ahead' }: { error: unknown; title?: string }) {
  if (!error) return null;
  return <Callout tone="danger" title={title}>{errorMessage(error)}</Callout>;
}

interface PricedLine { id: string; description: string; hsn?: string | null; gst_rate: number | null; qty: number; unit_price: number; line_total: number }

/** The lines of a proforma invoice or sales order with the final figures: amount before tax, GST per line, freight and the total payable. */
export function PricedLines({ lines, freight = 0, total }: { lines: PricedLine[]; freight?: number; total?: number }) {
  const taxable = lines.reduce((a, l) => a + l.line_total, 0);
  const gst = lines.reduce((a, l) => a + (l.gst_rate != null ? l.line_total * (l.gst_rate / 100) : 0), 0);
  const noRate = lines.some((l) => l.gst_rate == null);
  const grand = total ?? taxable + gst + freight;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border text-[11px] uppercase tracking-[0.08em] text-muted">
              <th className="py-2">Item</th><th className="py-2 text-right">Qty</th><th className="py-2 text-right">Rate</th><th className="py-2 text-right">GST</th><th className="py-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-b border-border last:border-0">
                <td className="py-3">{l.description}{l.hsn ? <span className="ml-2 text-xs text-muted">HSN {l.hsn}</span> : null}</td>
                <td className="tabular py-3 text-right">{l.qty}</td>
                <td className="py-3 text-right"><Money value={l.unit_price} /></td>
                <td className="tabular py-3 text-right">{l.gst_rate != null ? `${l.gst_rate}%` : '—'}</td>
                <td className="py-3 text-right"><Money value={l.line_total} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="ml-auto max-w-sm space-y-1.5 text-sm">
        <div className="flex justify-between"><dt className="text-muted">Amount before GST</dt><dd><Money value={r2(taxable)} /></dd></div>
        <div className="flex justify-between"><dt className="text-muted">GST</dt><dd><Money value={r2(gst)} /></dd></div>
        {freight > 0 && <div className="flex justify-between"><dt className="text-muted">Freight</dt><dd><Money value={freight} /></dd></div>}
        <div className="flex justify-between border-t border-border pt-2 text-base font-bold"><dt>Total</dt><dd><Money value={r2(grand)} /></dd></div>
      </dl>
      {noRate && <p className="text-sm text-muted">Some items have no GST rate recorded, so no GST is added for them.</p>}
    </div>
  );
}
