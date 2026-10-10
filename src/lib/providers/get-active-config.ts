import { SupabaseClient } from '@supabase/supabase-js';

export type ProviderCapability =
  | 'research'
  | 'script'
  | 'tts'
  | 'stock_footage'
  | 'ai_visual'
  | 'render'
  | 'metadata'
  | 'analytics';

export interface ResolvedProviderConfig {
  configId: string;
  providerSlug: string;
  /** Decrypted secret value, or null if this provider needs no key. */
  credential: string | null;
  /** Provider-specific extras — e.g. { model: 'claude-sonnet-4-6' } for script. */
  config: Record<string, unknown>;
}

/**
 * Looks up the single active (non-fallback) provider_config row for a
 * capability, joins its provider slug, and decrypts the Vault credential
 * if one is attached. This is the one place every adapter factory should
 * call through — never read provider_configs directly elsewhere.
 *
 * Throws if no active config exists for the capability, since every
 * pipeline stage requires one — better to fail loudly at call time than
 * silently fall back to an undefined provider.
 */
export async function getActiveProviderConfig(
  supabase: SupabaseClient,
  capability: ProviderCapability,
): Promise<ResolvedProviderConfig> {
  const { data: configRow, error } = await supabase
    .from('provider_configs')
    .select('id, credential_ref, config, providers(slug)')
    .eq('capability', capability)
    .eq('is_active', true)
    .eq('is_fallback', false)
    .single();

  if (error || !configRow) {
    throw new Error(
      `No active provider configured for capability "${capability}". ` +
        `Set one in the provider settings before running this stage.`,
    );
  }

  let credential: string | null = null;
  if (configRow.credential_ref) {
    // Supabase Vault stores the decrypted value in vault.decrypted_secrets,
    // exposed here via an RPC so the raw key never touches a normal table.
    const { data: secret, error: secretError } = await supabase.rpc(
      'read_vault_secret',
      { secret_id: configRow.credential_ref },
    );
    if (secretError || !secret) {
      throw new Error(
        `Failed to decrypt credential for capability "${capability}": ${secretError?.message}`,
      );
    }
    credential = secret as string;
  }

  return {
    configId: configRow.id,
    // @ts-expect-error — Supabase's typed join returns an array or object
    // depending on relationship cardinality; providers is one-to-one here.
    providerSlug: configRow.providers.slug,
    credential,
    config: (configRow.config as Record<string, unknown>) ?? {},
  };
}
