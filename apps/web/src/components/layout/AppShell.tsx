import { Home, LogOut, Settings } from 'lucide-react';
import { Suspense } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { SkeletonRows } from '@/components/ui/surface';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { ErrorBoundary } from './ErrorBoundary';
import { Logo } from './Logo';

const pill = ({ isActive }: { isActive: boolean }) =>
  cn('inline-flex h-10 items-center gap-2 rounded-lg border px-4 text-sm font-semibold transition-colors', isActive ? 'border-fg bg-fg text-white' : 'border-border-strong bg-surface text-fg hover:bg-surface-2');

/** A deliberately small shell: logo on the left, Dashboard and Settings on the right. Everything else is reached from the flow on the dashboard. */
export function AppShell() {
  const { me, signOut } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-lg focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-fg">Skip to content</a>
      <header className="border-b border-border bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-[72px] w-full max-w-[1120px] items-center justify-between gap-3 px-5 sm:px-8">
          <NavLink to="/" aria-label="Future Solar — dashboard"><Logo /></NavLink>
          <nav aria-label="Main" className="flex items-center gap-2">
            <NavLink to="/" end className={pill}><Home className="h-4 w-4" aria-hidden />Dashboard</NavLink>
            <NavLink to="/settings" className={pill}><Settings className="h-4 w-4" aria-hidden />Settings</NavLink>
            <Button variant="ghost" size="icon" aria-label={`Sign out ${me?.profile.full_name ?? ''}`} title="Sign out" onClick={() => { void signOut().then(() => nav('/login')); }}><LogOut className="h-[18px] w-[18px]" /></Button>
          </nav>
        </div>
      </header>
      <div id="main" tabIndex={-1} className="outline-none">
        <ErrorBoundary key={loc.pathname}>
          <Suspense fallback={<div className="page"><SkeletonRows rows={6} /></div>}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </div>
    </div>
  );
}
