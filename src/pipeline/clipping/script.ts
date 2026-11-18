import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { geminiLlm } from '../providers/llm/gemini';
import { anthropicLlm } from '../providers/llm/anthropic';
import type { LLMProvider, LlmImage, ProviderCallContext } from '../providers/types';
import {
  DEFAULT_MAX_SHORT_SEC,
  WORDS_PER_SEC,
  type ClipAnalysis,
  type ClipLayout,
  type ClipPlan,
  type ClipProject,
  type ClipWord,
  type TextOverlay,
  type VoiceLine,
  type VoiceStyle,
} from './types';

// --------------------------------------------------------------------------
// Which model writes the script (CLIP_LLM_PROVIDER=gemini | claude)
// --------------------------------------------------------------------------

export function clipLlm(env: Record<string, string | undefined> = process.env): { provider: LLMProvider; ctx: ProviderCallContext; name: string } {
  const which = (env.CLIP_LLM_PROVIDER || 'gemini').toLowerCase();
  if (which === 'claude' || which === 'anthropic') {
    const apiKey = env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY || '';
    if (!apiKey) throw new Error('CLIP_LLM_PROVIDER is "claude" but ANTHROPIC_API_KEY is not set in .env.local');
    return { provider: anthropicLlm, ctx: { apiKey, model: env.CLIP_CLAUDE_MODEL || 'claude-opus-5-5', options: {} }, name: 'Claude' };
  }
  const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY || '';
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set in .env.local');
  return { provider: geminiLlm, ctx: { apiKey, model: env.CLIP_GEMINI_MODEL || 'gemini-3.5-flash', options: {} }, name: 'Gemini' };
}

// --------------------------------------------------------------------------
// Timing helpers
// --------------------------------------------------------------------------

/** Quiet stretches with no dialogue, inside [start, end], at least `minSec` long. */
export function speechGaps(words: ClipWord[], start: number, end: number, minSec = 1): Array<{ start: number; end: number }> {
  const busy = words.filter((w) => w.end > start && w.start < end).map((w) => ({ start: w.start - 0.15, end: w.end + 0.15 }));
  busy.sort((a, b) => a.start - b.start);
  const gaps: Array<{ start: number; end: number }> = [];
  let cursor = start;
  for (const b of busy) {
    if (b.start - cursor >= minSec) gaps.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (end - cursor >= minSec) gaps.push({ start: cursor, end });
  return gaps.map((g) => ({ start: round(g.start), end: round(g.end) }));
}

const round = (n: number) => Math.round(n * 100) / 100;
const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Gaps a voice line may use: quiet, and never over the big moment itself. */
export function voiceGaps(words: ClipWord[], start: number, end: number, peakSec: number | null): Array<{ start: number; end: number }> {
  const gaps = speechGaps(words, start, end, 1);
  if (peakSec == null) return gaps;
  const blockStart = peakSec - 0.3;
  const blockEnd = peakSec + 1.5;
  return gaps
    .flatMap((g) => {
      if (g.end <= blockStart || g.start >= blockEnd) return [g];
      return [
        { start: g.start, end: Math.min(g.end, blockStart) },
        { start: Math.max(g.start, blockEnd), end: g.end },
      ];
    })
    .filter((g) => g.end - g.start >= 1)
    .map((g) => ({ start: round(g.start), end: round(g.end) }));
}

/**
 * Voice lines kept to the rules: at most three, each inside a quiet gap and short enough to finish
 * in it, none overlapping another. Lines that don't fit are dropped, not squeezed.
 */
export function fitVoiceLines(lines: Array<{ at: number; text: string; slot?: VoiceLine['slot'] }>, gaps: Array<{ start: number; end: number }>, max = 3): VoiceLine[] {
  const out: VoiceLine[] = [];
  let busyUntil = -Infinity;
  for (const line of [...lines].sort((a, b) => a.at - b.at)) {
    const text = line.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const gap = gaps.find((g) => line.at >= g.start - 0.01 && line.at < g.end) ?? gaps.find((g) => g.start > line.at && g.start - line.at <= 2);
    if (!gap) continue;
    const at = Math.max(line.at, gap.start + 0.1, busyUntil + 0.3);
    const allowed = Math.floor((gap.end - at - 0.2) * WORDS_PER_SEC);
    const words = wordCount(text);
    if (allowed < 2 || words > allowed + 1) continue;
    out.push({ at: round(at), text, slot: line.slot ?? 'other' });
    busyUntil = at + words / WORDS_PER_SEC;
    if (out.length >= max) break;
  }
  return out;
}

/** The part of the clip used: all of it when short, else a window under a minute around the big moment. */
export function chooseTrim(durationSec: number, suggested: { start?: number; end?: number }, peakSec: number | null, maxSec = DEFAULT_MAX_SHORT_SEC): { trimStart: number; trimEnd: number } {
  if (durationSec <= maxSec) return { trimStart: 0, trimEnd: round(durationSec) };
  let start = Math.max(0, suggested.start ?? 0);
  let end = Math.min(durationSec, suggested.end ?? start + maxSec);
  if (!(end > start + 3)) {
    start = peakSec != null ? Math.max(0, peakSec - maxSec * 0.6) : 0;
    end = Math.min(durationSec, start + maxSec);
  }
  if (end - start > maxSec) end = start + maxSec;
  if (peakSec != null && (peakSec < start || peakSec > end - 1)) {
    start = Math.max(0, Math.min(peakSec - maxSec * 0.6, durationSec - maxSec));
    end = Math.min(durationSec, start + maxSec);
  }
  return { trimStart: round(start), trimEnd: round(end) };
}

/** On-screen texts kept inside the Short, clear of the hook, readable but brief. */
export function fitOverlays(overlays: TextOverlay[], trimStart: number, trimEnd: number, hookUntil: number, max = 3): TextOverlay[] {
  const out: TextOverlay[] = [];
  for (const o of [...overlays].sort((a, b) => a.at - b.at)) {
    const text = o.text.replace(/\s+/g, ' ').trim().slice(0, 42);
    if (!text) continue;
    const at = Math.max(o.at, trimStart + hookUntil + 0.2, (out[out.length - 1]?.until ?? -Infinity) + 0.2);
    const until = Math.min(trimEnd - 0.2, Math.max(at + 0.8, Math.min(o.until, at + 3)));
    if (until - at < 0.6) continue;
    out.push({ at: round(at), until: round(until), text });
    if (out.length >= max) break;
  }
  return out;
}

// --------------------------------------------------------------------------
// The script
// --------------------------------------------------------------------------

const ScriptSchema = z.object({
  summary: z.string().describe('One sentence: what happens in the clip'),
  peakSec: z.number().describe('Seconds into the clip of the single biggest moment'),
  trimStart: z.number().describe('Where the Short should start (seconds into the clip)'),
  trimEnd: z.number().describe('Where the Short should end (seconds into the clip)'),
  layout: z.enum(['fit', 'crop']).describe('fit: keep the whole picture (action or HUD near the sides); crop: fill the screen with the centre'),
  hook: z.string().describe('On-screen hook for the first seconds, under 60 characters'),
  overlays: z.array(z.object({ at: z.number(), until: z.number(), text: z.string() })).describe('0-3 short on-screen texts, seconds into the clip'),
  voiceLines: z
    .array(z.object({ at: z.number(), text: z.string(), slot: z.enum(['hook', 'build', 'after', 'other']) }))
    .describe('0-3 voiceover lines, each placed inside a listed quiet gap'),
  titles: z.array(z.string()).describe('3-5 Shorts title options'),
  description: z.string().describe('1-2 sentence description, no hashtags, no credit line'),
  tags: z.array(z.string()).describe('8-15 tags, no # signs'),
});
export type ScriptDraft = z.infer<typeof ScriptSchema>;

const STYLE_GUIDE: Record<VoiceStyle, string> = {
  narrator: 'Storytelling narrator: sets the scene like a mini documentary ("Meanwhile in Leonida…"), dry and a little dramatic.',
  hype: 'Hype/meme reaction: short punchy reactions a viewer would shout ("NAH he did NOT just…"). No emojis in the voice lines.',
  info: 'Informative: points out what most players miss, a tip, or how the mechanic works. Calm and clear.',
};

export function buildScriptPrompt(project: ClipProject, analysis: ClipAnalysis, style: VoiceStyle, gaps: Array<{ start: number; end: number }>): string {
  const s = project.source;
  const dialogue = analysis.words.length
    ? groupLines(analysis.words).map((l) => `[${l.start.toFixed(1)}s] ${l.text}`).join('\n')
    : '(no dialogue: gameplay sound only)';
  const frames = analysis.frames.map((f, i) => `Image ${i + 1}: ${f.at.toFixed(1)}s`).join(', ');
  return `You write the packaging for a YouTube Short made from a GTA (Grand Theft Auto) gameplay clip.

CLIP
- Length: ${analysis.durationSec.toFixed(1)}s, ${analysis.width}x${analysis.height}
- Posted on ${s?.platform ?? 'unknown'} by ${project.creator || s?.uploaderHandle || s?.uploader || 'unknown'}
- Post text: ${(s?.postText || s?.title || '(none)').slice(0, 600)}
- The editor's note about the moment: ${project.note || '(none)'}

STILLS (attached, in order): ${frames || '(none)'}

LOUD MOMENTS (seconds, strongest first): ${analysis.peaks.map((p) => p.at.toFixed(1)).join(', ') || '(none found)'}

IN-GAME DIALOGUE (Whisper; may contain mistakes):
${dialogue}

QUIET GAPS where a voiceover may go (seconds): ${gaps.map((g) => `${g.start.toFixed(1)}-${g.end.toFixed(1)} (max ${Math.floor((g.end - g.start - 0.3) * 2.5)} words)`).join(', ') || '(none)'}

VOICE STYLE: ${STYLE_GUIDE[style]}

RULES
- Only describe what the stills, dialogue and post show. Never invent events, names or claims.
- peakSec: the single biggest moment (usually one of the loud moments).
- trimStart/trimEnd: the best part of the clip, at most ${DEFAULT_MAX_SHORT_SEC}s, ending shortly after the payoff. If the clip is already under ${DEFAULT_MAX_SHORT_SEC}s use 0 and its full length.
- hook: makes a scroller stop in the first 2 seconds without spoiling the payoff. Under 60 characters. One emoji at most.
- overlays: 0-3 tiny texts like "wait for it…" before the peak or a reaction right after. Each 1-3 seconds, under 40 characters. Never during the first 2.5 seconds (the hook is there).
- voiceLines: 0-3 lines, usually just 1 or 2. Each MUST start inside a quiet gap and fit that gap's word limit. Never over the big moment itself: let it play with its own sound. A "hook" line goes at the start, "build" just before the peak, "after" right after it.
- titles: 3-5 options, under 70 characters, curiosity without lying; mention GTA 6 only if the clip is clearly GTA 6.
- tags: lowercase search phrases (e.g. "gta 6", "gta 6 funny moments").`;
}

/** Dialogue words grouped into lines at pauses, for the prompt. */
function groupLines(words: ClipWord[]): Array<{ start: number; text: string }> {
  const lines: Array<{ start: number; text: string; end: number }> = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last && w.start - last.end < 0.8) {
      last.text += ` ${w.word}`;
      last.end = w.end;
    } else lines.push({ start: w.start, text: w.word, end: w.end });
  }
  return lines;
}

async function loadImages(dir: string, frames: ClipAnalysis['frames']): Promise<LlmImage[]> {
  const out: LlmImage[] = [];
  for (const f of frames) {
    const data = await fs.readFile(path.join(dir, f.file)).catch(() => null);
    if (data) out.push({ mimeType: 'image/jpeg', data: data.toString('base64') });
  }
  return out;
}

export const defaultTags = ['gta', 'gta 6', 'gta 6 gameplay', 'gta 6 funny moments', 'gta shorts', 'gaming'];

/** The editable plan from the writer's draft, with every rule enforced. */
export function planFromDraft(draft: ScriptDraft | null, project: ClipProject, analysis: ClipAnalysis, previous?: ClipPlan): ClipPlan {
  const style = previous?.voiceStyle ?? 'hype';
  const vertical = analysis.height > analysis.width * 1.2;
  const peakSec = clampPeak(draft?.peakSec ?? analysis.peaks[0]?.at ?? null, analysis.durationSec);
  const { trimStart, trimEnd } = chooseTrim(analysis.durationSec, { start: draft?.trimStart, end: draft?.trimEnd }, peakSec);
  const hookSec = 2.5;
  const gaps = voiceGaps(analysis.words, trimStart, trimEnd, peakSec);
  const layout: ClipLayout = vertical ? 'original' : draft?.layout === 'crop' ? 'crop' : 'fit';
  const fallbackTitle = (project.note || project.source?.title || 'This GTA moment').slice(0, 70);
  return {
    hook: (draft?.hook || project.note || 'Wait for it…').trim().slice(0, 70),
    hookSec,
    overlays: fitOverlays(draft?.overlays ?? [], trimStart, trimEnd, hookSec),
    voiceLines: fitVoiceLines(draft?.voiceLines ?? [], gaps),
    titles: (draft?.titles?.length ? draft.titles : [fallbackTitle]).map((t) => t.trim().slice(0, 100)).filter(Boolean).slice(0, 5),
    description: (draft?.description || project.note || '').trim(),
    tags: [...new Set((draft?.tags?.length ? draft.tags : defaultTags).map((t) => t.replace(/^#/, '').trim().toLowerCase()).filter(Boolean))].slice(0, 15),
    peakSec,
    layout: previous?.layout && previous.layout !== 'original' && !vertical ? previous.layout : layout,
    trimStart,
    trimEnd,
    captions: previous?.captions ?? analysis.words.length > 0,
    cleanCaptions: previous?.cleanCaptions ?? true,
    showHook: previous?.showHook ?? true,
    voiceover: previous?.voiceover ?? true,
    muteMusic: previous?.muteMusic ?? false,
    zoomOnPeak: previous?.zoomOnPeak ?? peakSec != null,
    sfxOnPeak: previous?.sfxOnPeak ?? false,
    voiceStyle: style,
    voice: previous?.voice ?? '',
  };
}

function clampPeak(peak: number | null, durationSec: number): number | null {
  if (peak == null || !Number.isFinite(peak)) return null;
  return round(Math.min(Math.max(0, peak), Math.max(0, durationSec - 0.5)));
}

/**
 * Writes the hook, on-screen texts, voice lines, titles and tags. If the model can't be reached
 * the clip still gets a plain plan (hook from the note, no voiceover) and a warning.
 */
export async function writeScript(dir: string, project: ClipProject, analysis: ClipAnalysis, previous?: ClipPlan): Promise<{ plan: ClipPlan; warnings: string[] }> {
  const style = previous?.voiceStyle ?? 'hype';
  // The writer sees the gaps of the whole clip (it may move the window); the rules re-check them
  const gaps = voiceGaps(analysis.words, 0, analysis.durationSec, analysis.peaks[0]?.at ?? null);
  try {
    const { provider, ctx, name } = clipLlm();
    const images = provider.supportsVision ? await loadImages(dir, analysis.frames) : [];
    const { data } = await provider.generateJson({ prompt: buildScriptPrompt(project, analysis, style, gaps), schema: ScriptSchema, images, maxTokens: 12000 }, ctx);
    const plan = planFromDraft(data, project, analysis, previous);
    const warnings = images.length ? [] : [`${name} could not look at the stills, so the script is based on the dialogue and post text only.`];
    return { plan, warnings };
  } catch (err) {
    return {
      plan: planFromDraft(null, project, analysis, previous),
      warnings: [`The script writer failed, so a plain plan was used (no voiceover): ${err instanceof Error ? err.message.slice(0, 200) : err}`],
    };
  }
}
