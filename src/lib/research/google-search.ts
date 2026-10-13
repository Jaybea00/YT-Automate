import { GoogleGenerativeAI, type Tool } from '@google/generative-ai';
import type { ResearchFact, ResearchSource } from './types';

export interface GroundingMetadataLike {
  groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
  groundingSupports?: Array<{
    segment?: { text?: string };
    groundingChunkIndices?: number[];
  }>;
}

/**
 * Turns a search-grounded answer written as "F1: ..." lines into facts with sources.
 * Gemini reports which text segments each search result supports; a fact keeps the
 * sources of every segment it contains. Facts no search result supports are dropped.
 */
export function parseGroundedFacts(
  text: string,
  metadata: GroundingMetadataLike | undefined,
): { facts: ResearchFact[]; sources: ResearchSource[] } {
  const chunks = metadata?.groundingChunks ?? [];
  const supports = metadata?.groundingSupports ?? [];

  const sources: ResearchSource[] = [];
  const sourceIdByChunk = new Map<number, string>();
  chunks.forEach((chunk, i) => {
    const url = chunk.web?.uri;
    if (!url) return;
    const existing = sources.find((s) => s.url === url);
    const id = existing?.id ?? `S${sources.length + 1}`;
    if (!existing) sources.push({ id, title: chunk.web?.title || url, url });
    sourceIdByChunk.set(i, id);
  });

  const facts: ResearchFact[] = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*\**F\d+\**\s*[:.)-]\s*(.+)$/);
    if (!match) continue;
    const claim = match[1].trim();
    const sourceIds = new Set<string>();
    for (const support of supports) {
      const segment = support.segment?.text?.trim();
      if (!segment || !(claim.includes(segment) || segment.includes(claim))) continue;
      for (const idx of support.groundingChunkIndices ?? []) {
        const id = sourceIdByChunk.get(idx);
        if (id) sourceIds.add(id);
      }
    }
    if (sourceIds.size > 0) {
      facts.push({ id: `F${facts.length + 1}`, claim, sourceIds: [...sourceIds] });
    }
  }

  // Only keep sources at least one fact cites
  const cited = new Set(facts.flatMap((f) => f.sourceIds));
  return { facts, sources: sources.filter((s) => cited.has(s.id)) };
}

export async function researchWithGoogleSearch(
  apiKey: string,
  model: string,
  topic: string,
): Promise<{ facts: ResearchFact[]; sources: ResearchSource[] }> {
  const genAI = new GoogleGenerativeAI(apiKey);
  // The SDK only types the legacy googleSearchRetrieval tool; current models take googleSearch
  const searchModel = genAI.getGenerativeModel({ model, tools: [{ googleSearch: {} } as unknown as Tool] });

  const result = await searchModel.generateContent(
    `Research this YouTube video topic with Google Search: "${topic}".
List 25-40 verified facts, one per line, formatted exactly "F1: ...", "F2: ...".
Each fact must contain something specific: a number with its unit, a date, a named person or place, a quote with who said it, or a real newspaper headline with outlet and date.
Only include facts the search results support. No commentary before or after the list.`,
  );

  const candidate = result.response.candidates?.[0] as { groundingMetadata?: GroundingMetadataLike } | undefined;
  return parseGroundedFacts(result.response.text(), candidate?.groundingMetadata);
}
