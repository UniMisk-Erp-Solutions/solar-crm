import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AppRole, Profile } from '@solar/shared';
import { ApiError, api, setTokenProvider, setUnauthorizedHandler, type One } from './api';
import { supabase } from './supabase';

export interface Me {
  profile: Profile;
  role_label: string;
  org: { id: string; name: string } | null;
  permissions: { can_see_mobile: boolean };
  session: { demo: boolean; timeout_minutes: number };
}

type Status = 'loading' | 'signedOut' | 'signedIn';
interface AuthCtx {
  status: Status;
  me: Me | null;
  role: AppRole | null;
  demo: boolean;
  signIn(email: string, password: string): Promise<void>;
  signUp(name: string, email: string, password: string): Promise<{ needsConfirmation: boolean }>;
  signInDemo(profileId: string): Promise<void>;
  signOut(): Promise<void>;
  resetPassword(email: string): Promise<void>;
  refresh(): Promise<void>;
  hasRole(...roles: AppRole[]): boolean;
}

const Ctx = createContext<AuthCtx | null>(null);
const DEMO_KEY = 'fs-demo-token';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [demo, setDemo] = useState<boolean>(!supabase);

  const loadMe = useCallback(async (strict = false) => {
    try {
      const res = await api.get<One<Me>>('/auth/me');
      setMe(res.data);
      setStatus('signedIn');
    } catch (e) {
      setMe(null);
      setStatus('signedOut');
      if (strict) {
        // only a real refusal means the account has no CRM access; a busy or unreachable server is a different problem and the session stays
        if (!(e instanceof ApiError) || ![401, 403].includes(e.status)) throw new Error(e instanceof ApiError && e.status === 429 ? 'Too many sign-in attempts. Please wait a minute and try again.' : 'Could not reach the server. Please try again in a moment.');
        if (supabase) await supabase.auth.signOut();
        throw new Error("You are signed in, but this account has no CRM access yet. Ask an administrator to activate it, then sign in again." + (e instanceof Error && e.message ? ' (' + e.message + ')' : ''));
      }
    }
  }, []);

  useEffect(() => {
    // token source: Supabase session in live mode, sessionStorage in demo mode
    setTokenProvider(async () => {
      if (supabase) { const { data } = await supabase.auth.getSession(); return data.session?.access_token ?? null; }
      try { return sessionStorage.getItem(DEMO_KEY); } catch { return null; }
    });
    setUnauthorizedHandler(() => { setMe(null); setStatus('signedOut'); });
    let cancelled = false;
    (async () => {
      try {
        const mode = await api.anon<One<{ demo: boolean }>>('GET', '/auth/mode');
        if (!cancelled) setDemo(mode.data.demo || !supabase);
      } catch { /* API offline — the login screen explains */ }
      if (cancelled) return;
      const hasToken = supabase ? !!(await supabase.auth.getSession()).data.session : !!sessionStorage.getItem(DEMO_KEY);
      if (hasToken) await loadMe(); else setStatus('signedOut');
    })();
    const sub = supabase?.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') { setMe(null); setStatus('signedOut'); } });
    return () => { cancelled = true; sub?.data.subscription.unsubscribe(); };
  }, [loadMe]);

  const value = useMemo<AuthCtx>(() => ({
    status, me, role: me?.profile.role ?? null, demo,
    async signIn(email, password) {
      if (!supabase) throw new Error('Sign-in is not configured. Use the demo role picker.');
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
      await loadMe(true);
    },
    async signUp(name, email, password) {
      if (!supabase) throw new Error('Sign-up is available once Supabase is configured.');
      const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { full_name: name }, emailRedirectTo: window.location.origin + '/login' } });
      if (error) throw new Error(error.message);
      return { needsConfirmation: !data.session };
    },
    async signInDemo(profileId) {
      const res = await api.anon<One<{ token: string }>>('POST', '/auth/demo-login', { profile_id: profileId });
      sessionStorage.setItem(DEMO_KEY, res.data.token);
      await loadMe();
    },
    async signOut() {
      try { sessionStorage.removeItem(DEMO_KEY); } catch { /* ignore */ }
      if (supabase) await supabase.auth.signOut();
      setMe(null); setStatus('signedOut');
    },
    async resetPassword(email) {
      if (!supabase) throw new Error('Password reset is available once Supabase is configured.');
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/login` });
      if (error) throw new Error(error.message);
    },
    refresh: () => loadMe(),
    hasRole: (...roles) => !!me && (me.profile.role === 'admin' || roles.includes(me.profile.role)),
  }), [status, me, demo, loadMe]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}
