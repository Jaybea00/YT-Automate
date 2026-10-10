import { createClient, SupabaseClient } from '@supabase/supabase-js';

let cachedClient: SupabaseClient | null = null;

/**
 * Returns a server-side Supabase client using the service role key.
 * Strictly requires SUPABASE_SERVICE_ROLE_KEY to avoid running under incorrect permissions.
 */
export function getSupabaseServerClient(): SupabaseClient {
  if (!cachedClient) {
    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL ||
      process.env.SUPABASE_URL;

    if (!supabaseUrl) {
      throw new Error('SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) is not set');
    }

    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
    }

    cachedClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return cachedClient;
}

export const createServerSupabaseClient = getSupabaseServerClient;
export const getSupabaseClient = getSupabaseServerClient;
