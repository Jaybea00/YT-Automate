import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { moodSpeed } from '@/lib/script/delivery-moods';
import { rendersDir } from '../publish/publish-assets';
import { getAudioDurationMs } from '../utils/ffmpeg';
import { saveBeatVoice } from './beat-voice-store';
import { checkVoiceAudio, dropSpuriousAdditions, resolveVoiceCheckContext, runVoiceCheck, saveVoiceCheck, withRetries, type VoiceIssue } from './voice-check';
import { readBeatVoices, resolveTtsSetup, setupForBeat, synthesizeSpoken, ttsUnitInput, voiceBeat, voiceKeyOf, withSpeed } from './voice-beat';

/**
 * Re-takes: when the listen-back check finds a beat's voicing wrong (skipped, garbled, cut off,
 * mispronounced), the beat is voiced again at slightly different paces (so even a voice that
 * always reads the same text the same way gives a new reading), each take is checked, and the
 * best one is kept, only if it's better than the current one. The chosen take is saved on the
 * beat, so later voicing runs keep it.
 */

/** How bad a voicing's problems are: missing or broken words count most. */
const WEIGHT: Record<VoiceIssue['type'], number> = { skipped: 3, cut_off: 3, garbled: 3, mispronounced: 2, added: 1 };
export const takeBadness = (issues: VoiceIssue[]) => issues.reduce((s, i) => s + (WEIGHT[i.type] ?? 1), 0);

/** Paces of the extra takes, as multiples of the beat's own pace. */
export const TAKE_PACES = [0.97, 1.03];

export interface RetakeResult {
  beatIndex: number;
  status: 'already_ok' | 'improved' | 'fixed' | 'no_better' | 'skipped';
  /** Why a beat was skipped (its own recording, character voices, not voiced yet). */
  reason?: string;
  before: VoiceIssue[];
  after: VoiceIssue[];
  takesTried: number;
}

/** The newest voiced audio for a beat (latest job first). */
async function latestBeatAudio(supabase: SupabaseClient, videoId: string, beatIndex: number): Promise<string | null> {
  const { data: jobs } = await supabase.from('yt_jobs').select('id').eq('video_id', videoId).order('created_at', { ascending: false });
  for (const job of jobs ?? []) {
    const { data: unit } = await supabase
      .from('yt_job_units')
      .select('output_path')
      .eq('job_id', job.id)
      .eq('stage', 'tts')
      .eq('status', 'done')
      .eq('unit_index', beatIndex)
      .maybeSingle();
    if (unit?.output_path) return unit.output_path as string;
  }
  return null;
}

export async function retakeBeat(supabase: SupabaseClient, videoId: string, beatIndex: number, options: { force?: boolean } = {}): Promise<RetakeResult> {
  const skip = (reason: string, before: VoiceIssue[] = []): RetakeResult => ({ beatIndex, status: 'skipped', reason, before, after: before, takesTried: 0 });
  const { data: video } = await supabase.from('videos').select('id, script_json').eq('id', videoId).maybeSingle();
  const narration: string | undefined = video?.script_json?.beats?.[beatIndex]?.text;
  if (!video || !narration) throw new Error(`Beat ${beatIndex + 1} not found`);
  const beatVoice = readBeatVoices(video.script_json.beat_voice)[beatIndex];
  if (beatVoice?.recorded) return skip('This beat uses your own recording.');
  if (beatVoice?.parts?.length) return skip('This beat has character voices; re-voice it from Vibedit instead.');

  const current = await latestBeatAudio(supabase, videoId, beatIndex);
  if (!current) return skip('This beat has not been voiced yet.');
  const ctx = await resolveVoiceCheckContext(supabase);
  const before = (await runVoiceCheck(current, narration, ctx, { force: options.force })).issues;
  if (!before.length) return { beatIndex, status: 'already_ok', before, after: before, takesTried: 0 };

  const { data: job } = await supabase
    .from('yt_jobs')
    .select('id, template, script, tts_provider_config_id')
    .eq('video_id', videoId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!job) return skip('This beat has not been voiced yet.', before);
  const base = await resolveTtsSetup(supabase, job);
  const beatSetup = await setupForBeat(supabase, base, beatVoice);
  const { spokenText } = ttsUnitInput(beatSetup, narration);
  const ownPace = beatVoice?.speed ?? moodSpeed(beatVoice?.mood);

  const dir = path.join(rendersDir(videoId), 'takes');
  await fs.mkdir(dir, { recursive: true });
  let best: { path: string; issues: VoiceIssue[]; transcript: string; words?: Array<{ word: string; start: number; end: number }>; durationMs: number } | null = null;
  const tried: string[] = [];
  for (const [k, pace] of TAKE_PACES.entries()) {
    const take = await synthesizeSpoken(withSpeed(beatSetup, base, ownPace * pace), spokenText, beatIndex);
    const file = path.join(dir, `beat_${beatIndex}_${Date.now()}_${k}.${take.mimeType?.includes('wav') ? 'wav' : 'mp3'}`);
    await fs.writeFile(file, take.bytes);
    tried.push(file);
    const checked = await withRetries(() => checkVoiceAudio(file, spokenText, ctx));
    const issues = dropSpuriousAdditions(checked.issues, spokenText);
    if (!best || takeBadness(issues) < takeBadness(best.issues)) {
      best = { path: file, issues, transcript: checked.transcript, words: take.words, durationMs: take.durationMs ?? (await getAudioDurationMs(file)) };
    }
    if (!issues.length) break;
  }

  // Takes not chosen are deleted
  const keep = best && takeBadness(best.issues) < takeBadness(before) ? best : null;
  for (const f of tried) if (f !== keep?.path) await fs.rm(f, { force: true });
  if (!keep) return { beatIndex, status: 'no_better', before, after: before, takesTried: tried.length };

  // The chosen take becomes the beat's voicing (and stays it across voicing runs)
  await saveBeatVoice(supabase, videoId, beatIndex, {
    take: { path: keep.path, durationMs: keep.durationMs, spokenText, voiceKey: voiceKeyOf(beatSetup), ...(keep.words?.length ? { words: keep.words } : {}) },
  });
  const voiced = await voiceBeat({
    supabase,
    setup: base,
    jobId: job.id,
    unitIndex: beatIndex,
    narration,
    outputDir: path.join(process.cwd(), 'storage', 'jobs', job.id, 'audio'),
    beatVoice: readBeatVoices((await supabase.from('videos').select('script_json').eq('id', videoId).maybeSingle()).data?.script_json?.beat_voice)[beatIndex],
  });
  if (!voiced.success || !voiced.outputPath) throw new Error(voiced.error || 'Saving the new take failed');
  // The take was already checked: its result goes with the beat's new audio
  await saveVoiceCheck(voiced.outputPath, keep.transcript, keep.issues);
  return { beatIndex, status: keep.issues.length ? 'improved' : 'fixed', before, after: keep.issues, takesTried: tried.length };
}
