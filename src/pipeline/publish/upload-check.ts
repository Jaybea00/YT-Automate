import { TAGS_MAX_CHARS, TITLE_IDEAL_CHARS } from './metadata';

/**
 * The ready-to-upload check: everything that hurts a video once it's live, checked before you
 * upload it. A render that failed its quality check, review notes still open, credits missing
 * from the description, a title too long for search, tags over YouTube's limit, thumbnail words
 * too small to read on a phone, and what to answer for "AI use" (YouTube asks you to disclose
 * realistic AI pictures, footage or music, not animation or an AI-written script) and "Made for
 * kids". Each item says what to fix and where.
 */

export type UploadCheckStatus = 'pass' | 'warn' | 'fail' | 'info';

export interface UploadCheck {
  id: string;
  label: string;
  status: UploadCheckStatus;
  detail: string;
  /** Where to fix it: a page of the app, or a section of the Publish page (#anchor). */
  fix?: { label: string; href: string };
}

export interface UploadCheckInput {
  videoId: string;
  rendered: boolean;
  qualityReport: { passed: boolean; checks: Array<{ status: 'pass' | 'warn' | 'fail'; label: string }> } | null;
  /** Open (unticked) review notes; AI ones carry their severity. */
  openNotes: Array<{ source?: 'ai'; severity?: 'high' | 'medium' | 'low' }>;
  title: string;
  description: string;
  /** The credits the licences require, one per line (music, footage). */
  credits: string;
  /** The video's chapter list ("0:00 Intro" lines), when it has one. */
  chapters: string;
  tags: string[];
  thumbnailTexts: string[];
  hasTimeline: boolean;
  endScreenSec: number;
  /** Drawn (stickman) videos are animation: no realistic AI to disclose. */
  drawn: boolean;
  /** Credits of the shots that are AI pictures or AI footage. */
  aiVisuals: string[];
  /** Footage used with a creator's permission (streamers' clips). */
  permissionFootage: number;
}

const TITLE_MAX = 100;
const DESCRIPTION_MAX = 5000;
/** Thumbnail words are read at about 168 px wide on a phone: a few big words or nothing. */
export const THUMB_MAX_WORDS = 4;
export const THUMB_MAX_CHARS = 24;

/** Tags as YouTube counts them: commas between, quotes around tags with spaces. */
export const tagChars = (tags: string[]) => tags.reduce((n, t, i) => n + t.length + (t.includes(' ') ? 2 : 0) + (i ? 1 : 0), 0);

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Credit lines the description is missing (each must appear word for word). */
export function missingCredits(description: string, credits: string): string[] {
  const d = norm(description);
  return credits
    .split('\n')
    .map((l) => l.replace(/^[-•*]\s*/, '').trim())
    .filter((l) => l && !/^(credits|music|visuals|footage)\s*:?$/i.test(l))
    .filter((l) => !d.includes(norm(l)));
}

/** Thumbnail texts too long to read on a phone. */
export function hardToRead(texts: string[]): string[] {
  return texts.filter((t) => t.trim().split(/\s+/).filter(Boolean).length > THUMB_MAX_WORDS || t.trim().length > THUMB_MAX_CHARS);
}

export function buildUploadChecks(i: UploadCheckInput): UploadCheck[] {
  const checks: UploadCheck[] = [];
  const add = (c: UploadCheck) => checks.push(c);
  const render = { label: 'Open Render', href: `/videos/${i.videoId}/progress` };
  const vibedit = { label: 'Open Vibedit', href: `/videos/${i.videoId}/vibedit` };

  add(
    i.rendered
      ? { id: 'rendered', label: 'Video rendered', status: 'pass', detail: 'The finished video is ready.' }
      : { id: 'rendered', label: 'Video rendered', status: 'fail', detail: 'There is no finished video yet.', fix: render },
  );

  const q = i.qualityReport;
  if (!q) {
    add({ id: 'quality', label: 'Final quality check', status: i.rendered ? 'warn' : 'fail', detail: 'This render has no quality check. Render again to run it.', fix: render });
  } else {
    const failed = q.checks.filter((c) => c.status === 'fail').map((c) => c.label);
    const warned = q.checks.filter((c) => c.status === 'warn').map((c) => c.label);
    add(
      failed.length
        ? { id: 'quality', label: 'Final quality check', status: 'fail', detail: `Failed: ${failed.join(', ')}.`, fix: render }
        : warned.length
          ? { id: 'quality', label: 'Final quality check', status: 'warn', detail: `Passed, with warnings: ${warned.join(', ')}.`, fix: render }
          : { id: 'quality', label: 'Final quality check', status: 'pass', detail: 'Format, sound, loudness and picture all passed.' },
    );
  }

  const aiHigh = i.openNotes.filter((n) => n.source === 'ai' && n.severity === 'high').length;
  const open = i.openNotes.length;
  add(
    open === 0
      ? { id: 'notes', label: 'Review notes dealt with', status: 'pass', detail: 'No open review notes.' }
      : {
          id: 'notes',
          label: 'Review notes dealt with',
          status: aiHigh ? 'fail' : 'warn',
          detail: `${open} open note${open === 1 ? '' : 's'}${aiHigh ? `, ${aiHigh} marked high by the AI watch-through` : ''}. Fix them or tick them off.`,
          fix: vibedit,
        },
  );

  const t = i.title.trim();
  add(
    !t
      ? { id: 'title', label: 'Title', status: 'fail', detail: 'No title chosen.', fix: { label: 'Go to Title', href: '#publish-title' } }
      : t.length > TITLE_MAX
        ? { id: 'title', label: 'Title', status: 'fail', detail: `${t.length} characters: YouTube allows ${TITLE_MAX}.`, fix: { label: 'Go to Title', href: '#publish-title' } }
        : t.length > TITLE_IDEAL_CHARS
          ? { id: 'title', label: 'Title', status: 'warn', detail: `${t.length} characters: the end is cut off in search and on phones after about ${TITLE_IDEAL_CHARS}.`, fix: { label: 'Go to Title', href: '#publish-title' } }
          : { id: 'title', label: 'Title', status: 'pass', detail: `${t.length} characters, fits everywhere.` },
  );

  const missing = missingCredits(i.description, i.credits);
  const d = i.description.trim();
  add(
    !d
      ? { id: 'description', label: 'Description and credits', status: 'fail', detail: 'The description is empty.', fix: { label: 'Go to Description', href: '#publish-description' } }
      : missing.length
        ? {
            id: 'description',
            label: 'Description and credits',
            status: 'fail',
            detail: `${missing.length} required credit${missing.length === 1 ? ' is' : 's are'} missing: ${missing.slice(0, 2).join('; ')}${missing.length > 2 ? '…' : ''}. Licences need them.`,
            fix: { label: 'Go to Description', href: '#publish-description' },
          }
        : d.length > DESCRIPTION_MAX
          ? { id: 'description', label: 'Description and credits', status: 'fail', detail: `${d.length} characters: YouTube allows ${DESCRIPTION_MAX}.`, fix: { label: 'Go to Description', href: '#publish-description' } }
          : { id: 'description', label: 'Description and credits', status: 'pass', detail: i.credits.trim() ? 'Every required credit is in the description.' : 'Nothing in this video needs a credit.' },
  );

  if (i.chapters.trim()) {
    const has = norm(i.description).includes(norm(i.chapters.split('\n')[0] ?? ''));
    add(
      has
        ? { id: 'chapters', label: 'Chapters', status: 'pass', detail: 'The chapter list is in the description.' }
        : { id: 'chapters', label: 'Chapters', status: 'warn', detail: 'The chapter list is not in the description, so YouTube won’t show chapters.', fix: { label: 'Go to Description', href: '#publish-description' } },
    );
  }

  const tc = tagChars(i.tags);
  add(
    tc > TAGS_MAX_CHARS
      ? { id: 'tags', label: 'Tags', status: 'fail', detail: `${tc} characters: YouTube allows ${TAGS_MAX_CHARS}.`, fix: { label: 'Go to Tags', href: '#publish-tags' } }
      : { id: 'tags', label: 'Tags', status: i.tags.length ? 'pass' : 'warn', detail: i.tags.length ? `${i.tags.length} tags, ${tc} of ${TAGS_MAX_CHARS} characters.` : 'No tags.', ...(i.tags.length ? {} : { fix: { label: 'Go to Tags', href: '#publish-tags' } }) },
  );

  const thumbs = i.thumbnailTexts.length;
  const long = hardToRead(i.thumbnailTexts);
  add(
    !thumbs
      ? { id: 'thumbnails', label: 'Thumbnails', status: 'fail', detail: 'No thumbnails yet.', fix: { label: 'Go to Thumbnails', href: '#publish-thumbnails' } }
      : long.length
        ? {
            id: 'thumbnails',
            label: 'Thumbnails',
            status: 'warn',
            detail: `Hard to read on a phone: “${long.join('”, “')}”. Keep to ${THUMB_MAX_WORDS} short words.`,
            fix: { label: 'Go to Thumbnails', href: '#publish-thumbnails' },
          }
        : {
            id: 'thumbnails',
            label: 'Thumbnails',
            status: thumbs < 3 ? 'warn' : 'pass',
            detail: thumbs < 3 ? `${thumbs} thumbnail${thumbs === 1 ? '' : 's'}: Test and compare takes 3.` : '3 thumbnails with short words, ready for Test and compare.',
          },
  );

  add(
    i.hasTimeline
      ? { id: 'subtitles', label: 'Subtitles', status: 'pass', detail: 'The .srt is timed to the narrator’s words.' }
      : { id: 'subtitles', label: 'Subtitles', status: 'warn', detail: 'This render predates word-timed subtitles. Render again for an accurate .srt.', fix: render },
  );

  add(
    i.endScreenSec >= 5
      ? { id: 'end-screen', label: 'End screen', status: 'info', detail: `The last ${Math.round(i.endScreenSec)} s are an end screen: add the video and subscribe boxes in YouTube Studio.` }
      : { id: 'end-screen', label: 'End screen', status: 'info', detail: 'No end screen in this render. YouTube’s end-screen boxes will cover the last seconds of the video.', fix: { label: 'Visuals settings', href: `/videos/${i.videoId}/visuals` } },
  );

  add(
    i.aiVisuals.length && !i.drawn
      ? {
          id: 'ai-use',
          label: 'AI use: likely Yes',
          status: 'warn',
          detail: `${i.aiVisuals.length} AI-made picture${i.aiVisuals.length === 1 ? '' : 's'} or clip${i.aiVisuals.length === 1 ? '' : 's'} (${[...new Set(i.aiVisuals)].slice(0, 2).join(', ')}). If any look like real footage of real places, people or events, answer Yes under Attributes, AI use.`,
        }
      : {
          id: 'ai-use',
          label: 'AI use: No',
          status: 'info',
          detail: i.drawn
            ? 'Drawn animation, an AI-written script and an AI narrator don’t need disclosing. Answer No under Attributes, AI use.'
            : 'No realistic AI pictures or footage. An AI-written script, thumbnail or narrator doesn’t need disclosing. Answer No under Attributes, AI use.',
        },
  );

  add({ id: 'kids', label: 'Made for kids: No', status: 'info', detail: 'Answer No unless the video is made for children; Yes turns off comments and personalised ads.' });

  if (i.permissionFootage > 0) {
    add({
      id: 'permission',
      label: 'Streamers’ footage',
      status: 'info',
      detail: `${i.permissionFootage} shot${i.permissionFootage === 1 ? ' uses' : 's use'} streamers’ clips: keep their permission on record, and their credit in the description.`,
    });
  }
  return checks;
}

/** The headline: ready, or how many things to fix. */
export function uploadVerdict(checks: UploadCheck[]): { ready: boolean; fail: number; warn: number } {
  const fail = checks.filter((c) => c.status === 'fail').length;
  const warn = checks.filter((c) => c.status === 'warn').length;
  return { ready: fail === 0, fail, warn };
}
