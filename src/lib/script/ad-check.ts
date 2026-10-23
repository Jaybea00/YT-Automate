import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '@/pipeline/providers/registry';
import type { LLMProvider } from '@/pipeline/providers/types';
import { STYLE_TEMPLATES } from './style-templates';
import { checkerContext } from './fact-check';
import {
  AD_CATEGORIES,
  findProfanity,
  type AdCategory,
  type AdCheckIssue,
  type AdCheckReport,
  type AdTitleIssue,
} from './ad-check-issues';
import type { ScriptBeat } from './generate-script';

export * from './ad-check-issues';

/**
 * Advertiser-friendly check: flags narration and titles likely to get limited ads under
 * YouTube's advertiser-friendly guidelines, with safer wording that keeps the story. Matters
 * most for True Crime, Mystery and History, where violence and tragedy are the subject.
 */

const BEATS_PER_CALL = 60;

const AdSchema = z.object({
  issues: z.array(
    z.object({
      beat_index: z.number(),
      category: z.string(),
      severity: z.string(),
      quote: z.string(),
      problem: z.string(),
      suggested_text: z.string().optional(),
    }),
  ),
  title_issues: z.array(z.object({ title: z.string(), problem: z.string(), suggestion: z.string().optional() })).optional(),
});

export function buildAdCheckPrompt(beats: ScriptBeat[], titles: string[], style?: string | null): string {
  const label = style ? (STYLE_TEMPLATES[style as keyof typeof STYLE_TEMPLATES]?.label ?? style) : null;
  return `Review this YouTube narration${label ? ` (a ${label} video)` : ''} against YouTube's advertiser-friendly content guidelines.
Flag only wording likely to get the video limited or no ads:
- language: strong profanity (worst in the opening seconds or used often; mild words like "damn" and "hell" are fine)
- violence: graphic, lingering description of injuries, killing or torture
- shocking: gore, bodily detail, remains, autopsy detail
- adult: sexual detail
- harmful_acts: detail that could help someone copy a dangerous act (methods of suicide or self-harm, weapon or explosive making)
- drugs: detailed drug use or how to get or make drugs
- firearms: detail on making or modifying weapons
- hateful: slurs or demeaning language about a group, even when quoting
- sensitive_events: a tragedy (mass death, terror attack, disaster) told graphically or sensationally
- controversial: abortion, abuse, suicide and similar told graphically rather than factually
Factual, non-graphic, educational storytelling about crime, war, death and tragedy is fine; don't flag it. Documentary context helps, but vivid detail still limits ads.
severity: "limited" when it would likely limit ads as written, "caution" when borderline.
For each issue: "quote" the words; "problem" in one sentence; "suggested_text" is the whole beat rewritten to be advertiser-friendly, keeping the facts, tension and voice (imply rather than describe: "he was found dead" rather than the injuries).
${titles.length ? `\nAlso check these title options; titles are judged strictly (shocking or graphic words, profanity, sensational tragedy). Put problems in "title_issues" with a safer "suggestion".\nTITLES:\n${titles.map((t) => `- ${t}`).join('\n')}\n` : ''}
NARRATION (beat index, text):
${beats.map((b) => `[${b.index}] ${b.text}`).join('\n')}

Return {"issues": [], "title_issues": []} when nothing is a problem.`;
}

export function normalizeAdIssues(raw: z.infer<typeof AdSchema>['issues'], beats: ScriptBeat[]): AdCheckIssue[] {
  const byIndex = new Map(beats.map((b) => [b.index, b]));
  const seen = new Set<string>();
  const issues: AdCheckIssue[] = [];
  for (const r of raw) {
    const beat = byIndex.get(r.beat_index);
    const category = r.category.trim().toLowerCase().replace(/[\s-]+/g, '_') as AdCategory;
    if (!beat || !AD_CATEGORIES.includes(category) || !r.problem.trim()) continue;
    const key = `${beat.index}|${category}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const suggestion = r.suggested_text?.trim();
    issues.push({
      id: `ad-${beat.index}-${category}`,
      beat_index: beat.index,
      category,
      severity: r.severity.trim().toLowerCase() === 'limited' ? 'limited' : 'caution',
      quote: r.quote.trim(),
      problem: r.problem.trim(),
      ...(suggestion && suggestion !== beat.text.trim() ? { suggested_text: suggestion } : {}),
      checked_text: beat.text,
    });
  }
  return issues;
}

/** The model's issues plus any swearing it missed; the opening-seconds rule comes from the local check. */
export function mergeWithProfanity(issues: AdCheckIssue[], beats: ScriptBeat[]): AdCheckIssue[] {
  const merged = [...issues];
  for (const local of findProfanity(beats)) {
    const existing = merged.findIndex((i) => i.beat_index === local.beat_index && i.category === 'language');
    if (existing === -1) merged.push(local);
    else if (local.severity === 'limited') merged[existing] = { ...merged[existing], severity: 'limited' };
  }
  return merged.sort((a, b) => a.beat_index - b.beat_index);
}

export async function adCheckScript(
  supabase: SupabaseClient,
  beats: ScriptBeat[],
  titles: string[] = [],
  style?: string | null,
): Promise<AdCheckReport> {
  const resolved = await resolveForStage<LLMProvider>('script', supabase);
  const ctx = checkerContext(resolved.ctx, resolved.options);
  const issues: AdCheckIssue[] = [];
  const titleIssues: AdTitleIssue[] = [];
  for (let start = 0; start < beats.length; start += BEATS_PER_CALL) {
    const chunk = beats.slice(start, start + BEATS_PER_CALL);
    const { data } = await resolved.provider.generateJson(
      {
        system: "You are a YouTube monetisation reviewer who knows the advertiser-friendly guidelines well. You keep creators' stories intact while protecting their ad revenue.",
        // Titles are checked once, with the first part
        prompt: buildAdCheckPrompt(chunk, start === 0 ? titles : [], style),
        schema: AdSchema,
      },
      ctx,
    );
    issues.push(...normalizeAdIssues(data.issues, chunk));
    if (start === 0) {
      const known = new Set(titles.map((t) => t.trim().toLowerCase()));
      for (const t of data.title_issues ?? []) {
        if (!known.has(t.title.trim().toLowerCase()) || !t.problem.trim()) continue;
        titleIssues.push({ title: t.title.trim(), problem: t.problem.trim(), ...(t.suggestion?.trim() ? { suggestion: t.suggestion.trim() } : {}) });
      }
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    ...(ctx.model ? { model: ctx.model } : {}),
    beatsChecked: beats.length,
    issues: mergeWithProfanity(issues, beats),
    titleIssues,
  };
}

/** The automatic check after a script is written: falls back to the built-in swearing check. */
export async function adCheckOrLocal(
  supabase: SupabaseClient,
  beats: ScriptBeat[],
  titles: string[],
  style?: string | null,
): Promise<AdCheckReport> {
  try {
    const report = await adCheckScript(supabase, beats, titles, style);
    console.log(`[adCheck] ${report.issues.length} beat issue(s), ${report.titleIssues.length} title issue(s)`);
    return report;
  } catch (err) {
    console.warn('[adCheck] Ad-friendly check failed; only swearing was checked:', err instanceof Error ? err.message.slice(0, 200) : err);
    return { checkedAt: new Date().toISOString(), beatsChecked: beats.length, issues: findProfanity(beats), titleIssues: [], localOnly: true };
  }
}
