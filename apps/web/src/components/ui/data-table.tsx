import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button } from './button';
import { EmptyState, ErrorState, SkeletonRows } from './surface';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** server-side sort field; enables the sort toggle */
  sortKey?: string;
  align?: 'left' | 'right' | 'center';
  className?: string;
  /** hide this column below a breakpoint to keep tables readable on phones */
  hideBelow?: 'sm' | 'md' | 'lg';
  width?: string;
}

const HIDE = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell' } as const;

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  empty?: { title: string; description?: ReactNode; action?: ReactNode };
  /** server-side pagination */
  page?: { total: number; limit: number; offset: number; onChange: (offset: number) => void; onLimit?: (limit: number) => void };
  sort?: { key: string | undefined; dir: 'asc' | 'desc'; onChange: (key: string, dir: 'asc' | 'desc') => void };
  caption?: string;
  dense?: boolean;
}

export function DataTable<T>({ columns, rows, rowKey, loading, error, onRetry, onRowClick, rowClassName, empty, page, sort, caption, dense }: DataTableProps<T>) {
  const defs = useMemo<ColumnDef<T>[]>(() => columns.map((c) => ({ id: c.key, header: () => c.header, cell: (ctx) => c.cell(ctx.row.original) })), [columns]);
  const table = useReactTable({ data: rows ?? [], columns: defs, getCoreRowModel: getCoreRowModel(), manualPagination: true, manualSorting: true, getRowId: (r) => rowKey(r) });
  const colOf = (id: string) => columns.find((c) => c.key === id)!;

  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (loading && !rows) return <SkeletonRows />;
  if (rows && rows.length === 0) return <EmptyState title={empty?.title ?? 'Nothing here yet'} description={empty?.description} action={empty?.action} />;

  return (
    <div className={cn('transition-opacity', loading && 'opacity-60')}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-border">
                {hg.headers.map((h) => {
                  const c = colOf(h.id);
                  const sorted = sort && c.sortKey && sort.key === c.sortKey ? sort.dir : null;
                  return (
                    <th
                      key={h.id} scope="col" style={c.width ? { width: c.width } : undefined}
                      aria-sort={sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : undefined}
                      className={cn('whitespace-nowrap px-4 py-3 text-[11px] font-bold uppercase tracking-[0.08em] text-muted', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center', c.hideBelow && HIDE[c.hideBelow], c.className)}
                    >
                      {c.sortKey && sort ? (
                        <button type="button" className="inline-flex items-center gap-1 uppercase hover:text-fg" onClick={() => sort.onChange(c.sortKey!, sorted === 'desc' ? 'asc' : 'desc')}>
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {sorted === 'asc' ? <ArrowUp className="h-3 w-3" /> : sorted === 'desc' ? <ArrowDown className="h-3 w-3" /> : <ChevronsUpDown className="h-3 w-3 opacity-50" />}
                        </button>
                      ) : flexRender(h.column.columnDef.header, h.getContext())}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((r) => (
              <tr
                key={r.id}
                onClick={onRowClick ? () => onRowClick(r.original) : undefined}
                onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(r.original); } : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                className={cn('border-b border-border last:border-0', onRowClick && 'cursor-pointer hover:bg-primary-soft/50 focus-visible:bg-primary-soft/60', rowClassName?.(r.original))}
              >
                {r.getVisibleCells().map((cell) => {
                  const c = colOf(cell.column.id);
                  return (
                    <td key={cell.id} className={cn('px-4 align-middle', dense ? 'py-2.5' : 'py-4', c.align === 'right' && 'text-right tabular', c.align === 'center' && 'text-center', c.hideBelow && HIDE[c.hideBelow], c.className)}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {page && <Pagination {...page} />}
    </div>
  );
}

export function Pagination({ total, limit, offset, onChange, onLimit }: { total: number; limit: number; offset: number; onChange: (offset: number) => void; onLimit?: (n: number) => void }) {
  if (total <= 0) return null;
  const from = offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-3 py-2.5 text-sm text-muted">
      <span className="tabular">Showing {from}–{to} of {total}</span>
      <div className="flex items-center gap-2">
        {onLimit && (
          <label className="flex items-center gap-1.5 text-xs">
            Rows
            <select value={limit} onChange={(e) => onLimit(Number(e.target.value))} className="h-8 rounded-md border border-border-strong bg-surface px-1.5 text-sm text-fg">
              {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        )}
        <Button variant="secondary" size="sm" disabled={offset <= 0} onClick={() => onChange(Math.max(0, offset - limit))} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></Button>
        <Button variant="secondary" size="sm" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></Button>
      </div>
    </nav>
  );
}
