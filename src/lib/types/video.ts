import { GeneratedScript } from '../script/generate-script';
import { VideoStyle } from '../script/style-templates';

export type VideoStatus =
  | 'queued'
  | 'scripting'
  | 'script_review'
  | 'voicing'
  | 'sourcing'
  | 'assembling'
  | 'rendered'
  | 'published'
  | 'failed';

export interface VideoRecord {
  id: string;
  created_at?: string;
  updated_at?: string;
  topic: string;
  style: VideoStyle;
  target_minutes: number;
  status: VideoStatus;
  script_json: GeneratedScript | null;
  title?: string | null;
  script_approved_at?: string | null;
  error_message?: string | null;
}
