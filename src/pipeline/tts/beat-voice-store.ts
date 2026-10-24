import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getAudioDurationMs, getFfmpegPath } from '../utils/ffmpeg';
import { rendersDir } from '../publish/publish-assets';
import { normalizeBeatVoice, type BeatVoice } from './voice-beat';

const execFileAsync = promisify(execFile);

/**
 * Saves one beat's voice settings (script_json.beat_voice). `patch` fields replace the saved
 * ones; null removes one. Returns the beat's settings now.
 */
export async function saveBeatVoice(
  supabase: SupabaseClient,
  videoId: string,
  beatIndex: number,
  patch: { speed?: number | null; narratorId?: string | null; recorded?: BeatVoice['recorded'] | null },
): Promise<BeatVoice | null> {
  const { data: video } = await supabase.from('videos').select('script_json').eq('id', videoId).maybeSingle();
  if (!video) throw new Error('Video not found');
  const sj = (video.script_json ?? {}) as Record<string, unknown> & { beats?: unknown[]; beat_voice?: Record<string, BeatVoice> };
  if (!Array.isArray(sj.beats) || !sj.beats[beatIndex]) throw new Error(`Beat ${beatIndex + 1} does not exist`);
  const current: Record<string, unknown> = { ...(sj.beat_voice?.[beatIndex] ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete current[k];
    else if (v !== undefined) current[k] = v;
  }
  const voice = normalizeBeatVoice(current);
  const all = { ...(sj.beat_voice ?? {}) };
  if (voice) all[beatIndex] = voice;
  else delete all[beatIndex];
  await supabase.from('videos').update({ script_json: { ...sj, beat_voice: all } }).eq('id', videoId);
  return voice;
}

/**
 * A microphone recording made ready to narrate a beat: rumble filtered out, levelled to the
 * narration's loudness, silence trimmed from both ends, as 48 kHz MP3 in the video's folder.
 */
export async function prepareRecording(inputPath: string, videoId: string, beatIndex: number): Promise<{ path: string; durationMs: number }> {
  const dir = path.join(rendersDir(videoId), 'recordings');
  await fs.mkdir(dir, { recursive: true });
  const out = path.join(dir, `beat_${beatIndex}_${Date.now()}.mp3`);
  const trim = 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15';
  await execFileAsync(getFfmpegPath(), [
    '-y', '-v', 'error', '-i', inputPath,
    '-af', `highpass=f=70,${trim},areverse,${trim},areverse,loudnorm=I=-18:TP=-2:LRA=11`,
    '-ac', '1', '-ar', '48000', '-c:a', 'libmp3lame', '-b:a', '160k', out,
  ]);
  // All silence trims to a file with no audio at all, which can't be measured
  const durationMs = await getAudioDurationMs(out).catch(() => 0);
  if (!durationMs || durationMs < 300) {
    await fs.rm(out, { force: true });
    throw new Error('The recording is empty or silent');
  }
  return { path: out, durationMs };
}
