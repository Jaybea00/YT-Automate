import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { transcribe } from '../clipping/analyze';
import { clipLlm } from '../clipping/script';
import { getFfmpegPath } from '../utils/ffmpeg';
import { RECIPE_IDS } from './recipes';
import type { Candidate, Moment, RecipeId, TimedText } from './types';

const execFileAsync = promisify(execFile);

/** Shortest and longest moment kept. */
export const MIN_MOMENT_SEC = 10;
export const MAX_MOMENT_SEC = 60;
const BATCH = 8;

export interface CandidateContext {
  candidate: Candidate;
  /** What was said, as timed lines (seconds into the stream). */
  speech: TimedText[];
  chat: TimedText[];
}

/** What was said in each flagged stretch: YouTube's captions when there are any, else Whisper on that stretch alone. */
export async function gatherSpeech(
  dir: string,
  audioFile: string,
  candidates: Candidate[],
  captions: TimedText[],
  onProgress: (done: number) => Promise<void> | void,
): Promise<{ speech: TimedText[][]; warnings: string[] }> {
  const speech: TimedText[][] = [];
  const warnings: string[] = [];
  let whisperFailed = false;
  for (const [i, c] of candidates.entries()) {
    if (captions.length) {
      speech.push(captions.filter((l) => l.t >= c.start && l.t <= c.end));
    } else if (whisperFailed) {
      speech.push([]);
    } else {
      const wav = path.join(dir, `window_${randomBytes(3).toString('hex')}.wav`);
      try {
        await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', '-ss', c.start.toFixed(2), '-t', (c.end - c.start).toFixed(2), '-i', path.join(dir, audioFile), '-vn', '-ac', '1', '-ar', '16000', wav]);
        const { words } = await transcribe(wav, c.end - c.start);
        speech.push(linesFromWords(words.map((w) => ({ ...w, start: w.start + c.start, end: w.end + c.start }))));
      } catch (err) {
        whisperFailed = true;
        warnings.push(`Speech could not be transcribed, so moments were judged on sound and chat only: ${err instanceof Error ? err.message.slice(0, 140) : err}`);
        speech.push([]);
      } finally {
        await fs.unlink(wav).catch(() => {});
      }
    }
    await onProgress(i + 1);
  }
  return { speech, warnings };
}

/** Words grouped into lines at pauses. */
export function linesFromWords(words: Array<{ word: string; start: number; end: number }>): TimedText[] {
  const lines: Array<TimedText & { end: number }> = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last && w.start - last.end < 0.8 && last.text.length < 160) {
      last.text += ` ${w.word}`;
      last.end = w.end;
    } else lines.push({ t: w.start, text: w.word, end: w.end });
  }
  return lines.map(({ t, text }) => ({ t: Math.round(t * 10) / 10, text }));
}

const fmt = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}`;
};

const JudgeSchema = z.object({
  moments: z.array(
    z.object({
      index: z.number().describe('The stretch number as given'),
      keep: z.boolean().describe('True only if this works as a stand-alone Short'),
      recipe: z.enum(RECIPE_IDS as [RecipeId, ...RecipeId[]]),
      score: z.number().describe('1-10: how good a Short it makes (8+ = great)'),
      start: z.number().describe('Seconds into the stream where the Short should start'),
      end: z.number().describe('Seconds into the stream where it should end'),
      reason: z.string().describe('One sentence: what happens'),
      hook: z.string().describe('On-screen hook for the Short, under 60 characters'),
    }),
  ),
});

export function buildJudgePrompt(stream: { title: string; uploader: string }, batch: Array<CandidateContext & { index: number }>): string {
  const blocks = batch.map(({ index, candidate: c, speech, chat }) => {
    const said = speech.length ? speech.map((l) => `  [${l.t.toFixed(1)}] ${l.text}`).join('\n') : '  (nothing transcribed)';
    const typed = chat.length ? chat.slice(0, 25).map((m) => `  [${m.t.toFixed(0)}] ${m.text.slice(0, 80)}`).join('\n') : '  (no chat)';
    return `STRETCH ${index}: ${c.start.toFixed(1)}-${c.end.toFixed(1)}s (${fmt(c.start)}-${fmt(c.end)}), peak at ${c.at.toFixed(1)}s, signal strength ${c.score.toFixed(1)}, ${c.chatCount} chat messages, hint: ${c.recipeGuess}
Streamer said:
${said}
Chat:
${typed}`;
  });
  return `You pick YouTube Short moments from a finished gaming livestream (GTA).

STREAM: "${stream.title}" by ${stream.uploader || 'unknown'}

Each stretch below was flagged because the sound got loud, chat got busy, or reactions spiked. For EVERY stretch return one entry:
- keep: true only if a viewer with no context would enjoy it as a 10-60 second Short (a funny moment, chaos, a chase, a clutch play, a rage moment, a glitch). Talking, menus, waiting, reading donations, or chat just saying hi: false.
- recipe: funny, chase, crash, clutch, rage, glitch, or other.
- score: 1-10, honest. 8+ only for moments you'd expect to do really well.
- start/end: seconds into the stream, inside the stretch, 10-60 seconds long; start with enough setup to understand it and end shortly after the reaction.
- reason: one sentence on what happens, based only on the transcript and chat. Never invent details.
- hook: a scroll-stopping on-screen line under 60 characters, without spoiling the payoff.

${blocks.join('\n\n')}`;
}

/** Keeps a judged moment inside its stretch (with a little slack) and between the length limits. */
export function clampMoment(start: number, end: number, c: Candidate, durationSec: number): { start: number; end: number } {
  let s = Number.isFinite(start) ? Math.max(c.start - 5, Math.min(start, c.at)) : c.start;
  let e = Number.isFinite(end) ? Math.min(c.end + 8, Math.max(end, c.at + 2)) : c.end;
  s = Math.max(0, s);
  e = Math.min(durationSec, e);
  if (e - s > MAX_MOMENT_SEC) e = s + MAX_MOMENT_SEC;
  if (e - s < MIN_MOMENT_SEC) {
    const pad = (MIN_MOMENT_SEC - (e - s)) / 2;
    s = Math.max(0, s - pad);
    e = Math.min(durationSec, e + pad);
  }
  return { start: Math.round(s * 10) / 10, end: Math.round(e * 10) / 10 };
}

/**
 * The judge's picks: the stretches that make good Shorts, labelled and tightened, best first. If the
 * judge can't be reached, the strongest stretches by signal are kept instead (with a warning).
 */
export async function judgeCandidates(
  stream: { title: string; uploader: string; durationSec: number },
  contexts: CandidateContext[],
  maxMoments: number,
  onProgress: (done: number) => Promise<void> | void = () => {},
): Promise<{ moments: Moment[]; warnings: string[] }> {
  const picks: Moment[] = [];
  const warnings: string[] = [];
  let llm: ReturnType<typeof clipLlm> | null = null;
  try {
    llm = clipLlm();
  } catch (err) {
    warnings.push(`${err instanceof Error ? err.message : err}. Moments were picked by sound and chat only.`);
  }

  const numbered = contexts.map((c, index) => ({ ...c, index }));
  for (let b = 0; b < numbered.length; b += BATCH) {
    const batch = numbered.slice(b, b + BATCH);
    let judged: z.infer<typeof JudgeSchema>['moments'] | null = null;
    if (llm) {
      try {
        const { data } = await llm.provider.generateJson({ prompt: buildJudgePrompt(stream, batch), schema: JudgeSchema, maxTokens: 12000 }, llm.ctx);
        judged = data.moments;
      } catch (err) {
        warnings.push(`The judge failed on part of the stream, so those moments were picked by signals only: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
      }
    }
    for (const ctx of batch) {
      const c = ctx.candidate;
      const j = judged?.find((m) => m.index === ctx.index);
      if (judged && (!j || !j.keep)) continue;
      const { start, end } = j ? clampMoment(j.start, j.end, c, stream.durationSec) : { start: c.start, end: c.end };
      picks.push({
        id: `m${String(ctx.index).padStart(2, '0')}`,
        start,
        end,
        recipe: j?.recipe ?? c.recipeGuess,
        score: j ? Math.max(1, Math.min(10, Math.round(j.score))) : Math.max(1, Math.min(7, Math.round(4 + c.score))),
        reason: j?.reason?.trim() || `Flagged by ${c.chatCount ? 'chat and sound' : 'sound'} (not checked by the judge)`,
        hook: (j?.hook || '').trim().slice(0, 70),
        transcript: ctx.speech.map((l) => l.text).join(' ').slice(0, 1500),
        chatSample: ctx.chat.slice(0, 12).map((m) => m.text.slice(0, 100)),
        status: 'found',
      });
    }
    await onProgress(Math.min(numbered.length, b + BATCH));
  }

  const judgedAny = picks.some((p) => !p.reason.startsWith('Flagged by'));
  const kept = picks
    .filter((p) => !judgedAny || p.score >= 6 || p.reason.startsWith('Flagged by'))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxMoments);
  return { moments: kept, warnings };
}
