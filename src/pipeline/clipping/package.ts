import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ClipProject } from './types';

/** "gta 6 funny moments" -> "#GTA6FunnyMoments"-style hashtag, kept short. */
export function hashtag(tag: string): string {
  const words = tag.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const joined = words.map((w) => (/^gta$/i.test(w) ? 'GTA' : w[0].toUpperCase() + w.slice(1))).join('');
  return joined ? `#${joined}` : '';
}

/** Who to credit: the handle the user gave, else the account that posted it. */
export function creditName(project: ClipProject): string {
  return project.creator.trim() || project.source?.uploaderHandle || project.source?.uploader || 'the original creator';
}

/** The description to paste: the summary, the credit with a link, then hashtags (#Shorts first). */
export function composeUploadDescription(project: ClipProject): string {
  const plan = project.plan;
  const credit = `🎥 Clip by ${creditName(project)}${project.source?.pageUrl ? ` (${project.source.pageUrl})` : ''}`;
  const tags = ['#Shorts', ...(plan?.tags ?? []).slice(0, 4).map(hashtag)].filter((t, i, all) => t && all.indexOf(t) === i);
  return [plan?.description?.trim(), credit, tags.join(' ')].filter(Boolean).join('\n\n');
}

/** Everything needed to upload by hand, as one text file. */
export function uploadInfoText(project: ClipProject): string {
  const plan = project.plan;
  const lines = [
    'TITLE OPTIONS',
    ...(plan?.titles ?? []).map((t, i) => `${i + 1}. ${t}`),
    '',
    'DESCRIPTION',
    composeUploadDescription(project),
    '',
    'TAGS (paste into the tags box)',
    (plan?.tags ?? []).join(', '),
    '',
    'SOURCE',
    `${project.source?.platform ?? ''} ${project.source?.pageUrl ?? project.sourceUrl}`.trim(),
    `Credit: ${creditName(project)}`,
  ];
  if (project.analysis?.musicSections.length && !plan?.muteMusic) {
    lines.push('', 'NOTE: this clip may contain in-game radio music, which can get a Content ID claim.');
  }
  return lines.join('\n') + '\n';
}

export async function writeUploadInfo(dir: string, project: ClipProject): Promise<string> {
  const file = path.join(dir, 'export', 'upload-info.txt');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, uploadInfoText(project), 'utf-8');
  return file;
}
