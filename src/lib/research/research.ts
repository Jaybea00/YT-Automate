import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveForStage } from '@/pipeline/providers/registry';
import type { LLMProvider, ProviderCallContext } from '@/pipeline/providers/types';
import { researchWithGoogleSearch } from './google-search';
import {
  fetchWikipediaArticles,
  gatherWikipediaCandidates,
  type WikipediaArticle,
  type WikipediaCandidate,
} from './wikipedia';
import type { ResearchDossier, ResearchFact, ResearchSource } from './types';

const MIN_FACTS = 8;
const MAX_FACTS = 40;

const QueriesSchema = z.object({ queries: z.array(z.string()) });
const ExtractedFactsSchema = z.object({
  facts: z.array(z.object({ claim: z.string(), source_id: z.string() })),
});

export async function planWikipediaQueries(
  llm: LLMProvider,
  ctx: ProviderCallContext,
  topic: string,
): Promise<string[]> {
  try {
    const { data } = await llm.generateJson(
      {
        system: 'You plan encyclopedia research for documentary scripts.',
        prompt: `Topic: "${topic}"
Give 4-5 Wikipedia search queries that together cover every part of this topic: the main subject, its background or causes, its consequences, and each place, person, or organization the topic names.
Write each query the way a Wikipedia article title is written (e.g. "Great Depression in the United Kingdom", "Black Tuesday", "Smoot-Hawley Tariff Act"), not as a question or phrase. Return {"queries": [...]}.`,
        schema: QueriesSchema,
      },
      ctx,
    );
    const queries = data.queries.map((q) => q.trim()).filter(Boolean).slice(0, 5);
    return queries.length > 0 ? queries : [topic];
  } catch {
    return [topic];
  }
}

const SelectedTitlesSchema = z.object({ titles: z.array(z.string()) });

/** Picks the most useful articles from search candidates; falls back to search rank order. */
export async function selectArticles(
  llm: LLMProvider,
  ctx: ProviderCallContext,
  topic: string,
  candidates: WikipediaCandidate[],
  maxArticles = 5,
): Promise<string[]> {
  const fallback = candidates.slice(0, maxArticles).map((c) => c.title);
  if (candidates.length <= maxArticles) return fallback;
  try {
    const { data } = await llm.generateJson(
      {
        system: 'You choose sources for documentary research.',
        prompt: `Topic of the video: "${topic}"
Choose up to ${maxArticles} Wikipedia articles that together give the best factual material for this topic, covering all of its parts. Skip articles about books, films, songs, buildings, or unrelated later events. Return {"titles": [...]} using titles exactly as listed.

${candidates.map((c) => `- ${c.title}: ${c.snippet}`).join('\n')}`,
        schema: SelectedTitlesSchema,
      },
      ctx,
    );
    const valid = new Set(candidates.map((c) => c.title));
    const chosen = data.titles.filter((t) => valid.has(t)).slice(0, maxArticles);
    return chosen.length > 0 ? chosen : fallback;
  } catch {
    return fallback;
  }
}

export async function extractFactsFromArticles(
  llm: LLMProvider,
  ctx: ProviderCallContext,
  topic: string,
  articles: WikipediaArticle[],
): Promise<{ facts: ResearchFact[]; sources: ResearchSource[] }> {
  const sources: ResearchSource[] = articles.map((a, i) => ({ id: `S${i + 1}`, title: a.title, url: a.url }));
  const corpus = articles.map((a, i) => `[S${i + 1}] ${a.title}\n${a.text}`).join('\n\n---\n\n');

  const { data } = await llm.generateJson(
    {
      system: 'You are a meticulous fact-checker. You only report facts that are explicitly stated in the provided sources.',
      prompt: `Topic of the video: "${topic}"

Extract 25-${MAX_FACTS} specific, verifiable facts for this video from the sources below. Each fact must be explicitly stated in its source and contain something concrete: a number with its unit, a date, a named person, place, or organization, a quote with who said it, or a newspaper headline with outlet and date.
Only include facts that belong in THIS video's story: skip unrelated history, later events, and background that a script on this topic would never mention. Cover every part of the topic.
Write each fact as one self-contained sentence. Set source_id to the [S#] the fact comes from. Prefer facts a storyteller could use: turning points, surprising numbers, vivid details, consequences.

SOURCES:
${corpus}`,
      schema: ExtractedFactsSchema,
    },
    ctx,
  );

  const validIds = new Set(sources.map((s) => s.id));
  const facts = data.facts
    .filter((f) => f.claim.trim() && validIds.has(f.source_id.trim()))
    .slice(0, MAX_FACTS)
    .map((f, i) => ({ id: `F${i + 1}`, claim: f.claim.trim(), sourceIds: [f.source_id.trim()] }));

  const cited = new Set(facts.flatMap((f) => f.sourceIds));
  return { facts, sources: sources.filter((s) => cited.has(s.id)) };
}

/**
 * Builds a fact dossier for a topic before the script is written.
 * Uses Google Search grounding when the script provider is Gemini and the key allows it,
 * otherwise Wikipedia. Never throws: if research fails the script is written without it.
 */
export async function researchTopic(
  supabase: SupabaseClient,
  topic: string,
): Promise<ResearchDossier | null> {
  try {
    const resolved = await resolveForStage<LLMProvider>('script', supabase);
    const { provider: llm, ctx } = resolved;
    const createdAt = new Date().toISOString();

    if (resolved.providerId === 'gemini' && ctx.apiKey) {
      try {
        const grounded = await researchWithGoogleSearch(ctx.apiKey, ctx.model || 'gemini-3.5-flash-lite', topic);
        if (grounded.facts.length >= MIN_FACTS) {
          return { topic, provider: 'google_search', createdAt, ...grounded };
        }
        console.warn(`[research] Google Search returned only ${grounded.facts.length} sourced facts; using Wikipedia.`);
      } catch (err) {
        console.warn(
          `[research] Google Search grounding unavailable (${err instanceof Error ? err.message.slice(0, 160) : err}); using Wikipedia.`,
        );
      }
    }

    const queries = await planWikipediaQueries(llm, ctx, topic);
    const candidates = await gatherWikipediaCandidates(queries);
    const articles = await fetchWikipediaArticles(await selectArticles(llm, ctx, topic, candidates));
    console.log(`[research] Wikipedia queries: ${queries.join(' | ')} -> ${articles.map((a) => a.title).join(', ')}`);
    if (articles.length === 0) {
      console.warn(`[research] No Wikipedia articles found for "${topic}" (queries: ${queries.join(' | ')}).`);
      return null;
    }

    const { facts, sources } = await extractFactsFromArticles(llm, ctx, topic, articles);
    if (facts.length === 0) return null;

    console.log(
      `[research] Wikipedia dossier: ${facts.length} facts from ${sources.map((s) => s.title).join(', ')}`,
    );
    return { topic, provider: 'wikipedia', createdAt, sources, facts };
  } catch (err) {
    console.warn('[research] Research failed; the script will be written without a dossier:', err);
    return null;
  }
}
