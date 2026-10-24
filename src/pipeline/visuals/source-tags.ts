import type { ResearchDossier, ResearchSource } from '@/lib/research/types';
import type { ShotPlan } from '@/lib/script/generate-script';
import type { MotionTheme } from './motion/theme';
import { escapeHtml } from './motion/templates';

/**
 * On-screen source tags: a small "Source: UEFA" under stats and charts, from the research facts
 * the shot cites, so numbers on screen say where they come from.
 */

/** Shot types that show figures and get a tag when they cite a fact. */
export const SOURCE_TAGGED = new Set(['chart', 'stat', 'comparison', 'race_bars', 'money', 'spec_card', 'timeline', 'scale']);

/** Publishers whose names aren't their domains. */
const KNOWN: Record<string, string> = {
  wikipedia: 'Wikipedia',
  bbc: 'BBC',
  nytimes: 'The New York Times',
  wsj: 'The Wall Street Journal',
  ft: 'Financial Times',
  theguardian: 'The Guardian',
  guardian: 'The Guardian',
  washingtonpost: 'The Washington Post',
  economist: 'The Economist',
  bloomberg: 'Bloomberg',
  reuters: 'Reuters',
  apnews: 'AP',
  cnbc: 'CNBC',
  worldbank: 'World Bank',
  ourworldindata: 'Our World in Data',
  statista: 'Statista',
  transfermarkt: 'Transfermarkt',
  espn: 'ESPN',
  skysports: 'Sky Sports',
  theathletic: 'The Athletic',
  premierleague: 'Premier League',
  sec: 'SEC',
  census: 'US Census Bureau',
  bls: 'US Bureau of Labor Statistics',
  britannica: 'Britannica',
  nature: 'Nature',
  techcrunch: 'TechCrunch',
  theverge: 'The Verge',
  arstechnica: 'Ars Technica',
};

/** Second-level labels that are part of a country suffix, not the name (bbc.co.uk, abc.net.au). */
const SUFFIX_PARTS = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);

/** A publisher's short name from its source: "uefa.com" -> "UEFA", "bbc.co.uk" -> "BBC". */
export function sourceLabel(source: Pick<ResearchSource, 'title' | 'url'>): string | null {
  let host = '';
  try {
    host = new URL(source.url).hostname.toLowerCase().replace(/^www\.|^m\.|^en\./, '');
  } catch {
    // A brief's source may have no address: use its title
    const title = source.title?.trim();
    return title ? title.slice(0, 40) : null;
  }
  const parts = host.split('.');
  let name = parts.length >= 3 && SUFFIX_PARTS.has(parts[parts.length - 2]) ? parts[parts.length - 3] : parts[parts.length - 2] ?? parts[0];
  if (parts.some((p) => p === 'wikipedia')) name = 'wikipedia';
  if (!name) return null;
  if (KNOWN[name]) return KNOWN[name];
  // Short names are usually acronyms (uefa, fifa, nasa, imf, oecd)
  if (name.length <= 4) return name.toUpperCase();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The tag for a shot: its cited facts' publishers (at most two), or null when it cites none. */
export function sourceTagFor(shot: Pick<ShotPlan, 'visual_type' | 'fact_ids' | 'chart'>, dossier: Pick<ResearchDossier, 'facts' | 'sources'> | null | undefined): string | null {
  // A chart of real figures says where they come from, research or not
  if (shot.visual_type === 'chart' && shot.chart?.data) return 'Source: World Bank';
  if (!dossier || !SOURCE_TAGGED.has(shot.visual_type) || !shot.fact_ids?.length) return null;
  const sources = new Map(dossier.sources.map((s) => [s.id, s]));
  const names: string[] = [];
  for (const id of shot.fact_ids) {
    const fact = dossier.facts.find((f) => f.id === id);
    for (const sid of fact?.sourceIds ?? []) {
      const src = sources.get(sid);
      const name = src ? sourceLabel(src) : null;
      if (name && !names.includes(name)) names.push(name);
    }
  }
  if (!names.length) return null;
  return `${names.length > 1 ? 'Sources' : 'Source'}: ${names.slice(0, 2).join(', ')}`;
}

/**
 * The motion page with the tag in its lower-left corner. It fades in after the figures, driven by
 * the page's own frame clock (__frame), so every render comes out the same.
 */
export function withSourceTag(html: string, tag: string, theme: MotionTheme): string {
  const css = `<style>.src-tag{position:absolute;left:64px;bottom:44px;font-family:${theme.bodyFont};font-size:24px;letter-spacing:.5px;color:${theme.text};opacity:0;z-index:50}.src-tag::before{content:'';display:inline-block;width:18px;height:3px;margin-right:10px;vertical-align:middle;background:${theme.accent}}</style>`;
  const fade =
    'const el=document.querySelector(".src-tag");const w=window;const prev=w.__frame;' +
    'w.__frame=(t,d)=>{if(typeof prev==="function")prev(t,d);if(el)el.style.opacity=String(Math.min(0.72,Math.max(0,(t-1)/0.6*0.72)));};';
  const tail = `<div class="src-tag">${escapeHtml(tag)}</div><script>(()=>{${fade}})();</script>`;
  // Function replacements, so a "$" in the page or the tag is never read as a pattern
  const withCss = html.includes('</head>') ? html.replace('</head>', () => `${css}</head>`) : css + html;
  return withCss.includes('</body>') ? withCss.replace('</body>', () => `${tail}</body>`) : withCss + tail;
}
