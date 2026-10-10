import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let adminClient: SupabaseClient | null = null;

/**
 * Returns a dedicated Supabase client initialized with the service-role key.
 * This client bypasses RLS and is strictly for server-side / worker pipeline operations.
 * Fails fast with a clear error if SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.
 */
export function getSupabaseAdminClient(): SupabaseClient {
  if (adminClient) {
    return adminClient;
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl) {
    throw new Error(
      '[Supabase Admin] Fatal: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) environment variable is missing.',
    );
  }

  if (!serviceRoleKey) {
    throw new Error(
      '[Supabase Admin] Fatal: SUPABASE_SERVICE_ROLE_KEY environment variable is missing. The worker requires the service-role key to operate.',
    );
  }

  adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return adminClient;
}

export function resetAdminClient(): void {
  adminClient = null;
}
