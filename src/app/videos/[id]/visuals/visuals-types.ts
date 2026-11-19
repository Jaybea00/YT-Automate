import type { MediaCandidate } from '@/pipeline/visuals/types';

/** Shapes the visuals page and its beat cards share (what /api/videos/[id]/progress returns). */

export interface ScriptBeat {
  text: string;
  visual_query?: string;
  visual_type?: string;
  duration_estimate_seconds?: number;
}

export interface VideoAsset {
  id: string;
  video_id: string;
  beat_index: number;
  visual_type: string;
  source_url: string | null;
  license_type: string | null;
  license_source: string | null;
  attribution_text: string | null;
  start_offset_seconds?: number | null;
  end_offset_seconds?: number | null;
  candidates_json?: MediaCandidate[] | null;
  created_at?: string;
}

export interface JobUnit {
  stage: string;
  unit_index: number;
  status: string;
  duration_ms: number | null;
}

export interface ProgressData {
  video: {
    id: string;
    title: string | null;
    status: string;
    style?: string | null;
    script_json?: {
      beats?: ScriptBeat[];
      drawing_budget?: number | null;
      bible_translation?: 'webbe' | 'web';
    } | null;
  };
  job: {
    id: string;
  } | null;
  units: JobUnit[];
  assets: VideoAsset[];
}

export const LICENSE_OPTIONS = [
  { value: 'own_work', label: 'Own Work / Original Footage' },
  { value: 'purchased', label: 'Purchased / Commercial License' },
  { value: 'royalty_free', label: 'Royalty-Free' },
  { value: 'public_domain', label: 'Public Domain' },
  { value: 'cc0', label: 'Creative Commons Zero (CC0)' },
  { value: 'cc_by', label: 'Creative Commons Attribution (CC-BY)' },
  { value: 'cc_by_sa', label: 'Creative Commons Attribution-ShareAlike (CC BY-SA)' },
];
