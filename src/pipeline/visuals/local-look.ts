import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { MediaCandidate } from './types';

/**
 * The local first look: a small image-and-text model (CLIP) running on this computer scores how
 * well each footage candidate's thumbnail matches the shot's description. It is free and has no
 * daily limit, so it ranks every candidate; the careful vision check (Gemini) then only sees the
 * best few, and when that check is unavailable the best local match can still fill the shot.
 *
 * Measured on real thumbnails: clear matches score about 0.25-0.32, unrelated pictures 0.14-0.22.
 * CLIP can't judge era, teams or brands the way the vision check does, so its picks are kept
 * marked "needs check" until the vision check has seen them.
 */

/** At or above: the picture plainly shows the description. */
export const LOCAL_MATCH = 0.25;
/** Below: almost certainly unrelated. */
export const LOCAL_FLOOR = 0.2;
/** How many of the best local matches the vision check is shown. */
export const LOCAL_TOP = 6;

export const clipModelId = () => process.env.CLIP_MODEL || 'Xenova/clip-vit-base-patch32';

type Vector = Float32Array;
interface ClipModel {
  text: (s: string) => Promise<Vector>;
  image: (bytes: Uint8Array) => Promise<Vector>;
}

const state = globalThis as unknown as {
  __clipModel?: Promise<ClipModel>;
  __clipText?: Map<string, Vector>;
  __clipImage?: Map<string, Vector>;
  __clipDisabled?: string;
};

const normalize = (v: Vector): Vector => {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
};

export const cosine = (a: Vector, b: Vector) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

async function loadModel(): Promise<ClipModel> {
  const T = await import('@huggingface/transformers');
  T.env.cacheDir = path.join(/* turbopackIgnore: true */ process.cwd(), 'storage', 'models');
  const id = clipModelId();
  const [tokenizer, textModel, processor, visionModel] = await Promise.all([
    T.AutoTokenizer.from_pretrained(id),
    T.CLIPTextModelWithProjection.from_pretrained(id, { dtype: 'q8' }),
    T.AutoProcessor.from_pretrained(id),
    T.CLIPVisionModelWithProjection.from_pretrained(id, { dtype: 'q8' }),
  ]);
  return {
    text: async (s) => normalize((await textModel(tokenizer([s], { padding: true, truncation: true }))).text_embeds.data as Vector),
    image: async (bytes) => {
      const img = await T.RawImage.fromBlob(new Blob([new Uint8Array(bytes)]));
      return normalize((await visionModel(await processor(img))).image_embeds.data as Vector);
    },
  };
}

/** The model, loaded once (the first load downloads it: a couple of minutes). */
export async function clipModel(): Promise<ClipModel> {
  if (state.__clipDisabled) throw new Error(state.__clipDisabled);
  state.__clipModel ??= loadModel().catch((err) => {
    state.__clipModel = undefined;
    throw err;
  });
  return state.__clipModel;
}

/** Turns the local look off for this run (e.g. the model can't load here). */
export function disableLocalLook(reason: string): void {
  state.__clipDisabled = reason;
}

const remember = <V>(map: Map<string, V>, key: string, value: V, max = 2000) => {
  if (map.size >= max) map.delete(map.keys().next().value!);
  map.set(key, value);
  return value;
};

export async function embedText(text: string): Promise<Vector> {
  state.__clipText ??= new Map();
  const key = text.trim().toLowerCase().slice(0, 300);
  const hit = state.__clipText.get(key);
  if (hit) return hit;
  return remember(state.__clipText, key, await (await clipModel()).text(key));
}

/** A thumbnail's bytes: a local file (library clips, hunted moments) or a URL. */
export async function thumbnailBytes(url: string, fetcher: typeof fetch = fetch): Promise<Uint8Array | null> {
  if (!url) return null;
  if (!/^https?:/i.test(url)) return fsp.readFile(url).then((b) => new Uint8Array(b)).catch(() => null);
  try {
    const res = await fetcher(url, { headers: { 'User-Agent': 'YT-Automation/1.0 (footage relevance check)' }, signal: AbortSignal.timeout(12000) });
    if (!res.ok || !/^image\//.test(res.headers.get('content-type') ?? '')) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

export async function embedImage(url: string): Promise<Vector | null> {
  state.__clipImage ??= new Map();
  const hit = state.__clipImage.get(url);
  if (hit) return hit;
  const bytes = await thumbnailBytes(url);
  if (!bytes) return null;
  try {
    return remember(state.__clipImage, url, await (await clipModel()).image(bytes));
  } catch {
    return null;
  }
}

export interface LocalScore {
  candidate: MediaCandidate;
  /** Similarity between the thumbnail and the shot's description (about 0.1-0.35). */
  similarity: number;
}

/** A local similarity on the vision check's 0-10 scale (0.25 → 6, the "shows it" line; 0.31 → 9). */
export const similarityToScore = (sim: number) => Math.max(0, Math.min(10, Math.round((sim - 0.13) * 50 * 10) / 10));

/** What the description says for the local look: the shot's search phrase and the words it plays under. */
export const lookText = (query: string, covers?: string) => (covers && covers.length < 120 ? `${query}. ${covers}` : query).slice(0, 300);

/**
 * Scores candidates against the description, best first. Candidates whose thumbnail can't be
 * loaded keep their place at the end (with similarity 0). Throws only when the model can't load.
 */
export async function localRank(description: string, candidates: MediaCandidate[], concurrency = 4): Promise<LocalScore[]> {
  const want = await embedText(description);
  const scores: LocalScore[] = new Array(candidates.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
      while (next < candidates.length) {
        const i = next++;
        const c = candidates[i];
        const v = await embedImage(c.previewUrl || c.thumbnailUrl);
        scores[i] = { candidate: c, similarity: v ? cosine(want, v) : 0 };
      }
    }),
  );
  return scores.sort((a, b) => b.similarity - a.similarity);
}

/**
 * The candidates worth showing the vision check: the best LOCAL_TOP by local score, skipping
 * ones that are almost certainly unrelated (unless nothing better exists).
 */
export function shortlist(scored: LocalScore[], top = LOCAL_TOP): MediaCandidate[] {
  const plausible = scored.filter((s) => s.similarity >= LOCAL_FLOOR);
  return (plausible.length ? plausible : scored).slice(0, top).map((s) => s.candidate);
}
