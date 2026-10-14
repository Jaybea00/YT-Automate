import { z } from 'zod';

export const ChartSpecSchema = z.object({
  chartable: z.boolean(),
  reason: z.string().optional(),
  chartType: z.enum(['bar', 'line', 'pie', 'doughnut']).optional(),
  title: z.string().optional(),
  labels: z.array(z.string()).optional(),
  series: z.array(
    z.object({
      name: z.string().optional(),
      values: z.array(z.number()),
    }),
  ).optional(),
});

export type ChartSpec = z.infer<typeof ChartSpecSchema>;

export const UrlResolutionSchema = z.object({
  resolved: z.boolean(),
  url: z.string().optional(),
  reason: z.string().optional(),
});

export type UrlResolution = z.infer<typeof UrlResolutionSchema>;

export const NewspaperSpecSchema = z.object({
  outlet: z.string().default('THE CHRONICLE'),
  date: z.string().optional(),
  edition: z.string().optional(),
  headline: z.string(),
  subheadline: z.string().optional(),
  snippet: z.string(),
  highlightText: z.string().optional(),
  highlightColor: z.enum(['yellow', 'cyan', 'green', 'rose']).default('yellow').optional(),
  style: z.enum(['vintage', 'modern', 'dark']).default('vintage').optional(),
});

export type NewspaperSpec = z.infer<typeof NewspaperSpecSchema>;

export type FinalVisualType =
  | 'stock'
  | 'chart'
  | 'screen_recording'
  | 'uploaded'
  | 'archive'
  | 'geo_map'
  | 'newspaper'
  /** A beat rendered from its planned shots */
  | 'composite';

export interface MediaCandidate {
  id: string | number;
  provider:
    | 'pixabay'
    | 'wikimedia'
    | 'archive_org'
    | 'nasa'
    | 'pexels'
    | 'uploaded'
    | 'pollinations'
    | 'openai'
    | 'fal'
    | 'google_veo'
    | 'veo';
  mediaType: 'video' | 'image';
  title?: string;
  thumbnailUrl: string;
  downloadUrl: string;
  pageUrl?: string;
  previewUrl?: string;
  duration?: number;
  width?: number;
  height?: number;
  attribution?: string;
  license?: string;
  licenseProofUrl?: string;
}

export interface VisualSourceResult {
  outputPath: string;
  finalVisualType: FinalVisualType;
  durationMs: number;
  sourceUrl?: string | null;
  licenseType?: string | null;
  licenseSource?: string | null;
  licenseProofUrl?: string | null;
  attributionText?: string | null;
  fallbackOccurred: boolean;
  fallbackReason?: string;
  candidates?: MediaCandidate[];
}

