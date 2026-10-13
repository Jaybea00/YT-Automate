const API = 'https://en.wikipedia.org/w/api.php';
// Wikimedia asks API clients to identify themselves
const HEADERS = { 'User-Agent': 'YT-Automation/1.0 (script research)' };
const MAX_ARTICLE_CHARS = 20000;
const MIN_ARTICLE_WORDS = 300;

export interface WikipediaArticle {
  title: string;
  url: string;
  text: string;
}

interface WikiResponse {
  query?: {
    search?: Array<{ title: string; wordcount: number; snippet?: string }>;
    pages?: Array<{ title: string; fullurl: string; extract?: string; missing?: boolean }>;
  };
}

async function getJson(params: Record<string, string>): Promise<WikiResponse> {
  const url = `${API}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    throw new Error(`Wikipedia API ${res.status} for ${params.action}`);
  }
  return (await res.json()) as WikiResponse;
}

export interface WikipediaCandidate {
  title: string;
  snippet: string;
}

/** Top search hits with a plain-text snippet, skipping disambiguation pages and stubs. */
export async function searchWikipediaCandidates(query: string, limit = 4): Promise<WikipediaCandidate[]> {
  const data = await getJson({ action: 'query', list: 'search', srsearch: query, srlimit: '8' });
  const results = data.query?.search ?? [];
  return results
    .filter((r) => !/\(disambiguation\)/i.test(r.title) && r.wordcount >= MIN_ARTICLE_WORDS)
    .slice(0, limit)
    .map((r) => ({
      title: r.title,
      snippet: (r.snippet ?? '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
    }));
}

/** Distinct candidates across several searches, in rank order (best hit of each query first). */
export async function gatherWikipediaCandidates(queries: string[]): Promise<WikipediaCandidate[]> {
  const perQuery = await Promise.all(
    queries.map((q) => searchWikipediaCandidates(q).catch(() => [] as WikipediaCandidate[])),
  );
  const seen = new Set<string>();
  const merged: WikipediaCandidate[] = [];
  for (let rank = 0; rank < 4; rank++) {
    for (const list of perQuery) {
      const c = list[rank];
      if (c && !seen.has(c.title)) {
        seen.add(c.title);
        merged.push(c);
      }
    }
  }
  return merged;
}

/** Plain-text article body (truncated) and its canonical URL. */
export async function fetchWikipediaArticle(title: string): Promise<WikipediaArticle | null> {
  const data = await getJson({
    action: 'query',
    prop: 'extracts|info',
    inprop: 'url',
    explaintext: '1',
    redirects: '1',
    titles: title,
  });
  const page = data.query?.pages?.[0];
  if (!page || page.missing || !page.extract) return null;

  // Reference-style tail sections add noise without facts
  const body = String(page.extract).split(/\n==\s*(See also|References|Notes|Further reading|External links)\s*==/)[0];
  return {
    title: page.title,
    url: page.fullurl,
    text: body.slice(0, MAX_ARTICLE_CHARS),
  };
}

export async function fetchWikipediaArticles(titles: string[]): Promise<WikipediaArticle[]> {
  const articles = await Promise.all(titles.map((t) => fetchWikipediaArticle(t).catch(() => null)));
  return articles.filter((a): a is WikipediaArticle => a !== null);
}
