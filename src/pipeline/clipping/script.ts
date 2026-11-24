import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { channelPromptBlock, type ChannelProfile } from '@/lib/channel/profile';
import { geminiLlm } from '../providers/llm/gemini';
import { anthropicLlm } from '../providers/llm/anthropic';
import type { LLMProvider, LlmImage, ProviderCallContext } from '../providers/types';
import { fitCutIns, fitEffects, fitEnding, fitHeader, fitPoint } from './reaction';
import {
  DEFAULT_MAX_SHORT_SEC,
  WORDS_PER_SEC,
  type ClipAnalysis,
  type ClipLayout,
  type ClipPlan,
  type ClipProject,
  type ClipWord,
  type EditStyle,
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
  return { provider: geminiLlm, ctx: { apiKey, model: env.CLIP_GEMINI_MODEL || 'gemini-4-hydrogen', options: {} }, name: 'Gemini' };
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
  header: z.object({ text: z.string(), highlight: z.array(z.string()) }).optional().describe('Reaction edit: the white box above the clip'),
  memes: z.array(z.object({ at: z.number(), query: z.string() })).optional().describe('Reaction edit: 0-2 meme cut-ins'),
  freezeAt: z.number().nullable().optional().describe('Reaction edit: freeze-frame point, or null'),
  replay: z.boolean().optional().describe('Reaction edit: slow-motion replay of the big moment'),
  effects: z
    .array(z.object({ at: z.number(), kind: z.enum(['flash', 'shake', 'emoji', 'sound', 'comic']), emoji: z.string().optional(), query: z.string().optional() }))
    .optional()
    .describe('Reaction edit: extra hits, emoji pop-ups and meme sounds'),
  freezeFocus: z.object({ x: z.number(), y: z.number() }).nullable().optional().describe('Reaction edit: what the freeze circles, as fractions of the picture'),
  ramp: z.boolean().optional().describe('Reaction edit: slow down into the big moment'),
  zoomFocus: z.object({ x: z.number(), y: z.number() }).nullable().optional().describe('Reaction edit: where the zoom on the big moment aims'),
  ending: z
    .object({ style: z.enum(['none', 'tbc', 'credits', 'stamp', 'skull', 'recap']), text: z.string().optional(), sound: z.string().optional(), emoji: z.string().optional() })
    .optional()
    .describe('Reaction edit: how it ends'),
  skullAt: z.number().nullable().optional().describe('Reaction edit: a skull hit just after the payoff, or null'),
  skullEmoji: z.string().optional().describe('Reaction edit: the skull hit picture'),
  skips: z.array(z.object({ from: z.number(), to: z.number() })).optional().describe('Reaction edit: slow stretches to cut out'),
  teaser: z.boolean().optional().describe('Reaction edit: open on the big moment, then rewind to the start'),
  loop: z.boolean().optional().describe('Reaction edit: blend the end into the start'),
});
export type ScriptDraft = z.infer<typeof ScriptSchema>;

const STYLE_GUIDE: Record<VoiceStyle, string> = {
  narrator: 'Storytelling narrator: sets the scene like a mini documentary ("Meanwhile in Leonida…"), dry and a little dramatic.',
  hype: 'Hype/meme reaction: short punchy reactions a viewer would shout ("NAH he did NOT just…"). No emojis in the voice lines.',
  info: 'Informative: points out what most players miss, a tip, or how the mechanic works. Calm and clear.',
};

/** New clips get the reaction edit; clips made before it keep the classic one. */
export const editStyleFor = (previous?: ClipPlan): EditStyle => (previous ? (previous.editStyle ?? 'classic') : 'reaction');

const REACTION_RULES = `
REACTION EDIT (this Short uses it: fill these too)
- header: the white box above the clip, on screen the whole time, so the first frame already tells the story. A reaction or claim in viewer slang, 4-12 words, ending in 1-2 emoji (😭 ✌️ 💀 🥀 🫩). E.g. "NPCs in GTA 6 have ZERO chill 😭✌️", "bro really thought he had it 💀". highlight: 1-2 words from it shown in red.
- memes: 0-2 meme cut-ins of about 1.4 s, played between moments of the clip (nothing is hidden). Put them right AFTER a payoff or a fail, never during the build-up. query: the meme as people search it on GIPHY ("its working", "shocked guy", "bro got me", "this is peak", "awkward look", "mission failed").
- freezeAt: optional freeze-frame just BEFORE the big moment, with a voiceLine at exactly that time ("wait… look at the guy on the left"); the game pauses while it's spoken, so it needs no quiet gap (max 12 words). null for none.
- replay: true to replay the big moment in slow motion right after it (only when the moment is fast and worth a second look).
- freezeFocus: the spot the freeze circles (with an arrow), as x/y fractions of the picture (0,0 top-left; 1,1 bottom-right), read from the stills. Null when nothing needs pointing at.
- ramp: true to slow down into the big moment (the last 0.8 s before it plays at half speed, deep sound): for impacts, crashes, jump scares.
- zoomFocus: x/y fractions of where the zoom on the big moment should aim (a face, the impact); null for the centre.
- effects: 0-6, seconds into the clip. kind "flash" or "shake" on other impacts (the big moment gets both automatically); kind "emoji" with emoji (one of 💀 😭 🤣 😳 🔥 🫡 🤡) on a reaction moment; kind "sound" with query, a meme sound as people name it ("vine boom", "bruh", "metal pipe", "huh", "spongebob fail", "wrong answer", "bonk", "rizz") on a fail, a stare or a punchline; kind "comic" for a black-and-white comic-dot flash on a hard hit. Never more than one thing every 1.5 s. An emoji can be typed (💀) or named from the emoji library ("skull exploding", "blue guy holding laugh", "side eye", "sigma").
- skullAt: the trollface-style skull hit (the frame freezes grey and dark, a big skull lands on a bass hit) right after a fail or a "gotcha" payoff; null for none. skullEmoji: optional picture name ("skull dead", "skull exploding").
- ending: style "tbc" (freeze in sepia with a "TO BE CONTINUED" arrow banner: for cliffhangers, someone about to get wrecked), "credits" (cut to black with credit lines, text like "Directed by\nJASON": for an awkward fail), "stamp" (black-and-white freeze with a red stamp, text 1-3 words like "SKILL ISSUE", "NOT CANON", "L": for a fail), "skull" (grey, dark freeze with a big skull on a bass hit: for a fail or a trap; pair with skullAt for the double skull), "recap" (the best moments flash past in quick cuts, landing on the big one: for action and chaos), or "none". sound: what to play (defaults fit each style). emoji: the skull ending's picture.
- loop: true (with ending "none") when the last moment flows back into the first, so the replay feels seamless.
- skips: 0-2 slow stretches to cut out of the middle (seconds into the clip: from, to): plain driving, walking, waiting, where nothing happens and nobody speaks. Never the big moment or the 1.5 s before it.
- teaser: true when the start is slow (walking up, driving, setting up) and the big moment is a strong picture: the Short opens on it for under 2 s, then rewinds to the start.
- Aim for a 15-35 s Short with the payoff before 60% of the way in; cut the slow start.`;

export function buildScriptPrompt(project: ClipProject, analysis: ClipAnalysis, style: VoiceStyle, gaps: Array<{ start: number; end: number }>, channel?: ChannelProfile, editStyle: EditStyle = 'classic'): string {
  const s = project.source;
  const dialogue = analysis.words.length
    ? groupLines(analysis.words).map((l) => `[${l.start.toFixed(1)}s] ${l.text}`).join('\n')
    : '(no dialogue: gameplay sound only)';
  const frames = analysis.frames.map((f, i) => `Image ${i + 1}: ${f.at.toFixed(1)}s`).join(', ');
  return `You write the packaging for a YouTube Short made from a GTA (Grand Theft Auto) gameplay clip.
${channel ? `\n${channelPromptBlock(channel)}\n` : ''}
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

VOICE STYLE: ${STYLE_GUIDE[style]}${channel?.tone ? ` In the channel's voice: ${channel.tone}` : ''}

RULES
- Only describe what the stills, dialogue and post show. Never invent events, names or claims.
- peakSec: the single biggest moment (usually one of the loud moments).
- trimStart/trimEnd: the best part of the clip, at most ${DEFAULT_MAX_SHORT_SEC}s, ending shortly after the payoff. If the clip is already under ${DEFAULT_MAX_SHORT_SEC}s use 0 and its full length.
- hook: makes a scroller stop in the first 2 seconds without spoiling the payoff. Under 60 characters. One emoji at most.
- overlays: 0-3 tiny texts like "wait for it…" before the peak or a reaction right after. Each 1-3 seconds, under 40 characters. Never during the first 2.5 seconds (the hook is there).
- voiceLines: 0-3 lines, usually just 1 or 2. Each MUST start inside a quiet gap and fit that gap's word limit. Never over the big moment itself: let it play with its own sound. A "hook" line goes at the start, "build" just before the peak, "after" right after it.
- titles: 3-5 options, under 70 characters, curiosity without lying; mention GTA 6 only if the clip is clearly GTA 6.
- tags: lowercase search phrases (e.g. "gta 6", "gta 6 funny moments").${editStyle === 'reaction' ? REACTION_RULES : ''}`;
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
export function planFromDraft(draft: ScriptDraft | null, project: ClipProject, analysis: ClipAnalysis, previous?: ClipPlan, channel?: ChannelProfile): ClipPlan {
  const style = previous?.voiceStyle ?? channel?.defaultVoiceStyle ?? 'hype';
  const vertical = analysis.height > analysis.width * 1.2;
  const peakSec = clampPeak(draft?.peakSec ?? analysis.peaks[0]?.at ?? null, analysis.durationSec);
  const { trimStart, trimEnd } = chooseTrim(analysis.durationSec, { start: draft?.trimStart, end: draft?.trimEnd }, peakSec);
  const hookSec = 2.5;
  const gaps = voiceGaps(analysis.words, trimStart, trimEnd, peakSec);
  const layout: ClipLayout = vertical ? 'original' : draft?.layout === 'crop' ? 'crop' : 'fit';
  const editStyle = editStyleFor(previous);
  const reaction = editStyle === 'reaction';
  const hook = (draft?.hook || project.note || 'Wait for it…').trim().slice(0, 70);
  // A voice line on the freeze is spoken while the game is paused, so it skips the quiet-gap rules
  const freezeAt = reaction ? (draft?.freezeAt ?? null) : null;
  const cutIns = reaction
    ? fitCutIns({ memes: draft?.memes, freezeAt, freezeFocus: draft?.freezeFocus, replay: draft?.replay, ramp: draft?.ramp, skullAt: draft?.skullAt, skullEmoji: draft?.skullEmoji, skips: draft?.skips, teaser: draft?.teaser }, trimStart, trimEnd, peakSec)
    : [];
  const ending = reaction ? fitEnding(draft?.ending ? { style: draft.ending.style, text: draft.ending.text, query: draft.ending.sound, emoji: draft.ending.emoji } : null) : undefined;
  const zoomFocus = reaction ? fitPoint(draft?.zoomFocus) : undefined;
  const freeze = cutIns.find((c) => c.kind === 'freeze');
  const freezeLine = freeze && freezeAt != null ? draft?.voiceLines.find((l) => Math.abs(l.at - freezeAt) <= 0.3 && wordCount(l.text) <= 14) : undefined;
  const gapLines = fitVoiceLines((draft?.voiceLines ?? []).filter((l) => l !== freezeLine), gaps, freezeLine ? 2 : 3);
  const voiceLines = freezeLine ? [...gapLines, { at: freeze!.at, text: freezeLine.text.replace(/s+/g, ' ').trim(), slot: 'build' as const }].sort((a, b) => a.at - b.at) : gapLines;
  const fallbackTitle = (project.note || project.source?.title || 'This GTA moment').slice(0, 70);
  return {
    editStyle,
    ...(reaction
      ? {
          header: fitHeader(draft?.header, hook),
          cutIns,
          effects: fitEffects(draft?.effects ?? [], trimStart, trimEnd, peakSec),
          ...(zoomFocus ? { zoomFocus } : {}),
          ...(ending ? { ending } : {}),
          loop: !ending && !!draft?.loop,
          whipBlur: previous?.whipBlur ?? true,
          grade: previous?.grade ?? true,
          glowCaptions: previous?.glowCaptions ?? true,
        }
      : {}),
    hook,
    hookSec,
    overlays: fitOverlays(draft?.overlays ?? [], trimStart, trimEnd, hookSec),
    voiceLines,
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
    sfxOnPeak: previous?.sfxOnPeak ?? reaction,
    voiceStyle: style,
    voice: previous?.voice ?? channel?.voice ?? '',
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
export async function writeScript(dir: string, project: ClipProject, analysis: ClipAnalysis, previous?: ClipPlan, channel?: ChannelProfile): Promise<{ plan: ClipPlan; warnings: string[] }> {
  const style = previous?.voiceStyle ?? channel?.defaultVoiceStyle ?? 'hype';
  // The writer sees the gaps of the whole clip (it may move the window); the rules re-check them
  const gaps = voiceGaps(analysis.words, 0, analysis.durationSec, analysis.peaks[0]?.at ?? null);
  try {
    const { provider, ctx, name } = clipLlm();
    const images = provider.supportsVision ? await loadImages(dir, analysis.frames) : [];
    const { data } = await provider.generateJson({ prompt: buildScriptPrompt(project, analysis, style, gaps, channel, editStyleFor(previous)), schema: ScriptSchema, images, maxTokens: 12000 }, ctx);
    const plan = planFromDraft(data, project, analysis, previous, channel);
    const warnings = images.length ? [] : [`${name} could not look at the stills, so the script is based on the dialogue and post text only.`];
    return { plan, warnings };
  } catch (err) {
    return {
      plan: planFromDraft(null, project, analysis, previous, channel),
      warnings: [`The script writer failed, so a plain plan was used (no voiceover): ${err instanceof Error ? err.message.slice(0, 200) : err}`],
    };
  }
}
