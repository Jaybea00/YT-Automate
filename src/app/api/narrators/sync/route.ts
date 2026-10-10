import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { getProvider, resolveVaultSecret } from '@/pipeline/providers/registry';
import '@/pipeline/providers'; // Ensure providers are registered
import type { TTSProvider } from '@/pipeline/providers/types';
import type { SupabaseClient } from '@supabase/supabase-js';

export async function handleNarratorSync(
  req: Request,
  supabaseClient?: SupabaseClient,
) {
  try {
    let body: { providerConfigId?: string } = {};
    try {
      body = await req.json();
    } catch {
      // Empty or non-JSON body is acceptable (syncs all active TTS providers)
    }

    const supabase = supabaseClient ?? getSupabaseServerClient();

    // 1. Fetch active TTS provider configs
    let query = supabase
      .from('yt_provider_configs')
      .select('id, kind, provider, label, base_url, default_model, secret_id, options, is_active')
      .eq('kind', 'tts')
      .eq('is_active', true);

    if (body.providerConfigId) {
      query = query.eq('id', body.providerConfigId.trim());
    }

    const { data: configs, error: configError } = await query;

    if (configError) {
      return NextResponse.json(
        { error: `Database error querying provider configs: ${configError.message}` },
        { status: 500 },
      );
    }

    if (!configs || configs.length === 0) {
      return NextResponse.json(
        { error: 'No active TTS provider configurations found to sync.' },
        { status: 404 },
      );
    }

    let totalSynced = 0;
    const providerResults: Array<{
      providerConfigId: string;
      label: string;
      provider: string;
      syncedCount: number;
      error?: string;
    }> = [];

    // 2. Process each active TTS provider
    for (const config of configs) {
      try {
        const provider = getProvider<TTSProvider>('tts', config.provider);
        if (!provider || typeof provider.listVoices !== 'function') {
          providerResults.push({
            providerConfigId: config.id,
            label: config.label,
            provider: config.provider,
            syncedCount: 0,
            error: `Provider "${config.provider}" does not support voice listing.`,
          });
          continue;
        }

        let apiKey = '';
        if (config.secret_id) {
          apiKey = await resolveVaultSecret(supabase, config.secret_id);
        }

        const voices = await provider.listVoices({
          apiKey,
          baseUrl: config.base_url || undefined,
          model: config.default_model || undefined,
          options: config.options || {},
        });

        // 3. Upsert voices matching on (provider_config_id, voice_id)
        // Fetch existing narrators for this provider to guarantee zero duplicates even before index migration
        const { data: existingRows } = await supabase
          .from('narrators')
          .select('id, voice_id')
          .eq('provider_config_id', config.id);

        const existingMap = new Map<string, string>();
        if (Array.isArray(existingRows)) {
          for (const row of existingRows) {
            existingMap.set(row.voice_id, row.id);
          }
        }

        let configSynced = 0;
        for (const voice of voices) {
          const payload = {
            provider_config_id: config.id,
            voice_id: voice.id,
            name: voice.name,
            sample_url: voice.sampleUrl || null,
            tier: voice.tier || null,
            provider_slug: config.provider,
          };

          const existingId = existingMap.get(voice.id);
          if (existingId) {
            // Update existing narrator
            const { error: updateErr } = await supabase
              .from('narrators')
              .update(payload)
              .eq('id', existingId);

            if (!updateErr) configSynced++;
          } else {
            // Insert new narrator (or upsert if onConflict constraint exists)
            const { error: insertErr } = await supabase
              .from('narrators')
              .insert(payload);

            if (!insertErr) {
              configSynced++;
            }
          }
        }

        totalSynced += configSynced;
        providerResults.push({
          providerConfigId: config.id,
          label: config.label,
          provider: config.provider,
          syncedCount: configSynced,
        });
      } catch (providerErr) {
        const msg = providerErr instanceof Error ? providerErr.message : String(providerErr);
        providerResults.push({
          providerConfigId: config.id,
          label: config.label,
          provider: config.provider,
          syncedCount: 0,
          error: msg,
        });
      }
    }

    return NextResponse.json({
      success: true,
      totalSynced,
      providers: providerResults,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return handleNarratorSync(req);
}
