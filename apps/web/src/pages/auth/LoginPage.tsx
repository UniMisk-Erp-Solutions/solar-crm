import { useQuery } from '@tanstack/react-query';
import { ArrowRight, KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Logo } from '@/components/layout/Logo';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Callout } from '@/components/ui/surface';
import { api, errorMessage, type One } from '@/lib/api';
import { useAuth } from '@/lib/auth';

interface DemoUser { id: string; role: string; full_name: string }

export default function LoginPage() {
  const { status, demo, signIn, signUp, signInDemo, resetPassword } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const from = (loc.state as { from?: string } | null)?.from ?? '/';
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<'login' | 'reset' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  const [name, setName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const admins = useQuery({
    queryKey: ['demo-admin'], enabled: demo, retry: 1,
    queryFn: async () => (await api.anon<One<DemoUser[]>>('GET', '/auth/demo-users')).data.filter((u) => u.role === 'admin'),
  });

  useEffect(() => { document.title = 'Sign in · Future Solar'; }, []);
  if (status === 'signedIn') return <Navigate to={from} replace />;

  const enterDemo = async () => {
    const admin = admins.data?.[0];
    if (!admin) return;
    setBusy(true); setErr(null);
    try { await signInDemo(admin.id); nav(from, { replace: true }); } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      if (mode === 'login') { await signIn(email.trim(), password); nav(from, { replace: true }); }
      else if (mode === 'signup') {
        if (password.length < 8) throw new Error('Use a password of at least 8 characters.');
        const r = await signUp(name.trim(), email.trim(), password);
        setNotice(r.needsConfirmation ? 'Account created. Confirm your e-mail using the link we sent, then ask an administrator to activate your CRM access.' : 'Account created. Ask an administrator to activate your CRM access, then sign in.');
        setMode('login'); setPassword('');
      } else { await resetPassword(email.trim()); setSent(true); }
    } catch (x) { setErr(errorMessage(x)); } finally { setBusy(false); }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-5 py-12">
      <div className="w-full max-w-[420px]">
        <div className="mb-10 flex justify-center"><Logo /></div>
        <div className="card p-8 sm:p-10">
          {demo ? (
            <>
              <h1 className="text-[30px] leading-tight">Welcome back</h1>
              <p className="mt-2 text-[15px] text-muted">Sign in to manage leads, quotations and orders.</p>
              {err && <Callout tone="danger" className="mt-5">{err}</Callout>}
              {admins.isError && <Callout tone="danger" className="mt-5" title="Cannot reach the server">Start it with <span className="code">npm run dev</span> and refresh this page.</Callout>}
              <Button className="mt-8 w-full" size="lg" onClick={() => void enterDemo()} loading={busy} disabled={!admins.data?.length} rightIcon={<ArrowRight className="h-4 w-4" />}>Enter as Admin</Button>
              <p className="mt-6 text-center text-xs text-subtle">Demo mode — sample data, nothing is saved when the server restarts.</p>
            </>
          ) : (
            <>
              <h1 className="text-[30px] leading-tight">{mode === 'login' ? 'Welcome back' : mode === 'signup' ? 'Create account' : 'Reset password'}</h1>
              <p className="mt-2 text-[15px] text-muted">{mode === 'login' ? 'Use the e-mail address your administrator registered.' : mode === 'signup' ? 'Create your sign-in. An administrator then activates your access.' : 'We will e-mail you a secure link.'}</p>
              <form onSubmit={submit} className="mt-8 space-y-5" noValidate>
                {err && <Callout tone="danger">{err}</Callout>}
                {notice && mode === 'login' && <Callout tone="success">{notice}</Callout>}
                {sent && <Callout tone="success">If that address is registered, a reset link is on its way.</Callout>}
                {mode === 'signup' && <Field label="Full name" required><Input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required /></Field>}
                <Field label="E-mail" required><Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
                {mode !== 'reset' && <Field label="Password" required><Input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>}
                <Button type="submit" className="w-full" size="lg" loading={busy} leftIcon={mode === 'login' ? <KeyRound className="h-4 w-4" /> : undefined}>{mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}</Button>
                <div className="flex justify-between text-sm font-semibold text-primary-text">
                  <button type="button" onClick={() => { setMode(mode === 'login' ? 'reset' : 'login'); setErr(null); setSent(false); setNotice(null); }} className="hover:underline">{mode === 'login' ? 'Forgot password?' : 'Back to sign in'}</button>
                  {mode !== 'reset' && <button type="button" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setErr(null); setNotice(null); }} className="hover:underline">{mode === 'login' ? 'Create account' : 'I have an account'}</button>}
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
