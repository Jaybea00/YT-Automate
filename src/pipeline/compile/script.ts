import { z } from 'zod';
import { clipLlm } from '../clipping/script';
import type { Compilation } from './types';

const ScriptSchema = z.object({
  titles: z.array(z.string()).describe('3-5 title options'),
  description: z.string().describe('2-3 sentences, no hashtags, no credits'),
  tags: z.array(z.string()).describe('10-15 lowercase tags, no # signs'),
  hook: z.string().describe('On-screen hook for the first seconds, under 50 characters'),
  intro: z.string().describe('Voiceover for the opening card, under 30 words'),
  outro: z.string().describe('Voiceover for the closing card, under 20 words'),
  items: z.array(
    z.object({
      index: z.number(),
      label: z.string().describe('Name for the clip, 2-5 words'),
      line: z.string().describe('Voiceover introducing the clip, under 14 words, no spoilers'),
    }),
  ),
});
export type CompilationScript = z.infer<typeof ScriptSchema>;

export function buildCompilationPrompt(c: Pick<Compilation, 'format' | 'theme' | 'items'>): string {
  const n = c.items.length;
  const clips = c.items
    .map((it, i) => `CLIP ${i}${c.format === 'long' ? ` (shown as #${n - i})` : ''}: ${it.title}
  What happens: ${it.description || '(not described)'}
  Kind: ${it.recipe}. Streamer: ${it.creator || 'unknown'}.`)
    .join('\n');
  return `You write the packaging for a ${c.format === 'short' ? 'YouTube Short (under a minute) made of' : 'YouTube countdown video (8-15 minutes) made of'} ${n} GTA gameplay clips from different streamers.

THEME: ${c.theme}

${clips}

RULES
- Only describe what the clip descriptions say. Never invent events, names or numbers.
- titles: 3-5 options under 70 characters. Curiosity without lying. Mention GTA 6 only if the clips are clearly GTA 6.
- description: 2-3 sentences about the video. No hashtags and no credit lines (they are added for you).
- hook: on-screen text that makes a scroller stop, under 50 characters.
- intro: ${c.format === 'long' ? `spoken over the opening card: sets up the countdown ("These are the ${n} …"), under 30 words.` : 'leave short; it is not used in Shorts.'}
- outro: spoken over the closing card: a question for the comments and a reason to subscribe, under 20 words.
- items: one per clip, by index. label: 2-5 words naming the moment ("The bike bail"). line: ${c.format === 'long' ? `spoken before the clip on its number card, starting with the number ("Number ${n}: …"), under 14 words, without spoiling the payoff.` : 'one short reaction, under 10 words.'}`;
}

/** A plain script from the clips themselves, used when the model can't be reached. */
export function fallbackScript(c: Pick<Compilation, 'format' | 'theme' | 'items'>): CompilationScript {
  const n = c.items.length;
  const firstSentence = (s: string) => (s.split(/(?<=[.!?])\s/)[0] || s).split(/\s+/).slice(0, 12).join(' ');
  return {
    titles: [c.theme],
    description: `${c.theme}: ${n} clips from the community.`,
    tags: ['gta', 'gta 6', 'gta 6 moments', 'gta compilation', 'gaming'],
    hook: c.theme.slice(0, 50),
    intro: `These are the ${n} ${c.theme.toLowerCase()}.`,
    outro: 'Which one was your favourite? Subscribe for more.',
    items: c.items.map((it, i) => ({
      index: i,
      label: it.title.split(/\s+/).slice(0, 5).join(' '),
      line: c.format === 'long' ? `Number ${n - i}: ${firstSentence(it.description || it.title)}` : '',
    })),
  };
}

/** Writes titles, hook, intro/outro and a label and line per clip. Falls back to a plain script. */
export async function writeCompilationScript(c: Pick<Compilation, 'format' | 'theme' | 'items'>): Promise<{ script: CompilationScript; warning?: string }> {
  try {
    const { provider, ctx } = clipLlm();
    const { data } = await provider.generateJson({ prompt: buildCompilationPrompt(c), schema: ScriptSchema, maxTokens: 12000 }, ctx);
    const fallback = fallbackScript(c);
    // Any clip the model skipped keeps its plain label and line
    const items = c.items.map((_, i) => data.items.find((x) => x.index === i) ?? fallback.items[i]);
    return { script: { ...data, items, titles: data.titles.length ? data.titles : fallback.titles } };
  } catch (err) {
    return { script: fallbackScript(c), warning: `The script writer failed, so a plain script was used: ${err instanceof Error ? err.message.slice(0, 160) : err}` };
  }
}
