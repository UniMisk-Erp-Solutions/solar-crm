import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase JS is used ONLY for authentication (sign-in, session, password reset). All data goes through the Node API
 * with the user's JWT; the service-role key never reaches the browser. Returns null in demo mode (no Supabase vars).
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabase: SupabaseClient | null = url && anon ? createClient(url, anon, { auth: { persistSession: true, autoRefreshToken: true } }) : null;
