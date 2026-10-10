import type { SupabaseClient } from '@supabase/supabase-js';
import type { FinalVisualType } from './types';
import { normalizeLicenseType } from '../utils/media-upload';

export interface VideoAssetRecord {
  video_id: string;
  beat_index: number;
  visual_type: FinalVisualType;
  source_url?: string | null;
  license_type?: string | null;
  license_source?: string | null;
  attribution_text?: string | null;
  license_proof_url?: string | null;
  start_offset_seconds?: number | null;
  end_offset_seconds?: number | null;
  candidates_json?: any[] | null;
}

/**
 * Upserts provenance metadata into the video_assets table.
 * If a fallback occurred, visual_type must reflect the FINAL asset type actually used.
 */
export async function upsertVideoAssetProvenance(
  supabase: SupabaseClient,
  record: VideoAssetRecord,
): Promise<void> {
  const { data: existing } = await supabase
    .from('video_assets')
    .select('id')
    .eq('video_id', record.video_id)
    .eq('beat_index', record.beat_index)
    .maybeSingle();

  const normLicense = normalizeLicenseType(record.license_type);
  const attribution = record.attribution_text ?? (normLicense === 'cc_by' ? `Asset beat ${record.beat_index}` : null);

  const payload: Record<string, any> = {
    video_id: record.video_id,
    beat_index: record.beat_index,
    visual_type: record.visual_type,
    source_url: record.source_url ?? null,
    license_type: normLicense,
    license_source: record.license_source ?? null,
    attribution_text: attribution,
    license_proof_url: record.license_proof_url ?? null,
  };

  if (record.candidates_json !== undefined) {
    payload.candidates_json = record.candidates_json;
  }
  if (record.start_offset_seconds !== undefined) {
    payload.start_offset_seconds = record.start_offset_seconds;
  }
  if (record.end_offset_seconds !== undefined) {
    payload.end_offset_seconds = record.end_offset_seconds;
  }

  if (existing?.id) {
    const { error } = await supabase
      .from('video_assets')
      .update(payload)
      .eq('id', existing.id);

    if (error) {
      throw new Error(`Failed to update video_assets row: ${error.message}`);
    }
  } else {
    const { error } = await supabase
      .from('video_assets')
      .insert(payload);

    if (error) {
      throw new Error(`Failed to insert video_assets row: ${error.message}`);
    }
  }
}
