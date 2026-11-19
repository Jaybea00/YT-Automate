import type { BadgeTone } from '@/components/ui/badge';

/** How each video status reads in the app: a short label and a badge colour. */
export const VIDEO_STATUS: Record<string, { label: string; tone: BadgeTone; busy?: boolean }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  scripting: { label: 'Writing script', tone: 'info', busy: true },
  script_review: { label: 'Script to review', tone: 'warning' },
  voicing: { label: 'Voicing', tone: 'info', busy: true },
  sourcing: { label: 'Visuals', tone: 'info' },
  assembling: { label: 'Assembling', tone: 'info', busy: true },
  rendered: { label: 'Rendered', tone: 'success' },
  published: { label: 'Published', tone: 'accent' },
  failed: { label: 'Failed', tone: 'danger' },
};

export const statusOf = (status: string | null | undefined) => VIDEO_STATUS[status ?? ''] ?? { label: status || 'Unknown', tone: 'neutral' as BadgeTone };

/** The steps of a video, in order, with the page each opens and the statuses that mean it is the current one. */
export const VIDEO_STEPS = [
  { key: 'review', label: 'Script', icon: 'script', statuses: ['queued', 'scripting', 'script_review'] },
  { key: 'visuals', label: 'Visuals', icon: 'image', statuses: ['voicing', 'sourcing'] },
  { key: 'storyboard', label: 'Storyboard', icon: 'grid', statuses: [] },
  { key: 'vibedit', label: 'Vibedit', icon: 'wand', statuses: [] },
  { key: 'progress', label: 'Render', icon: 'activity', statuses: ['assembling'] },
  { key: 'publish', label: 'Publish', icon: 'send', statuses: ['rendered', 'published'] },
] as const;

/** The step a video is at, from its status. */
export function currentStep(status: string | null | undefined): (typeof VIDEO_STEPS)[number]['key'] {
  return VIDEO_STEPS.find((s) => (s.statuses as readonly string[]).includes(status ?? ''))?.key ?? 'review';
}
