/** The steps of a new video's background writing, as the review page shows them (client-safe). */

export type CreationStep = 'waiting' | 'research' | 'packaging' | 'outline' | 'writing' | 'segmenting' | 'shots' | 'checks';

export const CREATION_STEP_LABELS: Record<CreationStep, string> = {
  waiting: 'Waiting its turn',
  research: 'Researching the topic',
  packaging: 'Drafting titles and thumbnails',
  outline: 'Outlining from your brief',
  writing: 'Writing the script',
  segmenting: 'Splitting your text into beats',
  shots: 'Planning the shots',
  checks: 'Fact-checking and checking ad-friendliness',
};

