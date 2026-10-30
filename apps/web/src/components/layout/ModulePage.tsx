import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Tabs } from '@/components/ui/tabs';
import { moduleByKey, type ModuleDef } from '@/lib/modules';

/** Which section of a module is open — kept in the address bar (?tab=) so refresh and back work. */
export function useSection(module: ModuleDef['key']): [string, (key: string) => void] {
  const def = moduleByKey(module);
  const [params, setParams] = useSearchParams();
  const wanted = params.get('tab');
  const value = def.sections.some((s) => s.key === wanted) ? wanted! : def.sections[0]!.key;
  return [value, (key) => setParams((p) => { const n = new URLSearchParams(p); n.set('tab', key); return n; }, { replace: true })];
}

/**
 * The frame every module page sits in: a small trail back to the dashboard, the module name, which flow steps it covers,
 * and its two or three sections as tabs. Pages put their content in `children` and nothing else around it.
 */
export function ModulePage({ module, children, actions }: { module: ModuleDef['key']; children: (section: string) => ReactNode; actions?: (section: string) => ReactNode }) {
  const def = moduleByKey(module);
  const [section, setSection] = useSection(module);
  const current = def.sections.find((s) => s.key === section)!;
  return (
    <main className="page">
      <nav aria-label="Breadcrumb" className="mb-4 flex items-center gap-1.5 text-sm text-muted">
        <Link to="/" className="hover:text-fg hover:underline">Dashboard</Link>
        <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        <span aria-current="page" className="font-semibold text-fg">{def.label}</span>
      </nav>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[36px] leading-[1.1]">{def.label}</h1>
          <p className="mt-2 max-w-2xl text-[15px] text-muted">{def.blurb}</p>
        </div>
        {actions?.(section) && <div className="flex flex-wrap items-center gap-3">{actions(section)}</div>}
      </header>
      <Tabs tabs={def.sections.map((s) => ({ key: s.key, label: s.label }))} value={section} onChange={setSection} className="mb-8" />
      <p className="-mt-5 mb-8 text-sm text-subtle">{current.steps} of the flow</p>
      {children(section)}
    </main>
  );
}
