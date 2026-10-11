import type { SupabaseClient } from '@supabase/supabase-js';
import { ConfigurationError } from './errors';
import type {
  AnyProvider,
  PipelineStage,
  ProviderCallContext,
  ProviderKind,
} from './types';

// Map of `${kind}:${id}` -> provider instance
const registry = new Map<string, AnyProvider>();

export function getRegistryKey(kind: ProviderKind, id: string): string {
  return `${kind}:${id}`;
}

export function registerProvider<T extends AnyProvider>(
  kind: ProviderKind,
  id: string,
  provider: T,
): void {
  registry.set(getRegistryKey(kind, id), provider);
}

export function getProvider<T extends AnyProvider = AnyProvider>(
  kind: ProviderKind,
  id: string,
): T | undefined {
  return registry.get(getRegistryKey(kind, id)) as T | undefined;
}

export function clearRegistry(): void {
  registry.clear();
}

export function getRegisteredProviders(): string[] {
  return Array.from(registry.keys());
}

/**
 * Maps a pipeline stage to the required ProviderKind
 */
export function getStageKind(stage: PipelineStage): ProviderKind {
  switch (stage) {
    case 'research':
    case 'script':
    case 'metadata':
      return 'llm';
    case 'image':
    case 'thumbnail':
      return 'image';
    case 'tts':
      return 'tts';
    case 'visuals':
      return 'stock';
    case 'assembly':
      throw new ConfigurationError('Assembly stage is local FFmpeg and does not use a provider');
    default:
      throw new ConfigurationError(`Unknown stage: "${stage}"`);
  }
}

/**
 * Resolves a Vault secret by secret_id using the dedicated yt_read_vault_secret RPC
 */
export async function resolveVaultSecret(
  supabase: SupabaseClient,
  secretId: string,
): Promise<string> {
  const { data, error } = await supabase.rpc('yt_read_vault_secret', {
    secret_id: secretId,
  });

  if (error) {
    throw new ConfigurationError(
      `Failed to read Vault secret "${secretId}": ${error.message}`,
    );
  }

  if (typeof data !== 'string' || !data) {
    throw new ConfigurationError(
      `Vault secret "${secretId}" was not found or is empty.`,
    );
  }

  return data;
}

export interface ResolvedStageProvider<T extends AnyProvider = AnyProvider> {
  provider: T;
  ctx: ProviderCallContext;
  maxRetries: number;
  configId: string;
  providerId: string;
  model?: string;
  options: Record<string, unknown>;
}

export interface StageBindingRow {
  stage: string;
  provider_config_id: string;
  model: string | null;
  options: Record<string, unknown> | null;
  max_retries: number;
  yt_provider_configs: {
    id: string;
    kind: ProviderKind;
    provider: string;
    label: string;
    base_url: string | null;
    default_model: string | null;
    secret_id: string | null;
    options: Record<string, unknown> | null;
    is_active: boolean;
  } | null;
}

/**
 * Resolves the provider, context, and retry settings for a given pipeline stage.
 * Reads yt_stage_bindings joined to yt_provider_configs.
 */
export async function resolveForStage<T extends AnyProvider = AnyProvider>(
  stage: PipelineStage,
  clientOverride?: SupabaseClient,
  overrideConfigId?: string,
  voiceOverride?: string,
): Promise<ResolvedStageProvider<T>> {
  const kind = getStageKind(stage);
  let supabase = clientOverride;
  if (!supabase) {
    const { getSupabaseServerClient } = await import('@/lib/supabase/server');
    supabase = getSupabaseServerClient();
  }

  const { data, error } = await supabase
    .from('yt_stage_bindings')
    .select(`
      stage,
      provider_config_id,
      model,
      options,
      max_retries,
      yt_provider_configs (
        id,
        kind,
        provider,
        label,
        base_url,
        default_model,
        secret_id,
        options,
        is_active
      )
    `)
    .eq('stage', stage)
    .maybeSingle();

  if (error) {
    throw new ConfigurationError(
      `Database error querying stage binding for "${stage}": ${error.message}`,
    );
  }

  const binding = data as unknown as StageBindingRow | null;

  // If no binding exists and no explicit overrideConfigId is provided, we cannot proceed.
  // When an explicit override is supplied, it does NOT require a default binding to exist.
  if (!binding && !overrideConfigId) {
    throw new ConfigurationError(`No stage binding configured for stage "${stage}"`);
  }

  let config = binding?.yt_provider_configs ?? null;

  if (overrideConfigId) {
    if (!config || overrideConfigId !== config.id) {
      const { data: overrideData, error: overrideError } = await supabase
        .from('yt_provider_configs')
        .select(`
          id,
          kind,
          provider,
          label,
          base_url,
          default_model,
          secret_id,
          options,
          is_active
        `)
        .eq('id', overrideConfigId)
        .maybeSingle();

      if (overrideError) {
        throw new ConfigurationError(
          `Database error querying provider config override "${overrideConfigId}": ${overrideError.message}`,
        );
      }

      if (!overrideData) {
        throw new ConfigurationError(
          `Provider config override "${overrideConfigId}" for stage "${stage}" was not found`,
        );
      }

      config = overrideData as typeof config;
    }
  }

  if (!config) {
    throw new ConfigurationError(`No active provider config could be resolved for stage "${stage}"`);
  }

  if (!config.is_active) {
    throw new ConfigurationError(
      `Provider config "${config.label}" (${config.provider}) for stage "${stage}" is inactive`,
    );
  }

  if (config.kind !== kind) {
    throw new ConfigurationError(
      `Provider kind mismatch for stage "${stage}": expected "${kind}", found "${config.kind}"`,
    );
  }

  let provider = getProvider<T>(kind, config.provider);
  if (!provider) {
    const mod = await import('./index');
    mod.registerDefaultProviders();
    provider = getProvider<T>(kind, config.provider);
  }

  if (!provider) {
    throw new ConfigurationError(
      `No registered provider adapter for "${kind}:${config.provider}"`,
    );
  }

  // Resolve API key: first try Vault if secret_id is present, then fall back to environment variables
  let apiKey = '';
  if (config.secret_id) {
    try {
      apiKey = await resolveVaultSecret(supabase, config.secret_id);
    } catch {
      // If Vault resolution fails, attempt fallback to environment variables
    }
  }

  if (!apiKey) {
    const envKeyMap: Record<string, string[]> = {
      gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
      openai: ['OPENAI_API_KEY'],
      anthropic: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
      claude: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
      elevenlabs: ['ELEVENLABS_API_KEY', 'XI_API_KEY'],
      pexels: ['PEXELS_API_KEY'],
      nasa: ['NASA_API_KEY'],
      pixabay: ['PIXABAY_API_KEY'],
      fal: ['FAL_KEY'],
    };

    const candidateEnvVars = envKeyMap[provider.id] || [`${provider.id.toUpperCase().replace(/-/g, '_')}_API_KEY`];
    for (const envVar of candidateEnvVars) {
      if (process.env[envVar]) {
        apiKey = process.env[envVar]!;
        break;
      }
    }
  }

  if (provider.requiresApiKey && !apiKey) {
    throw new ConfigurationError(
      `Provider "${provider.id}" for stage "${stage}" requires an API key, but neither a valid Vault secret nor environment variable (${provider.id.toUpperCase()}_API_KEY) was found.`,
    );
  }

  // 3-way option merge: (binding -> provider config -> job override)
  // When overridden, provider config options form the base; otherwise binding options override config options.
  // Then job-level voiceOverride has highest precedence.
  const configOptions = config.options ?? {};
  const bindingOptions = binding?.options ?? {};
  const isOverridden = Boolean(overrideConfigId && (!binding || overrideConfigId !== binding.provider_config_id));
  const mergedOptions: Record<string, unknown> = isOverridden
    ? { ...(config.options ?? {}) }
    : { ...configOptions, ...bindingOptions };

  if (voiceOverride) {
    mergedOptions.voice = voiceOverride;
    mergedOptions.voiceId = voiceOverride;
  }

  const effectiveModel = isOverridden
    ? config.default_model || binding?.model || undefined
    : binding?.model || config.default_model || undefined;

  const ctx: ProviderCallContext = {
    apiKey,
    model: effectiveModel,
    baseUrl: config.base_url || undefined,
    options: mergedOptions,
  };

  return {
    provider,
    ctx,
    maxRetries: binding?.max_retries ?? 1,
    configId: config.id,
    providerId: config.provider,
    model: effectiveModel,
    options: mergedOptions,
  };
}
