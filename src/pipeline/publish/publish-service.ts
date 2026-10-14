import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Writable } from 'node:stream';
import type { SupabaseClient } from '@supabase/supabase-js';
import yazl from 'yazl';
import { withWritingModel } from '@/lib/script/generate-script';
import { loadCaptionWords } from '../assembly/caption-sources';
import { resolveForStage } from '../providers/registry';
import type { LLMProvider } from '../providers/types';
import { buildDescriptionCredits } from '../utils/credits';
import { readTimeline, type VideoTimeline } from '../utils/timeline';
import { themeForStyle } from '../visuals/motion/theme';
import { composeDescription, generateMetadata, type VideoMetadata } from './metadata';
import { generateThumbnails, rendersDir } from './publish-assets';
import { fallbackShortPlans, planShorts, renderShort, type ShortClip } from './shorts';
import { subtitlesForVideo } from './subtitle-files';
import type { Thumbnail } from './thumbnails';

/**
 * Everything needed to publish a rendered video: the metadata, thumbnails and Shorts (generated
 * here or after assembly), the user's edits, and the download package.
 */

export interface PublishEdits {
  title?: string;
  description?: string;
  tags?: string[];
}

export interface PublishState {
  metadata?: VideoMetadata | null;
  thumbnails?: Thumbnail[] | null;
  shorts?: ShortClip[] | null;
  edits?: PublishEdits;
}

interface VideoRow {
  id: string;
  title: string | null;
  topic: string | null;
  style: string | null;
  status: string | null;
  script_json: (Record<string, unknown> & {
    beats?: Array<{ text: string }>;
    publish?: PublishState;
    formatted_chapters?: string;
    music_credits?: string[];
    sections?: { sections?: Array<{ start_beat: number; title: string }> };
    research?: { facts?: Array<{ claim: string }> };
  }) | null;
}

export async function loadVideo(supabase: SupabaseClient, videoId: string): Promise<VideoRow | null> {
  const { data } = await supabase.from('videos').select('id, title, topic, style, status, script_json').eq('id', videoId).maybeSingle();
  return (data as VideoRow | null) ?? null;
}

export const finalVideoPath = (videoId: string) => path.join(rendersDir(videoId), 'final_video.mp4');

async function savePublish(supabase: SupabaseClient, videoId: string, patch: Partial<PublishState>): Promise<PublishState> {
  // Merge into the latest script_json so concurrent edits elsewhere survive
  const video = await loadVideo(supabase, videoId);
  const publish = { ...(video?.script_json?.publish ?? {}), ...patch };
  const { error } = await supabase.from('videos').update({ script_json: { ...(video?.script_json ?? {}), publish } }).eq('id', videoId);
  if (error) throw new Error(`Could not save: ${error.message}`);
  return publish;
}

async function scriptLlm(supabase: SupabaseClient) {
  return resolveForStage<LLMProvider>('script', supabase).catch(() => null);
}

/** Everything the publish page shows, with the user's edits taking precedence. */
export async function publishView(supabase: SupabaseClient, video: VideoRow) {
  const sj = video.script_json ?? {};
  const publish = sj.publish ?? {};
  const meta = publish.metadata ?? null;
  const edits = publish.edits ?? {};
  const { data: assets } = await supabase.from('video_assets').select('license_type, attribution_text').eq('video_id', video.id);
  const credits = buildDescriptionCredits(Array.isArray(sj.music_credits) ? sj.music_credits : [], assets ?? []);
  const generatedDescription = meta
    ? composeDescription({ hook: meta.hook, summary: meta.summary, chapters: sj.formatted_chapters, credits, hashtags: meta.hashtags })
    : '';
  const rendered = await fsp.stat(finalVideoPath(video.id)).then((s) => s.size > 0).catch(() => false);
  return {
    videoId: video.id,
    rendered,
    hasTimeline: Boolean(readTimeline(sj)),
    titles: meta?.titles ?? [],
    title: edits.title ?? meta?.titles[0]?.text ?? video.title ?? '',
    description: edits.description ?? generatedDescription,
    generatedDescription,
    tags: edits.tags ?? meta?.tags ?? [],
    hashtags: meta?.hashtags ?? [],
    chapters: sj.formatted_chapters ?? '',
    credits,
    thumbnails: (publish.thumbnails ?? []).map((t, i) => ({ n: i + 1, text: t.text, atSec: t.atSec })),
    shorts: (publish.shorts ?? []).map((s, i) => ({ n: i + 1, title: s.title, hook: s.hook, startSec: s.startSec, endSec: s.endSec })),
    edited: Boolean(edits.title || edits.description || edits.tags),
    metadataGeneratedAt: meta?.generatedAt ?? null,
  };
}

export async function saveEdits(supabase: SupabaseClient, videoId: string, edits: PublishEdits): Promise<void> {
  const video = await loadVideo(supabase, videoId);
  const current = video?.script_json?.publish?.edits ?? {};
  await savePublish(supabase, videoId, { edits: { ...current, ...edits } });
}

export async function regenerateMetadata(supabase: SupabaseClient, video: VideoRow): Promise<void> {
  const sj = video.script_json ?? {};
  const llm = await scriptLlm(supabase);
  if (!llm) throw new Error('No script LLM is configured');
  const metadata = await generateMetadata({
    topic: video.topic ?? '',
    style: video.style,
    currentTitle: video.title,
    narration: (sj.beats ?? []).map((b) => b.text),
    sectionTitles: sj.sections?.sections?.map((s) => s.title) ?? [],
    facts: (sj.research?.facts ?? []).map((f) => f.claim),
    llm: llm.provider,
    ctx: withWritingModel(llm.ctx, llm.options),
  });
  // Fresh text replaces earlier edits to the title, description and tags
  await savePublish(supabase, video.id, { metadata, edits: {} });
}

function requireTimeline(video: VideoRow): VideoTimeline {
  const timeline = readTimeline(video.script_json);
  if (!timeline) throw new Error('Render the video first (this needs a render made after the publishing update)');
  return timeline;
}

export async function regenerateThumbnails(supabase: SupabaseClient, video: VideoRow, title?: string): Promise<void> {
  const timeline = requireTimeline(video);
  const sj = video.script_json ?? {};
  const thumbnails = await generateThumbnails({
    videoId: video.id,
    timeline,
    finalVideoPath: finalVideoPath(video.id),
    title: title || sj.publish?.edits?.title || sj.publish?.metadata?.titles[0]?.text || video.title || '',
    topic: video.topic ?? '',
    narration: (sj.beats ?? []).map((b) => b.text).join(' '),
    theme: themeForStyle(video.style),
    llm: await scriptLlm(supabase),
  });
  await savePublish(supabase, video.id, { thumbnails });
}

export async function createShorts(supabase: SupabaseClient, video: VideoRow): Promise<void> {
  const timeline = requireTimeline(video);
  const sj = video.script_json ?? {};
  const beats = (sj.beats ?? []).map((b, i) => ({ index: i, text: b.text }));
  const title = sj.publish?.edits?.title || sj.publish?.metadata?.titles[0]?.text || video.title || '';
  const llm = await scriptLlm(supabase);
  let plans = llm
    ? await planShorts({ beats, timeline, topic: video.topic ?? '', llm: llm.provider, ctx: llm.ctx }).catch((err) => {
        console.warn(`[Shorts] Planning with the LLM failed; using section openings: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
        return [];
      })
    : [];
  if (plans.length === 0) plans = fallbackShortPlans(timeline, (sj.sections?.sections ?? []).map((s) => s.start_beat), title);
  if (plans.length === 0) throw new Error('No stretch of the video fits a Short (20-59 seconds of whole beats)');

  const words = await loadCaptionWords(timeline.beats.map((b) => ({ index: b.index, text: beats[b.index]?.text ?? '', audioPath: b.audioPath })));
  const dir = path.join(rendersDir(video.id), 'shorts');
  await fsp.rm(dir, { recursive: true, force: true });
  const shorts: ShortClip[] = [];
  for (const [i, plan] of plans.entries()) {
    shorts.push(
      await renderShort({
        videoPath: finalVideoPath(video.id),
        plan,
        timeline,
        beats,
        words,
        highlightHex: themeForStyle(video.style).accent,
        outPath: path.join(dir, `short_${i + 1}.mp4`),
      }),
    );
  }
  await savePublish(supabase, video.id, { shorts });
}

/** A published file (thumbnail or Short), only from this video's own render folder. */
export function publishFilePath(video: VideoRow, kind: 'thumbnail' | 'short', n: number): string | null {
  const list = kind === 'thumbnail' ? video.script_json?.publish?.thumbnails : video.script_json?.publish?.shorts;
  const item = list?.[n - 1];
  if (!item?.path) return null;
  const resolved = path.resolve(item.path);
  return resolved.startsWith(path.resolve(rendersDir(video.id)) + path.sep) ? resolved : null;
}

const safeName = (s: string) => s.replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/\s+/g, '_').slice(0, 80) || 'video';

/**
 * Streams the upload package: the video, thumbnails, Shorts, subtitles, and text files with the
 * title, description, tags and Shorts titles. Media is stored, not recompressed.
 */
export async function writePackage(supabase: SupabaseClient, video: VideoRow, out: Writable): Promise<void> {
  const view = await publishView(supabase, video);
  const subtitles = await subtitlesForVideo(supabase, video);
  const zip = new yazl.ZipFile();
  const base = safeName(view.title || video.topic || 'video');

  const final = finalVideoPath(video.id);
  if (await fsp.stat(final).then(() => true).catch(() => false)) zip.addFile(final, `${base}.mp4`, { compress: false });
  const exists = (file: string | null): Promise<boolean> =>
    file ? fsp.stat(file).then((s) => s.isFile()).catch(() => false) : Promise.resolve(false);
  for (const t of view.thumbnails) {
    const file = publishFilePath(video, 'thumbnail', t.n);
    if (file && (await exists(file))) zip.addFile(file, `thumbnails/thumbnail_${t.n}.jpg`, { compress: false });
  }
  for (const s of view.shorts) {
    const file = publishFilePath(video, 'short', s.n);
    if (file && (await exists(file))) zip.addFile(file, `shorts/short_${s.n}.mp4`, { compress: false });
  }
  if (subtitles.srt.trim()) zip.addBuffer(Buffer.from(subtitles.srt, 'utf-8'), `${base}.srt`);

  const youtube = [
    `TITLE\n${view.title}`,
    view.titles.length > 1 ? `OTHER TITLE OPTIONS\n${view.titles.map((t) => `- ${t.text} (${t.angle})`).join('\n')}` : '',
    `DESCRIPTION\n${view.description}`,
    `TAGS\n${view.tags.join(', ')}`,
  ].filter(Boolean).join('\n\n');
  zip.addBuffer(Buffer.from(youtube, 'utf-8'), 'youtube.txt');
  if (view.shorts.length) {
    const shortsText = view.shorts
      .map((s) => `short_${s.n}.mp4\nTitle: ${s.title} #Shorts\nFrom ${s.startSec.toFixed(1)}s to ${s.endSec.toFixed(1)}s of the full video`)
      .join('\n\n');
    zip.addBuffer(Buffer.from(shortsText, 'utf-8'), 'shorts/shorts.txt');
  }

  const done = new Promise<void>((resolve, reject) => {
    out.on('finish', () => resolve());
    out.on('error', reject);
    zip.outputStream.on('error', reject);
  });
  zip.outputStream.pipe(out);
  zip.end();
  await done;
}
