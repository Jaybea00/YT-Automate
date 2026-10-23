import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '../providers/registry';
import type { LLMProvider } from '../providers/types';
import { narrationHash } from './sound-moments';
import { prepareRealSound } from './real-sfx';
import { ensureSoundLibrary, soundPath } from './sfx';

/**
 * Music that hits moments: it swells into a reveal, falls silent just before a key line (so the
 * line lands in the quiet), and a sting marks each chapter change. Reveals and key lines are
 * chosen once per narration and saved; the timings come from the voice.
 */

export interface MusicMomentPlan {
  textHash: string;
  plannedAt: string;
  /** Beats whose opening line is a reveal: the music builds into them. */
  reveals: number[];
  /** Beats whose line should land in silence. */
  key_lines: number[];
}

export interface MusicAccents {
  /** Where each swell peaks, in seconds. */
  swellsSec: number[];
  /** Silences: the music is gone from start to end, fading out before and back in after. */
  drops: Array<{ startSec: number; endSec: number }>;
  /** Chapter-change stings, in seconds. */
  stingsSec: number[];
}

const SWELL_GAIN = 0.5;
const SWELL_RISE_SEC = 4;
const SWELL_FALL_SEC = 2;
const DROP_FADE_OUT_SEC = 0.4;
const DROP_FADE_IN_SEC = 1.5;
/** The music is gone this long before the key line starts. */
const DROP_LEAD_SEC = 0.8;
/** A drop never lasts longer than this, however long the line. */
const MAX_DROP_SEC = 8;
/** Swells this close to a chapter change or a drop are left out (the build or the silence already marks it). */
const SWELL_CLEARANCE_SEC = 4;

const Schema = z.object({ reveals: z.array(z.number()), key_lines: z.array(z.number()) });

type Beat = { index: number; text: string };

export function buildMusicMomentsPrompt(beats: Beat[]): string {
  return `You score a documentary. From the narration below, pick:
- reveals: beats whose opening line is a reveal or turn (the answer to a question the video raised, a twist, a shocking fact). The music builds into them. At most ${Math.max(1, Math.round(beats.length / 10))}.
- key_lines: beats whose line should land in silence: the single most important or emotional lines, often short. The music drops out just before them. At most ${Math.max(1, Math.round(beats.length / 15))}.
Use beat indexes. Pick only real peaks; ordinary beats get nothing. A beat can't be both.

NARRATION (beat index, text):
${beats.map((b) => `[${b.index}] ${b.text}`).join('\n')}`;
}

export function normalizeMusicMoments(raw: z.infer<typeof Schema>, beats: Beat[]): Pick<MusicMomentPlan, 'reveals' | 'key_lines'> {
  const valid = new Set(beats.map((b) => b.index));
  const keyLines = [...new Set(raw.key_lines.filter((b) => valid.has(b)))].sort((a, b) => a - b).slice(0, Math.max(1, Math.round(beats.length / 15)));
  const reveals = [...new Set(raw.reveals.filter((b) => valid.has(b) && !raw.key_lines.includes(b)))]
    .sort((a, b) => a - b)
    .slice(0, Math.max(1, Math.round(beats.length / 10)));
  return { reveals, key_lines: keyLines };
}

/** The saved plan while the narration is unchanged, otherwise a new one (saved for next time). */
export async function ensureMusicMoments(supabase: SupabaseClient, videoId: string, beats: Beat[]): Promise<MusicMomentPlan> {
  const textHash = narrationHash(beats);
  const { data: row } = await supabase.from('videos').select('script_json').eq('id', videoId).maybeSingle();
  const saved = row?.script_json?.music_moments as MusicMomentPlan | undefined;
  if (saved?.textHash === textHash) return saved;

  const { provider, ctx } = await resolveForStage<LLMProvider>('script', supabase);
  const { data } = await provider.generateJson(
    { system: 'You are a film composer who knows when music should swell and when it should get out of the way.', prompt: buildMusicMomentsPrompt(beats), schema: Schema },
    ctx,
  );
  const plan: MusicMomentPlan = { textHash, plannedAt: new Date().toISOString(), ...normalizeMusicMoments(data, beats) };
  const { data: latest } = await supabase.from('videos').select('script_json').eq('id', videoId).maybeSingle();
  if (latest?.script_json) {
    await supabase.from('videos').update({ script_json: { ...latest.script_json, music_moments: plan } }).eq('id', videoId);
  }
  console.log(`[Music] Reveals at beats ${plan.reveals.join(', ') || 'none'}; silence before beats ${plan.key_lines.join(', ') || 'none'}`);
  return plan;
}

/** Turns the plan into times, from each beat's voice and the chapter changes. */
export function accentTimes(
  plan: Pick<MusicMomentPlan, 'reveals' | 'key_lines'>,
  voices: Record<number, { startMs: number; endMs: number }>,
  chapterChangesMs: number[],
): MusicAccents {
  const drops = plan.key_lines
    .map((b) => voices[b])
    .filter((v): v is { startMs: number; endMs: number } => Boolean(v))
    .map((v) => {
      const startSec = Math.max(0, v.startMs / 1000 - DROP_LEAD_SEC);
      return { startSec, endSec: Math.min(v.endMs / 1000, startSec + MAX_DROP_SEC) };
    });
  const chapterSec = chapterChangesMs.map((ms) => ms / 1000);
  const swellsSec = plan.reveals
    .map((b) => voices[b])
    .filter((v): v is { startMs: number; endMs: number } => Boolean(v))
    .map((v) => Math.max(0, v.startMs / 1000 - 0.3))
    .filter((t) => !chapterSec.some((c) => Math.abs(c - t) < SWELL_CLEARANCE_SEC))
    .filter((t) => !drops.some((d) => t > d.startSec - SWELL_CLEARANCE_SEC && t < d.endSec + SWELL_CLEARANCE_SEC));
  return { swellsSec, drops, stingsSec: chapterSec };
}

const r = (n: number) => n.toFixed(3);

/** ffmpeg volume expression (per frame) for the swells and drops; "1" when there are none. */
export function accentExpression(accents: Pick<MusicAccents, 'swellsSec' | 'drops'>): string {
  const parts: string[] = [];
  if (accents.swellsSec.length) {
    const ramps = accents.swellsSec.map(
      (p) => `min(max(0,min(1,(t-${r(p - SWELL_RISE_SEC)})/${SWELL_RISE_SEC})),max(0,min(1,(${r(p + SWELL_FALL_SEC)}-t)/${SWELL_FALL_SEC})))`,
    );
    parts.push(`(1+${SWELL_GAIN}*(${ramps.join('+')}))`);
  }
  for (const d of accents.drops) {
    const fadingOut = `max(0,min(1,(t-${r(d.startSec - DROP_FADE_OUT_SEC)})/${DROP_FADE_OUT_SEC}))`;
    const fadingIn = `max(0,min(1,(${r(d.endSec + DROP_FADE_IN_SEC)}-t)/${DROP_FADE_IN_SEC}))`;
    parts.push(`(1-${fadingOut}*${fadingIn})`);
  }
  return parts.length ? parts.join('*') : '1';
}

/** The sting recording: a real one when available, otherwise the built-in impact. */
export async function stingPath(): Promise<string> {
  const real = await prepareRealSound('music_sting').catch(() => null);
  if (real) return real;
  await ensureSoundLibrary();
  return soundPath('impact');
}
