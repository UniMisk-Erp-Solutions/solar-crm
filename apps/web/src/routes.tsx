import { lazy, type ComponentType } from 'react';
import { Navigate, createBrowserRouter, useLocation } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { EmptyState, Page, SkeletonRows } from '@/components/ui/surface';
import { useAuth } from '@/lib/auth';

const L = <T extends ComponentType>(f: () => Promise<{ default: T }>) => lazy(f);

const LoginPage = L(() => import('@/pages/auth/LoginPage'));
const NotFoundPage = L(() => import('@/pages/auth/NotFoundPage'));
const PublicLeadFormPage = L(() => import('@/pages/public/PublicLeadFormPage'));
const HomePage = L(() => import('@/pages/home/HomePage'));
const LeadsModule = L(() => import('@/pages/leads/LeadsModule'));
const LeadDetailPage = L(() => import('@/pages/leads/LeadDetailPage'));
const SiteModule = L(() => import('@/pages/site/SiteModule'));
const QuotesModule = L(() => import('@/pages/quotes/QuotesModule'));
const QuoteDetailPage = L(() => import('@/pages/quotes/QuoteDetailPage'));
const OrdersModule = L(() => import('@/pages/orders/OrdersModule'));
const PiDetailPage = L(() => import('@/pages/orders/PiDetailPage'));
const SoDetailPage = L(() => import('@/pages/orders/SoDetailPage'));
const ControlModule = L(() => import('@/pages/control/ControlModule'));
const SettingsPage = L(() => import('@/pages/settings/SettingsPage'));

/** For now the product is admin-only: anyone else who signs in is told so, instead of seeing a half-working screen. */
function RequireAdmin() {
  const { status, role, signOut } = useAuth();
  const loc = useLocation();
  if (status === 'loading') return <div className="page"><SkeletonRows rows={5} /></div>;
  if (status === 'signedOut') return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  if (role !== 'admin') {
    return (
      <Page>
        <EmptyState title="This workspace is admin-only for now" description="Please sign in with an administrator account." action={<Button onClick={() => void signOut()}>Sign out</Button>} />
      </Page>
    );
  }
  return <AppShell />;
}

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/apply', element: <PublicLeadFormPage /> },
  {
    element: <RequireAdmin />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'leads', element: <LeadsModule /> },
      { path: 'leads/:id', element: <LeadDetailPage /> },
      { path: 'site', element: <SiteModule /> },
      { path: 'quotes', element: <QuotesModule /> },
      { path: 'quotes/:id', element: <QuoteDetailPage /> },
      { path: 'orders', element: <OrdersModule /> },
      { path: 'orders/pi/:id', element: <PiDetailPage /> },
      { path: 'orders/so/:id', element: <SoDetailPage /> },
      { path: 'control', element: <ControlModule /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
