import type { FootageInfo, GuideMotion, GuideProject, GuideShot } from './types';

/**
 * The guide's clock, worked out before anything is rendered: what the narrator says when, which
 * footage plays under it (a cut every second or two), when the item cards and captions show, and
 * how the end runs back into the start.
 */

export const FPS = 30;
export const SHORT_W = 1080;
export const SHORT_H = 1920;
export const WIDE_W = 1920;
export const WIDE_H = 1080;
/** The picture size of a guide: a vertical Short, or a wide video. */
export const frameSize = (format?: GuideProject['format']) => (format === 'wide' ? { w: WIDE_W, h: WIDE_H } : { w: SHORT_W, h: SHORT_H });
/** Still pictures used as shots (held, usually with a push). */
export const isStill = (file: string) => /\.(png|jpe?g|webp)$/i.test(file);
/** Silence after each spoken part before the next one starts. */
export const GAP_SEC = 0.12;
/** How long an item's card stays up. */
export const CARD_SEC = 2.2;
/** The slowest footage is played to fill a part (0.6 = 60% speed). */
const MIN_SPEED = 0.6;
/** Speaking speed used to guess a part's length before it's voiced (words per second). */
const GUESS_WPS = 3;

const r3 = (n: number) => Number(n.toFixed(3));
/** Seconds rounded to whole frames. */
export const toFrames = (sec: number) => Math.max(0, Math.round(sec * FPS));
export const fromFrames = (frames: number) => r3(frames / FPS);

// --------------------------------------------------------------------------
// Marked-up text: *green* and ~red~
// --------------------------------------------------------------------------

export type WordColour = 'green' | 'red';

/** Text with its performance tags ("[whispers]", "[dramatic pause]") taken out. */
export const withoutTags = (text: string) => text.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
/** The text the voice reads: colour marks gone; tags kept for an engine that acts them out, else gone. */
export function voiceText(text: string, keepTags: boolean): string {
  if (!keepTags) return parseMarkup(text).plain;
  return text.replace(/[*~]/g, '').replace(/\s+/g, ' ').trim();
}

export interface MarkedWord {
  word: string;
  colour?: WordColour;
}

/** The words of a marked line, with their colours; marks can span several words ("*dog poop*"). */
export function parseMarkup(text: string): { plain: string; words: MarkedWord[] } {
  const words: MarkedWord[] = [];
  let open: WordColour | null = null;
  // [whispers], [sighs]: acting directions for the voice, never shown or read as words
  for (const raw of withoutTags(text).split(/\s+/).filter(Boolean)) {
    let token = raw;
    let colour: WordColour | null = open;
    // A mark can sit after leading punctuation ("(*wow*)") or before trailing punctuation ("*this*,")
    const lead = token.match(/^[("'“]*([*~])/);
    if (!open && lead) {
      open = lead[1] === '*' ? 'green' : 'red';
      colour = open;
      token = token.replace(/^([("'“]*)[*~]/, '$1');
    }
    const close = token.match(/[*~]([)"'”.,!?;:…]*)$/);
    if (open && close) {
      token = token.replace(/[*~]([)"'”.,!?;:…]*)$/, '$1');
      open = null;
    }
    token = token.replace(/[*~]/g, '');
    if (!token) continue;
    words.push(colour ? { word: token, colour } : { word: token });
  }
  return { plain: words.map((w) => w.word).join(' '), words };
}

// --------------------------------------------------------------------------
// Captions timed by the voice
// --------------------------------------------------------------------------

export interface TimedWord {
  word: string;
  start: number;
  end: number;
  colour?: WordColour;
}

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * The script's words with the voice's timings. The voice engine splits and spells some words its
 * own way ("$40,000" is read as "forty thousand dollars"), so words are matched in order, looking a
 * few words ahead, and any left over are spread between their neighbours.
 */
export function alignWords(marked: MarkedWord[], spoken: Array<{ word: string; start: number; end: number }>, durationSec: number): TimedWord[] {
  const heard = spoken.filter((w) => norm(w.word));
  const out: Array<TimedWord & { matched: boolean }> = marked.map((m) => ({ word: m.word, start: 0, end: 0, matched: false, ...(m.colour ? { colour: m.colour } : {}) }));
  let j = 0;
  for (let i = 0; i < out.length && j < heard.length; i++) {
    const want = norm(out[i].word);
    if (!want) continue;
    let k = -1;
    for (let a = 0; a < 5 && j + a < heard.length; a++) {
      if (norm(heard[j + a].word) === want) {
        k = j + a;
        break;
      }
    }
    if (k < 0) continue;
    out[i].start = heard[k].start;
    out[i].end = heard[k].end;
    out[i].matched = true;
    j = k + 1;
  }
  // Unmatched words share the time between the matched words around them
  for (let i = 0; i < out.length; i++) {
    if (out[i].matched) continue;
    let e = i;
    while (e < out.length && !out[e].matched) e++;
    const from = i > 0 ? out[i - 1].end : 0;
    const to = e < out.length ? out[e].start : Math.max(from, heard.length ? heard[heard.length - 1].end : durationSec);
    const span = Math.max(0, to - from);
    const n = e - i;
    for (let x = 0; x < n; x++) {
      out[i + x].start = r3(from + (span * x) / n);
      out[i + x].end = r3(from + (span * (x + 1)) / n);
    }
    i = e - 1;
  }
  return out.map(({ matched: _m, ...w }) => w);
}

// --------------------------------------------------------------------------
// Footage: cuts and the vertical crop
// --------------------------------------------------------------------------

/** One cut of the Short: a stretch of a recording, sped down when there isn't enough. */
export interface Cut {
  file: string;
  /** Seconds into the recording. */
  from: number;
  /** Seconds of recording used. */
  srcSec: number;
  /** Seconds it fills in the Short (whole frames). */
  outSec: number;
  focusX?: number;
  zoom?: number;
  focusY?: number;
  push?: number;
  sound?: string;
  mute?: boolean;
  volume?: number;
  /** The right half of a side-by-side cut: its own stretch, as long as this one. */
  beside?: { file: string; from: number; srcSec: number; focusX?: number; zoom?: number; focusY?: number };
  labels?: [string, string];
}

/** A shot's framing, carried onto its cuts. */
const framing = (s: Pick<GuideShot, 'focusX' | 'zoom' | 'focusY' | 'push' | 'sound' | 'mute' | 'volume'>) => ({
  ...(s.focusX != null ? { focusX: s.focusX } : {}),
  ...(s.zoom != null && s.zoom > 1 ? { zoom: s.zoom } : {}),
  ...(s.focusY != null ? { focusY: s.focusY } : {}),
  ...(s.push ? { push: s.push } : {}),
  ...(s.sound ? { sound: s.sound } : {}),
  ...(s.mute ? { mute: true } : {}),
  ...(s.volume != null ? { volume: s.volume } : {}),
});

/** The right half of a side-by-side cut that starts `offset` seconds into its left shot. */
const besideCut = (s: GuideShot, offset: number, srcSec: number): Cut['beside'] | undefined => {
  const b = s.beside;
  if (!b) return undefined;
  const len = Math.max(0, b.to - b.from);
  const from = isStill(b.file) ? b.from : b.from + Math.max(0, Math.min(offset, len - srcSec));
  return { file: b.file, from: r3(from), srcSec: r3(Math.min(srcSec, len || srcSec)), ...(b.focusX != null ? { focusX: b.focusX } : {}), ...(b.zoom != null && b.zoom > 1 ? { zoom: b.zoom } : {}), ...(b.focusY != null ? { focusY: b.focusY } : {}) };
};

const shotLen = (s: GuideShot) => Math.max(0, s.to - s.from);

/** Cut lengths for a part: around `cutSec` each, a little uneven so it doesn't feel mechanical, adding up exactly. */
export function cutLengths(durationSec: number, cutSec: number): number[] {
  const total = toFrames(durationSec);
  if (total <= 0) return [];
  const n = Math.max(1, Math.round(durationSec / Math.max(0.4, cutSec)));
  const pattern = [1, 0.8, 1.2, 0.9, 1.1, 1];
  const weights = Array.from({ length: n }, (_, i) => pattern[i % pattern.length]);
  const sum = weights.reduce((a, b) => a + b, 0);
  const frames = weights.map((w) => Math.max(1, Math.floor((w / sum) * total)));
  let left = total - frames.reduce((a, b) => a + b, 0);
  for (let i = 0; left > 0; i = (i + 1) % n, left--) frames[i]++;
  return frames.map(fromFrames);
}

/** Where a point along the footage (seconds, counting all its shots end to end) falls. */
function locate(shots: GuideShot[], pos: number): { shot: number; t: number } {
  let p = pos;
  for (const [i, s] of shots.entries()) {
    if (p < shotLen(s) || i === shots.length - 1) return { shot: i, t: s.from + Math.min(p, shotLen(s)) };
    p -= shotLen(s);
  }
  return { shot: 0, t: shots[0]?.from ?? 0 };
}

/**
 * Fills a part with cuts from its footage. With more footage than time, the cuts are spread evenly
 * through it (jump cuts through the action, in order); with less, the footage plays slower, and
 * repeats only when even slowed down it runs out. `firstWhole` plays the first shot as one cut (the
 * opening shot isn't chopped up).
 */
export function fillCuts(shots: GuideShot[], durationSec: number, cutSec: number, opts: { firstWhole?: boolean } = {}): Cut[] {
  // Slivers are skipped, unless a shot has a set length: a few hundredths of a second held is a freeze-frame
  const usable = shots.filter((s) => shotLen(s) > 0.05 || (s.sec && shotLen(s) > 0));
  const total = fromFrames(toFrames(durationSec));
  if (!usable.length || total <= 0) return [];
  const cut = (s: GuideShot, from: number, srcSec: number, outSec: number): Cut => {
    const beside = besideCut(s, from - s.from, srcSec);
    return { file: s.file, from: r3(from), srcSec: r3(srcSec), outSec, ...framing(s), ...(beside ? { beside, ...(s.labels ? { labels: s.labels } : {}) } : {}) };
  };

  // Shots with a set length are one cut each; the shots between them share the rest by how much footage they have
  if (usable.some((s) => s.sec)) {
    const totalF = toFrames(total);
    const wantF = usable.reduce((a, s) => a + (s.sec ? Math.max(1, toFrames(s.sec)) : 0), 0);
    const scale = wantF > totalF ? totalF / wantF : 1;
    const pieces: Array<{ fixed: GuideShot } | { run: GuideShot[] }> = [];
    for (const s of usable) {
      if (s.sec) pieces.push({ fixed: s });
      else if (pieces.length && 'run' in pieces[pieces.length - 1]) (pieces[pieces.length - 1] as { run: GuideShot[] }).run.push(s);
      else pieces.push({ run: [s] });
    }
    const fixedF = pieces.map((p) => ('fixed' in p ? Math.max(1, Math.floor(toFrames(p.fixed.sec!) * scale)) : 0));
    let freeF = totalF - fixedF.reduce((a, b) => a + b, 0);
    const runFoot = pieces.map((p) => ('run' in p ? p.run.reduce((a, s) => a + shotLen(s), 0) : 0));
    const footSum = runFoot.reduce((a, b) => a + b, 0);
    const lastRun = runFoot.map((f) => f > 0).lastIndexOf(true);
    // No free shots: the last fixed one takes the time that's left
    if (lastRun < 0 && freeF > 0) fixedF[fixedF.length - 1] += freeF;
    const out: Cut[] = [];
    for (const [i, p] of pieces.entries()) {
      if ('fixed' in p) {
        const outSec = fromFrames(fixedF[i]);
        out.push(cut(p.fixed, p.fixed.from, Math.min(shotLen(p.fixed), outSec), outSec));
        continue;
      }
      const f = i === lastRun ? freeF : Math.round((runFoot[i] / footSum) * (totalF - fixedF.reduce((a, b) => a + b, 0)));
      freeF -= f;
      if (f > 0) out.push(...fillCuts(p.run, fromFrames(f), cutSec));
    }
    return out;
  }

  if (opts.firstWhole) {
    const first = usable[0];
    const firstOut = fromFrames(toFrames(Math.min(shotLen(first), total)));
    const rest = usable.slice(1);
    const left = r3(total - firstOut);
    if (left < 1 / FPS) return [cut(first, first.from, firstOut, total)];
    // No other footage: the opening shot slows down to fill
    if (!rest.length) return [cut(first, first.from, Math.min(shotLen(first), total), total)];
    return [cut(first, first.from, firstOut, firstOut), ...fillCuts(rest, left, cutSec)];
  }

  const lengths = cutLengths(total, cutSec);
  const footage = usable.reduce((a, s) => a + shotLen(s), 0);
  const out: Cut[] = [];
  if (footage >= total) {
    // Even skips between the cuts, so the part moves through all its footage
    const skip = (footage - total) / lengths.length;
    let pos = skip / 2;
    for (const len of lengths) {
      let { shot, t } = locate(usable, pos);
      const s = usable[shot];
      // A cut doesn't cross from one recording into the next: it moves to fit in its shot
      if (t + len > s.to) t = Math.max(s.from, s.to - len);
      const src = Math.min(len, s.to - t);
      out.push(cut(s, t, src, len));
      pos += len + skip;
    }
    return out;
  }
  // Not enough footage: slow it down (to MIN_SPEED at most), then go round again
  const speed = Math.max(MIN_SPEED, footage / total);
  let pos = 0;
  for (const len of lengths) {
    const want = len * speed;
    let { shot, t } = locate(usable, pos % footage);
    const s = usable[shot];
    if (t + want > s.to) t = Math.max(s.from, s.to - want);
    const src = Math.min(want, s.to - t);
    out.push(cut(s, t, src, len));
    pos += want;
  }
  return out;
}

/**
 * The 9:16 window of a recording, centred across at `focusX` (a vertical recording is used whole);
 * a zoom takes a smaller window around (focusX, focusY), kept inside the picture.
 */
export function cropFor(info: Pick<FootageInfo, 'width' | 'height' | 'box'>, focusX = 0.5, zoom = 1, focusY = 0.5, target = SHORT_W / SHORT_H): { w: number; h: number; x: number; y: number } {
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  // Black bars the recording was posted with stay out of the crop
  const b = info.box ?? { x: 0, y: 0, w: info.width, h: info.height };
  const wide = b.w / b.h > target;
  const z = Math.max(1, zoom);
  const w = even((wide ? b.h * target : b.w) / z);
  const h = even((wide ? b.h : b.w / target) / z);
  const place = (focus: number, size: number, full: number) => Math.round(Math.min(Math.max(0, focus * full - size / 2), full - size));
  return { w, h, x: b.x + place(focusX, w, b.w), y: b.y + place(focusY, h, b.h) };
}

// --------------------------------------------------------------------------
// The whole guide
// --------------------------------------------------------------------------

export type PartKind = 'hook' | 'item' | 'outro' | 'loop';

export interface Segment {
  part: string;
  kind: PartKind;
  itemIndex?: number;
  /** Seconds from the start of the Short (the voice starts here too). */
  start: number;
  durationSec: number;
  cuts: Cut[];
}

/** The spoken parts in order, each with its marked text. */
export function spokenParts(p: Pick<GuideProject, 'hook' | 'items' | 'outro' | 'loopLine'>): Array<{ part: string; kind: PartKind; itemIndex?: number; text: string }> {
  return [
    { part: 'hook', kind: 'hook' as const, text: p.hook },
    ...p.items.map((it, i) => ({ part: `item-${i}`, kind: 'item' as const, itemIndex: i, text: it.say })),
    { part: 'outro', kind: 'outro' as const, text: p.outro },
    { part: 'loop', kind: 'loop' as const, text: p.loopLine },
  ].filter((x) => x.text.trim());
}

/** A guess at how long a line takes to say, for before it's voiced. */
export const guessSpokenSec = (text: string, speed = 1) => r3(Math.max(0.6, parseMarkup(text).words.length / (GUESS_WPS * Math.max(0.5, speed))));

/** The footage just before the opening shot, `durationSec` of it ending exactly where the opener starts; null when there's too little. */
function leadIn(opener: GuideShot, durationSec: number, endAt = opener.from): GuideShot | null {
  if (endAt < durationSec * MIN_SPEED) return null;
  return { ...opener, from: r3(Math.max(0, endAt - durationSec)), to: r3(endAt) };
}

/**
 * Lays the guide out on the Short's clock: each spoken part followed by a short gap, with its footage.
 * The hook plays over the opening shot; the outro and the loop line play over the footage leading up
 * to the opening shot, so the last frame runs straight into the first when the Short replays.
 */
export function planGuide(p: GuideProject, spokenSec: (part: string, text: string) => number): { segments: Segment[]; durationSec: number; warnings: string[] } {
  const warnings: string[] = [];
  const parts = spokenParts(p);
  const gap = p.gapSec ?? GAP_SEC;
  const lengths = parts.map((x, i) =>
    fromFrames(toFrames(spokenSec(x.part, x.text) + (i === parts.length - 1 ? 0.05 + Math.max(0, p.tailSec ?? 0) : gap) + (x.itemIndex != null ? Math.max(0, p.items[x.itemIndex].after ?? 0) : 0))),
  );
  const segments: Segment[] = [];
  let at = 0;
  const lastItemShots = p.items.length ? p.items[p.items.length - 1].shots : [];
  const loopIdx = parts.findIndex((x) => x.kind === 'loop');
  const loopSec = loopIdx >= 0 ? lengths[loopIdx] : 0;

  for (const [i, x] of parts.entries()) {
    const dur = lengths[i];
    let cuts: Cut[] = [];
    if (x.kind === 'hook') cuts = fillCuts([p.opener, ...(p.hookShots ?? [])], dur, p.cutSec, { firstWhole: true });
    else if (x.kind === 'item') {
      const shots = p.items[x.itemIndex!].shots;
      if (!shots.length) warnings.push(`Item ${x.itemIndex! + 1} ("${p.items[x.itemIndex!].heading}") has no footage.`);
      cuts = fillCuts(shots.length ? shots : [p.opener], dur, p.cutSec);
    } else if (x.kind === 'outro') {
      // The footage before the loop line's lead-in, cut up like the rest; else the outro's own (or the last item's)
      const before = !p.outroShots?.length ? leadIn(p.opener, dur * 2, r3(p.opener.from - loopSec)) : null;
      if (p.outroShots?.length) cuts = fillCuts(p.outroShots, dur, p.cutSec);
      else if (before && leadIn(p.opener, loopSec)) cuts = fillCuts([before], dur, p.cutSec);
      else cuts = fillCuts(lastItemShots.length ? lastItemShots : [p.opener], dur, p.cutSec);
    } else {
      // One unbroken shot that ends where the opening shot starts
      const lead = leadIn(p.opener, dur);
      if (lead) cuts = [{ file: lead.file, from: lead.from, srcSec: r3(lead.to - lead.from), outSec: dur, ...framing(lead) }];
      else {
        warnings.push(`The opening shot starts ${p.opener.from.toFixed(1)} s into its recording; the loop needs about ${dur.toFixed(1)} s of footage before it to run seamlessly. Start the opener later in the recording.`);
        cuts = fillCuts([p.opener], dur, p.cutSec, { firstWhole: true });
      }
    }
    segments.push({ part: x.part, kind: x.kind, ...(x.itemIndex != null ? { itemIndex: x.itemIndex } : {}), start: at, durationSec: dur, cuts });
    at = r3(at + dur);
  }
  return { segments, durationSec: at, warnings };
}

/**
 * The chapter list for a wide video's description ("0:00 Intro", "0:31 2002 · Vice City"…): one per
 * item with a heading (or its own chapter name), following YouTube's rules: the first at 0:00, each
 * at least 10 seconds long, and only when there are three or more.
 */
export function chapterList(p: Pick<GuideProject, 'items' | 'introChapter'>, segments: Segment[]): Array<{ at: number; title: string }> {
  const out: Array<{ at: number; title: string }> = [{ at: 0, title: p.introChapter?.trim() || 'Intro' }];
  for (const s of segments) {
    if (s.kind !== 'item') continue;
    const it = p.items[s.itemIndex!];
    if (it.chapter === false) continue;
    const title = (typeof it.chapter === 'string' ? it.chapter : it.heading).replace(/\s*\|\s*/g, ' ').replace(/[*~]/g, '').trim();
    if (!title) continue;
    const last = out[out.length - 1];
    // Under 10 seconds since the last chapter: this one takes its place (it starts the real section)
    if (s.start - last.at < 10) {
      if (last.at > 0) out[out.length - 1] = { at: last.at, title };
      continue;
    }
    out.push({ at: s.start, title });
  }
  return out.length >= 3 ? out : [];
}

/** 75.4 → "1:15"; 3725 → "1:02:05". */
export const clockTime = (sec: number) => {
  const t = Math.floor(sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

/** When each item's card shows, on the Short's clock (items with no heading have none). */
export function cardWindows(segments: Segment[], items?: Array<{ heading: string }>, cardSec = CARD_SEC): Array<{ itemIndex: number; from: number; to: number }> {
  return segments
    .filter((s) => s.kind === 'item' && (!items || items[s.itemIndex!]?.heading.trim()))
    .map((s) => ({ itemIndex: s.itemIndex!, from: s.start, to: r3(s.start + Math.min(cardSec, Math.max(0.5, s.durationSec - 0.2))) }));
}

/** How long each motion graphic shows unless told otherwise, and when the WASTED word lands in its sting. */
export const MOTION_SEC = { wasted: 2.2, location: 2.6, social: 6.2 } as const;
export const WASTED_HIT_SEC = 0.12;

/** Each item's motion graphics on the Short's clock (cut off at the item's end). */
export function motionWindows(p: Pick<GuideProject, 'items'>, segments: Segment[]): Array<{ itemIndex: number; index: number; from: number; to: number; motion: GuideMotion }> {
  const out: Array<{ itemIndex: number; index: number; from: number; to: number; motion: GuideMotion }> = [];
  for (const s of segments) {
    if (s.kind !== 'item') continue;
    for (const [index, m] of (p.items[s.itemIndex!].motion ?? []).entries()) {
      const len = m.durationSec ?? MOTION_SEC[m.kind];
      const end = s.start + s.durationSec;
      const from = r3(Math.max(s.start, m.at >= 0 ? s.start + m.at : end + m.at));
      const to = r3(Math.min(end, from + len));
      if (to - from > 0.1) out.push({ itemIndex: s.itemIndex!, index, from, to, motion: m });
    }
  }
  return out;
}

/** Where the Short cuts from one shot to the next (for the whoosh under item changes, and checks). */
export function cutTimes(segments: Segment[]): number[] {
  const out: number[] = [];
  for (const s of segments) {
    let t = s.start;
    for (const c of s.cuts) {
      if (t > 0) out.push(r3(t));
      t += c.outSec;
    }
  }
  return out;
}
