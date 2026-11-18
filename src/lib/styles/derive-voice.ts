import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '@/pipeline/providers/registry';
import type { LLMProvider, ProviderCallContext } from '@/pipeline/providers/types';
import { withWritingModel } from '@/lib/script/generate-script';
import { allFormats, allNiches, type StyleLibrary } from './compose';

/**
 * "Derive a voice from your scripts": the creator pastes a few scripts they wrote, and the writer
 * describes how they write (rhythm, phrasing, humour, habits) as instructions the script writer
 * can follow, plus the format and niche those scripts are closest to. Nothing is saved here: the
 * creator reviews and names the voice first.
 */

export const MIN_SCRIPTS = 1;
export const MAX_SCRIPTS = 5;
/** Per script, so a long script can't crowd out the others. */
const MAX_SCRIPT_CHARS = 12000;
const MIN_TOTAL_WORDS = 150;

export interface DerivedVoice {
  name: string;
  description: string;
  /** Format and niche ids the scripts are closest to. */
  format: string;
  niche: string;
  /** Why those, in a sentence. */
  reasoning: string;
}

const DerivedSchema = z.object({
  name: z.string(),
  description: z.string(),
  format: z.string(),
  niche: z.string(),
  reasoning: z.string(),
});

/** The scripts to learn from: trimmed, non-empty, at most MAX_SCRIPTS. Throws when there isn't enough to learn from. */
export function cleanScripts(raw: unknown): string[] {
  const scripts = (Array.isArray(raw) ? raw : [])
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.replace(/\r\n/g, '\n').trim().slice(0, MAX_SCRIPT_CHARS))
    .filter(Boolean)
    .slice(0, MAX_SCRIPTS);
  const words = scripts.join(' ').split(/\s+/).filter(Boolean).length;
  if (scripts.length < MIN_SCRIPTS || words < MIN_TOTAL_WORDS) {
    throw new Error(`Paste at least ${MIN_TOTAL_WORDS} words of your own scripts (1 to ${MAX_SCRIPTS} scripts) so there's enough to learn from.`);
  }
  return scripts;
}

export function buildDerivePrompt(scripts: string[], library: StyleLibrary): string {
  const formats = allFormats(library).map((f) => `- ${f.id}: ${f.name}: ${f.description}`).join('\n');
  const niches = allNiches(library).map((n) => `- ${n.id}: ${n.name}: ${n.description}`).join('\n');
  const body = scripts.map((s, i) => `SCRIPT ${i + 1}:\n"""\n${s}\n"""`).join('\n\n');
  return `A YouTube creator wrote these narration scripts. Study HOW they write, not what the videos are about.

${body}

Write:
- description: instructions a script writer can follow to sound like this creator, 80-200 words, as short imperative lines ("Open with...", "Use...", "Never..."). Cover: sentence length and rhythm, how they open and close, how they talk to the viewer (you/we, questions, asides), humour, recurring phrases or signature moves (quote them exactly), vocabulary level, and anything they clearly avoid. Describe habits only: no topics, facts or names from the scripts.
- name: a short name for this voice (2-4 words).
- format: the id of the format these scripts are closest to, from:
${formats}
- niche: the id of the niche these scripts are closest to, from:
${niches}
- reasoning: one sentence on why that format and niche.`;
}

export function normalizeDerived(raw: z.infer<typeof DerivedSchema>, library: StyleLibrary): DerivedVoice {
  const formats = allFormats(library).map((f) => f.id);
  const niches = allNiches(library).map((n) => n.id);
  const description = raw.description.replace(/\r\n/g, '\n').trim().slice(0, 3000);
  if (description.length < 20) throw new Error('The writer could not describe a voice from these scripts; try pasting more.');
  return {
    name: raw.name.replace(/\s+/g, ' ').replace(/^["“']+|["”']+$/g, '').trim().slice(0, 60) || 'My voice',
    description,
    format: formats.includes(raw.format.trim()) ? raw.format.trim() : 'explainer',
    niche: niches.includes(raw.niche.trim()) ? raw.niche.trim() : 'general',
    reasoning: raw.reasoning.trim().slice(0, 400),
  };
}

export async function deriveVoiceWith(llm: LLMProvider, ctx: ProviderCallContext, scripts: string[], library: StyleLibrary): Promise<DerivedVoice> {
  const { data } = await llm.generateJson(
    {
      system: 'You are a script editor with a sharp ear for how individual writers sound.',
      prompt: buildDerivePrompt(scripts, library),
      schema: DerivedSchema,
    },
    ctx,
  );
  return normalizeDerived(data, library);
}

export async function deriveVoice(supabase: SupabaseClient, rawScripts: unknown, library: StyleLibrary): Promise<DerivedVoice> {
  const scripts = cleanScripts(rawScripts);
  const resolved = await resolveForStage<LLMProvider>('script', supabase);
  return deriveVoiceWith(resolved.provider, withWritingModel(resolved.ctx, resolved.options), scripts, library);
}
