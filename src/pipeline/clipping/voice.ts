import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveForStage } from '../providers/registry';
import type { ProviderCallContext, TTSProvider } from '../providers/types';
import { getAudioDurationMs } from '../utils/ffmpeg';
import type { ClipWord, VoiceLine } from './types';

/** Words spread evenly over a line's audio when the voice engine reports no timings. */
export function evenWords(text: string, durationSec: number): ClipWord[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const each = durationSec / Math.max(1, words.length);
  return words.map((word, i) => ({ word, start: Number((i * each).toFixed(2)), end: Number(((i + 1) * each).toFixed(2)) }));
}

const lineKey = (text: string, voice: string, provider: string, speed?: number) =>
  createHash('sha1').update(`${provider}|${voice}|${text}${speed && speed !== 1 ? `|x${speed}` : ''}`).digest('hex').slice(0, 16);

/**
 * Voices each line with the narration stage's voice (Kokoro, normally). Lines already voiced with
 * the same text, voice and speed are kept. Returns the lines with their audio, plus any warnings.
 * `speed` above 1 speaks faster (a guide is read faster than a reaction's asides).
 */
export async function voiceLines(
  dir: string,
  lines: VoiceLine[],
  voiceOverride: string,
  speed?: number,
  /** A voice engine to use instead of the narration stage's (a guide voiced by ElevenLabs). */
  engine?: { provider: TTSProvider; ctx: ProviderCallContext },
): Promise<{ lines: VoiceLine[]; warnings: string[]; voice: string }> {
  if (!lines.length) return { lines, warnings: [], voice: voiceOverride };
  let resolved;
  try {
    resolved = engine ?? (await resolveForStage<TTSProvider>('tts'));
  } catch (err) {
    return { lines, voice: voiceOverride, warnings: [`No voice is set up for narration, so the voiceover was skipped: ${err instanceof Error ? err.message.slice(0, 160) : err}`] };
  }
  const { provider, ctx } = resolved;
  const voice = voiceOverride || String(ctx.options.voiceId ?? ctx.options.voice ?? '') || 'af_heart';
  await fs.mkdir(path.join(dir, 'voice'), { recursive: true });

  const out: VoiceLine[] = [];
  const warnings: string[] = [];
  for (const [i, line] of lines.entries()) {
    const key = lineKey(line.text, voice, provider.id, speed);
    if (line.audioKey === key && line.audioFile && (await fs.stat(path.join(dir, line.audioFile)).then((s) => s.size > 0).catch(() => false))) {
      out.push(line);
      continue;
    }
    const file = `voice/line_${i}_${key.slice(0, 6)}.wav`;
    try {
      const result = await provider.synthesize({ text: line.text, voiceId: voice, format: 'wav', ...(speed && speed !== 1 ? { speed } : {}) }, ctx);
      await fs.writeFile(path.join(dir, file), result.bytes);
      const durationSec = (result.durationMs ?? (await getAudioDurationMs(path.join(dir, file)))) / 1000;
      // Performance tags ("[whispers]") are spoken as acting, not words: they never reach the captions
      const spoken = (result.words ?? []).filter((w) => !/^\[|\]$/.test(w.word));
      const words = spoken.length ? spoken.map((w) => ({ word: w.word, start: w.start, end: w.end })) : evenWords(line.text.replace(/\[[^\]]*\]/g, ' '), durationSec);
      out.push({ ...line, audioFile: file, audioKey: key, durationSec: Number(durationSec.toFixed(2)), words });
    } catch (err) {
      warnings.push(`Voice line "${line.text.slice(0, 40)}" could not be voiced${engine ? '' : ' (is the Kokoro server running?)'}: ${err instanceof Error ? err.message.slice(0, 140) : err}`);
      out.push({ ...line, audioFile: undefined, audioKey: undefined, durationSec: undefined, words: undefined });
    }
  }
  return { lines: out, warnings, voice };
}
