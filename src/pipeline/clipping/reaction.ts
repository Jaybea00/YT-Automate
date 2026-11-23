import type { ClipEffect, ClipLayout, ClipPlan, CutIn, Ending, EndingStyle, FramePoint, HeaderBox, VoiceLine } from './types';

/**
 * The reaction edit: a header box above the clip, meme cut-ins after the payoff, a freeze-frame
 * with a voice line and a circle on what to look at, a speed ramp into the hit, a slow-motion
 * replay, flashes, shakes, emoji pop-ups and meme sounds on moments, and an ending (a sepia "to be
 * continued", credits on black, or a fail stamp) or a seamless loop back to the start.
 *
 * Cut-ins are inserted between moments of the clip (a ramp stretches the moments before a hit), so
 * the Short runs longer than the trimmed clip and every time in the plan (seconds into the source)
 * is mapped onto the Short's own clock (see outputTime).
 */

export const MEME_SEC = 1.4;
export const MIN_MEME_SEC = 0.8;
export const MAX_MEME_SEC = 2.2;
export const FREEZE_SEC = 1.6;
export const MAX_FREEZE_SEC = 4.5;
export const REPLAY_SPEED = 0.5;
export const REPLAY_SEC = 1.2;
/** Seconds of clip before the hit that a ramp slows down. */
export const RAMP_SEC = 0.8;
/** How long a skull hit holds the frame. */
export const SKULL_SEC = 0.9;
/**
 * The recap ending replays the finished Short's own highlights (memes, the circled freeze, skulls,
 * emoji): each shot is RECAP_SHOT_SEC of the Short played at RECAP_SPEED (a little slow), with soft
 * crossfades, then it lands on the big moment with a slow push-in and a skull, and cuts.
 */
export const RECAP_SHOT_SEC = 0.8;
export const RECAP_SPEED = 0.8;
export const RECAP_XFADE_SEC = 0.25;
export const RECAP_LANDING_SEC = 1.7;
const RECAP_MAX = 4;
/** Sounds a skull hit tries, in order (the user's library first, then the built-in boom). */
export const SKULL_SOUNDS = ['kai cenat boom', 'dark impact', 'vine boom', 'boom'];
/** Cut-ins add at most this much to the Short. */
export const MAX_ADDED_SEC = 10;
const MAX_MEMES = 2;
const MAX_EFFECTS = 8;
/** A voice line this close to a freeze is spoken over it. */
const FREEZE_SNAP_SEC = 0.3;
/** How long a freeze's voice line waits for the record scratch. */
export const FREEZE_VOICE_DELAY_SEC = 0.45;

export const ENDING_DEFAULTS: Record<Exclude<EndingStyle, 'none'>, { text: string; query: string; fallback: string; durationSec: number; leadSec: number }> = {
  tbc: { text: 'TO BE CONTINUED', query: 'to be continued', fallback: 'riser', durationSec: 2.6, leadSec: 1 },
  credits: { text: 'Directed by\nJASON', query: 'directed by', fallback: 'ding', durationSec: 3, leadSec: 0 },
  stamp: { text: 'SKILL ISSUE', query: 'vine boom', fallback: 'boom', durationSec: 2, leadSec: 0 },
  skull: { text: '', query: 'kai cenat boom', fallback: 'boom', durationSec: 1.6, leadSec: 0 },
  recap: { text: '', query: 'dark impact', fallback: 'boom', durationSec: 2.4, leadSec: 0 },
};

const round = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const validPoint = (p?: FramePoint | null): FramePoint | undefined =>
  p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: round(clamp(p.x, 0, 1)), y: round(clamp(p.y, 0, 1)) } : undefined;

// --------------------------------------------------------------------------
// Rules for what the writer (or the editor) asked for
// --------------------------------------------------------------------------

export interface CutInRequest {
  memes?: Array<{ at: number; query: string }>;
  freezeAt?: number | null;
  freezeFocus?: FramePoint | null;
  replay?: boolean;
  /** Slow the moments just before the big moment (true), or before another hit (a time). */
  ramp?: boolean | number | null;
  /** A skull hit (grey freeze, big skull, bass hit) just after the payoff, or at this time. */
  skullAt?: number | null;
  skullEmoji?: string | null;
  /** Slow stretches to cut out (seconds into the source). */
  skips?: Array<{ from: number; to: number }>;
}

/** The stretch of clip a cut-in takes up: a point, or for a ramp the moments it slows. */
const zone = (c: CutIn) => ({ from: c.kind === 'ramp' ? c.at - (c.replaySec ?? RAMP_SEC) : c.at, to: c.at });

/**
 * Cut-ins kept to the rules: at most two memes, one freeze, one replay, one ramp; no meme in the
 * second and a half before the big moment (that is the build-up: let it play) or in its first
 * 0.3 s; a freeze only before the big moment (and before a ramp into it); at least a second between
 * any two, except a meme straight after the replay; at most MAX_ADDED_SEC added in all.
 */
export function fitCutIns(req: CutInRequest, trimStart: number, trimEnd: number, peakSec: number | null): CutIn[] {
  const out: CutIn[] = [];
  const inBuild = (t: number) => peakSec != null && t > peakSec - 1.5 && t < peakSec + 0.3;
  const replayAt = req.replay && peakSec != null ? Math.min(trimEnd, peakSec + 1) : null;
  // A meme placed on the build-up goes right after the payoff instead (after the replay, if there is one)
  const afterPeak = (t: number) => (peakSec != null && inBuild(t) ? (replayAt ?? peakSec + 0.4) : t);
  const rampAt = typeof req.ramp === 'number' ? req.ramp : req.ramp && peakSec != null ? peakSec : null;

  if (rampAt != null && Number.isFinite(rampAt) && rampAt - RAMP_SEC >= trimStart + 0.3 && rampAt <= trimEnd) {
    out.push({ kind: 'ramp', at: round(rampAt), replaySec: RAMP_SEC, durationSec: round(RAMP_SEC * (1 / REPLAY_SPEED - 1)) });
  }
  if (req.freezeAt != null && Number.isFinite(req.freezeAt)) {
    const rampFrom = out[0]?.kind === 'ramp' && peakSec != null && Math.abs(out[0].at - peakSec) < 0.05 ? out[0].at - RAMP_SEC : null;
    const latest = rampFrom != null ? rampFrom - 0.3 : peakSec != null ? peakSec - 0.3 : trimEnd - 1;
    const at = clamp(req.freezeAt, trimStart + 0.6, latest);
    if (at <= latest && at >= trimStart + 0.6) {
      const focus = validPoint(req.freezeFocus);
      out.push({ kind: 'freeze', at: round(at), durationSec: FREEZE_SEC, ...(focus ? { focus } : {}) });
    }
  }
  if (replayAt != null) {
    const replaySec = round(Math.min(REPLAY_SEC, replayAt - trimStart));
    if (replaySec >= 0.6) out.push({ kind: 'replay', at: round(replayAt), durationSec: round(replaySec / REPLAY_SPEED), replaySec });
  }
  if (req.skullAt != null && Number.isFinite(req.skullAt)) {
    const at = clamp(afterPeak(req.skullAt), trimStart + 1, trimEnd);
    const emoji = (req.skullEmoji ?? '').trim().slice(0, 40);
    out.push({ kind: 'skull', at: round(at), durationSec: SKULL_SEC, ...(emoji ? { emoji } : {}) });
  }
  for (const m of (req.memes ?? []).slice(0, MAX_MEMES + 2)) {
    const query = m.query.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!query || !Number.isFinite(m.at)) continue;
    const at = clamp(afterPeak(m.at), trimStart + 1.5, trimEnd);
    out.push({ kind: 'meme', at: round(at), durationSec: MEME_SEC, query, pick: 0 });
  }

  // Cut-outs: inside the trim, at least half a second, never over the big moment or its build-up,
  // and not overlapping each other
  const skips: CutIn[] = [];
  for (const s of [...(req.skips ?? [])].sort((a, b) => a.from - b.from)) {
    const from = Math.max(s.from, trimStart + 0.5);
    let to = Math.min(s.to, trimEnd - 0.5);
    if (peakSec != null && from < peakSec + 0.5 && to > peakSec - 1.5) to = Math.min(to, peakSec - 1.5);
    const last = skips[skips.length - 1];
    if (to - from < 0.5 || (last && from < last.at + (last.skipSec ?? 0))) continue;
    skips.push({ kind: 'skip', at: round(from), durationSec: 0, skipSec: round(to - from) });
  }
  const skipped = (t: number) => insideSkip(t, skips);

  const kept: CutIn[] = [...skips];
  let added = 0;
  const clash = (a: CutIn, b: CutIn) => {
    if (a.kind === 'skip' || b.kind === 'skip') return false;
    if (a.kind === 'replay' && b.kind === 'meme' && a.at === b.at) return false;
    const za = zone(a);
    const zb = zone(b);
    // Something right after a ramp's hit is fine; nothing may land inside the slowed stretch
    if (a.kind === 'ramp' || b.kind === 'ramp') {
      const [r, o] = a.kind === 'ramp' ? [za, zb] : [zb, za];
      return o.to > r.from - 0.25 && o.to < r.to;
    }
    return Math.abs(za.to - zb.to) < 1;
  };
  for (const c of sortCutIns(out)) {
    if (skipped(c.at)) continue;
    if (kept.some((k) => clash(k, c))) continue;
    if (c.kind === 'meme' && kept.filter((k) => k.kind === 'meme').length >= MAX_MEMES) continue;
    if (added + c.durationSec > MAX_ADDED_SEC) continue;
    kept.push(c);
    added += c.durationSec;
  }
  return sortCutIns(kept);
}

const KIND_ORDER: Record<CutIn['kind'], number> = { skip: 0, ramp: 1, freeze: 2, skull: 3, replay: 4, meme: 5 };
/** In playing order: by time, and at the same time a ramp, then a freeze, a replay, a meme. */
export const sortCutIns = <T extends CutIn>(cutIns: T[]): T[] => [...cutIns].sort((a, b) => a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️){1,8}$/u;
const EMOJI_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _'-]{1,39}$/u;

/**
 * Hits: the big moment gets a flash and a shake; the writer's flashes, shakes, emoji and meme
 * sounds are kept when they are inside the Short and not on top of the same kind of hit.
 */
export function fitEffects(requested: ClipEffect[], trimStart: number, trimEnd: number, peakSec: number | null): ClipEffect[] {
  const all: ClipEffect[] = [];
  if (peakSec != null && peakSec >= trimStart && peakSec < trimEnd) all.push({ at: round(peakSec), kind: 'flash' }, { at: round(peakSec), kind: 'shake' });
  for (const e of requested) {
    if (!Number.isFinite(e.at) || e.at < trimStart || e.at >= trimEnd) continue;
    if (all.some((k) => k.kind === e.kind && Math.abs(k.at - e.at) < 0.8)) continue;
    if (e.kind === 'emoji') {
      // A typed emoji, or the name of a picture in the emoji library ("skull exploding")
      const raw = (e.emoji ?? '').trim();
      const emoji = EMOJI.test(raw.replace(/\s+/g, '')) ? raw.replace(/\s+/g, '') : EMOJI_NAME.test(raw) ? raw.replace(/\s+/g, ' ') : '';
      if (emoji) all.push({ at: round(e.at), kind: 'emoji', emoji });
    } else if (e.kind === 'sound') {
      const query = (e.query ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (query) all.push({ at: round(e.at), kind: 'sound', query });
    } else all.push({ at: round(e.at), kind: e.kind });
  }
  return all.sort((a, b) => a.at - b.at).slice(0, MAX_EFFECTS);
}

/** The header box from the writer's text, or the hook. Red words are kept only if they're in the text. */
export function fitHeader(header: Partial<HeaderBox> | undefined, hook: string): HeaderBox {
  const text = (header?.text || hook || '').replace(/\s+/g, ' ').trim().slice(0, 90);
  const lower = text.toLowerCase();
  const highlight = [...new Set((header?.highlight ?? []).map((w) => w.trim()).filter((w) => w && lower.includes(w.toLowerCase())))].slice(0, 3);
  return { text, highlight };
}

/** The ending with its style's defaults filled in; none when no style (or 'none') is asked for. */
export function fitEnding(req: { style?: string | null; text?: string | null; query?: string | null; emoji?: string | null } | null | undefined): Ending | undefined {
  const style = req?.style as EndingStyle | undefined;
  if (!style || style === 'none' || !(style in ENDING_DEFAULTS)) return undefined;
  const d = ENDING_DEFAULTS[style];
  const text = (req?.text ?? '').replace(/[ \t]+/g, ' ').trim().slice(0, 60) || d.text;
  // The skull ending's picture (💀 by default); a recap's landing picture when one is named
  const asked = (req?.emoji ?? '').trim().slice(0, 40);
  const emoji = style === 'skull' ? asked || '💀' : style === 'recap' ? asked || undefined : undefined;
  return {
    style,
    text: style === 'skull' || style === 'recap' ? '' : style === 'credits' ? text : text.replace(/\n/g, ' '),
    ...(emoji ? { emoji } : {}),
    query: (req?.query ?? '').trim().slice(0, 60) || d.query,
    durationSec: d.durationSec,
  };
}

export { validPoint as fitPoint };

/** Seconds of the Short one recap shot takes once slowed. */
export const RECAP_SHOT_OUT_SEC = RECAP_SHOT_SEC / RECAP_SPEED;

/**
 * The recap's shots, as times in the finished Short (before the ending): the edit's own highlights,
 * memes first, then the circled freeze, skull hits and emoji, at most RECAP_MAX, at least a second
 * apart, in order, and clear of the landing; and the landing, just after the big moment's hit.
 */
export function recapShots(input: {
  cutIns: Array<Pick<TimedCutIn, 'kind' | 'outAt' | 'durationSec' | 'focus'>>;
  /** Emoji pop-ups, on the Short's clock. */
  emojiAt: number[];
  peakOut: number | null;
  mainSec: number;
  /** Times to keep the landing frame away from (whip blurs at cuts): it should be a clean frame. */
  avoid?: number[];
}): { shots: number[]; landing: number | null } {
  const { cutIns, mainSec } = input;
  // Just after the hit's flash (0.18 s), on a frame clear of any whip blur
  const clean = (t: number) => t < mainSec - 0.1 && (input.avoid ?? []).every((a) => Math.abs(a - t) > 0.15);
  const landing = input.peakOut != null ? ([0.22, 0.3, 0.5, 0.12, 0.8].map((d) => round(input.peakOut! + d)).find(clean) ?? null) : null;
  // Shots stay clear of the landing, and of what follows straight after it (the same payoff again)
  const fits = (t: number) => t >= 0 && t + RECAP_SHOT_SEC <= mainSec && (landing == null || t + RECAP_SHOT_SEC < landing - 0.4 || t > landing + 1.5);
  const candidates = [
    ...cutIns.filter((c) => c.kind === 'meme').map((c) => c.outAt + Math.min(0.2, c.durationSec / 4)),
    ...cutIns.filter((c) => c.kind === 'freeze' && c.focus).map((c) => c.outAt + 0.35),
    ...cutIns.filter((c) => c.kind === 'skull').map((c) => c.outAt + 0.05),
    ...input.emojiAt.map((t) => t),
  ].filter(fits);
  const shots: number[] = [];
  for (const t of candidates) {
    if (shots.length >= RECAP_MAX) break;
    if (shots.every((p) => Math.abs(p - t) >= 1)) shots.push(round(t));
  }
  return { shots: shots.sort((a, b) => a - b), landing };
}

/** When each crossfade into a recap piece starts, and when the landing starts, on the final Short's clock. */
export function recapTimes(mainSec: number, shots: number[], landing: number | null): { transitions: number[]; landingStart: number | null } {
  const transitions: number[] = [];
  let length = mainSec;
  shots.forEach(() => {
    transitions.push(round(length - RECAP_XFADE_SEC));
    length = length - RECAP_XFADE_SEC + RECAP_SHOT_OUT_SEC;
  });
  if (landing == null) return { transitions, landingStart: null };
  transitions.push(round(length - RECAP_XFADE_SEC));
  return { transitions, landingStart: round(length - RECAP_XFADE_SEC) };
}

/** How long the recap adds to the Short: its shots and landing, less the crossfades between them. */
export function recapLength(shots: number[], landing: number | null): number {
  const pieces = shots.length + (landing != null ? 1 : 0);
  if (!pieces) return 0;
  return round(shots.length * RECAP_SHOT_OUT_SEC + (landing != null ? RECAP_LANDING_SEC : 0) - pieces * RECAP_XFADE_SEC);
}

/** The recap shots' flashback look: black and white, a little harder, with film grain and dark edges. */
export const RECAP_LOOK = 'hue=s=0,eq=contrast=1.12:brightness=0.02,noise=alls=7:allf=t,vignette=angle=PI/4';

/** Sounds for the recap: a rise into its white flash, a camera click on it, and a music bed under the shots (first found in the library, else built in). */
export const RECAP_RISE_SOUNDS = ['riser whoosh', 'riser'];
export const RECAP_CLICK_SOUNDS = ['camera flash', 'camera shutter'];
export const RECAP_BED_SOUNDS = ['suspense rise', 'energy riser', 'riser'];
/** The landing's picture when the ending doesn't name one (not the plain skull: the skull hit already used it). */
export const RECAP_LANDING_EMOJI = 'skull exploding';

/**
 * A slow push-in: the picture grows by `perSec` of its size each second, cropped back to the frame,
 * kept on `focus` (output pixels) as far as the frame allows, else the centre. (Not zoompan: fed
 * into a crossfade, zoompan never let go of its frames and ran out of memory.)
 */
export function pushIn(perSec: number, focus: { x: number; y: number } | null): string {
  const fxr = focus ? clamp(focus.x / SIZE.w, 0, 1).toFixed(3) : '0.5';
  const fyr = focus ? clamp(focus.y / SIZE.h, 0, 1).toFixed(3) : '0.5';
  return `scale=w='trunc(${SIZE.w}*(1+${perSec.toFixed(4)}*t)/2)*2':h=-2:eval=frame,crop=${SIZE.w}:${SIZE.h}:x='(iw-ow)*${fxr}':y='(ih-oh)*${fyr}'`;
}

/**
 * The recap pass's inputs: the finished Short whole (input 0), then each shot and the landing
 * opened on their own, seeked straight to their moment. (One input split many ways made ffmpeg
 * hold the whole Short in memory while it waited to reach the shots, and run out of it.)
 */
export function recapInputs(file: string, shots: number[], landing: number | null): string[] {
  const args = ['-i', file];
  for (const t of shots) args.push('-ss', fx(t), '-t', fx(RECAP_SHOT_SEC + 0.05), '-i', file);
  if (landing != null) args.push('-ss', fx(landing), '-t', '0.1', '-i', file);
  return args;
}

/**
 * The recap pass over the finished Short (inputs from recapInputs): the Short, then each shot slowed
 * with a slow push-in, then the landing frame held with a push towards `focus`, joined with
 * crossfades (a white one into the recap); and its sound, the shots' own sound lowered, joined the
 * same way. Gives [rv] and [ra].
 */
export function recapGraph(o: { mainSec: number; shots: number[]; landing: number | null; focus: { x: number; y: number } | null; fps: number }): string {
  const pieces = o.shots.length + (o.landing != null ? 1 : 0);
  const norm = `fps=${o.fps},settb=AVTB,format=yuv420p,setsar=1`;
  const chains: string[] = [`[0:v]trim=0:${fx(o.mainSec)},setpts=PTS-STARTPTS,${norm}[v0]`, `[0:a]atrim=0:${fx(o.mainSec)},asetpts=PTS-STARTPTS[a0]`];
  o.shots.forEach((_, i) => {
    const input = i + 1;
    chains.push(
      // Black and white with grain and dark edges: it reads as a flashback; the landing comes back in colour
      `[${input}:v]trim=duration=${fx(RECAP_SHOT_SEC)},setpts=(PTS-STARTPTS)/${RECAP_SPEED},${norm},${pushIn(0.07 / RECAP_SHOT_OUT_SEC, null)},${RECAP_LOOK},${norm}[v${input}]`,
      // The shots are silent: the recap's music bed carries them
      `[${input}:a]atrim=duration=${fx(RECAP_SHOT_SEC)},asetpts=PTS-STARTPTS,atempo=${RECAP_SPEED},volume=0[a${input}]`,
    );
  });
  if (o.landing != null) {
    const n = o.shots.length + 1;
    chains.push(
      `[${n}:v]trim=end_frame=1,setpts=PTS-STARTPTS,${norm},tpad=stop_mode=clone:stop_duration=${fx(RECAP_LANDING_SEC)},trim=duration=${fx(RECAP_LANDING_SEC)},` +
        `${pushIn(0.22 / RECAP_LANDING_SEC, o.focus)},${norm}[v${n}]`,
      `anullsrc=r=48000:cl=stereo,atrim=0:${fx(RECAP_LANDING_SEC)}[a${n}]`,
    );
  }
  // Crossfades: white into the recap, soft between its shots
  let vLabel = '[v0]';
  let aLabel = '[a0]';
  let length = o.mainSec;
  for (let i = 1; i <= pieces; i++) {
    const len = i <= o.shots.length ? RECAP_SHOT_OUT_SEC : RECAP_LANDING_SEC;
    const offset = length - RECAP_XFADE_SEC;
    const last = i === pieces;
    chains.push(
      `${vLabel}[v${i}]xfade=transition=${i === 1 ? 'fadewhite' : 'fade'}:duration=${fx(RECAP_XFADE_SEC)}:offset=${fx(offset)}${last ? '[rv]' : `[x${i}]`}`,
      `${aLabel}[a${i}]acrossfade=d=${fx(RECAP_XFADE_SEC)}${last ? '[ra]' : `[y${i}]`}`,
    );
    vLabel = `[x${i}]`;
    aLabel = `[y${i}]`;
    length = offset + len;
  }
  return chains.join(';');
}

// --------------------------------------------------------------------------
// The Short's timeline
// --------------------------------------------------------------------------

/** A cut-in ready to render: inside the Short, meme found, freeze stretched to its voice line. */
export interface TimedCutIn extends CutIn {
  /** Seconds into the trimmed clip (not the source). */
  relAt: number;
  /** When it starts in the Short (a ramp: when the slowed stretch starts). */
  outAt: number;
}

/**
 * The cut-ins that will play, in order, with voice lines on a freeze snapped onto it. Memes with
 * no file (none found) are left out; so is anything outside the trim.
 */
export function timeline(plan: Pick<ClipPlan, 'cutIns' | 'trimStart' | 'trimEnd' | 'voiceLines' | 'voiceover'>): { cutIns: TimedCutIn[]; voiceLines: VoiceLine[] } {
  const voiceLines = plan.voiceLines.map((l) => ({ ...l }));
  const cutIns: Array<Omit<TimedCutIn, 'outAt'>> = [];
  for (const c of sortCutIns(plan.cutIns ?? [])) {
    if (c.at <= plan.trimStart + 0.05 || c.at > plan.trimEnd) continue;
    // Anything inside a stretch that's cut out isn't in the Short
    if (c.kind !== 'skip' && insideSkip(c.at, plan.cutIns ?? [])) continue;
    if (c.kind === 'meme' && !c.meme) continue;
    const relAt = round(c.at - plan.trimStart);
    if (c.kind === 'skip') {
      // A cut-out takes time away: its length counts as negative, and it can't run past the end
      const skipSec = round(Math.min(c.skipSec ?? 0, plan.trimEnd - c.at - 0.5));
      if (skipSec < 0.5) continue;
      cutIns.push({ ...c, skipSec, durationSec: -skipSec, relAt });
      continue;
    }
    if (c.kind === 'ramp') {
      const replaySec = Math.min(c.replaySec ?? RAMP_SEC, relAt);
      if (replaySec < 0.3) continue;
      cutIns.push({ ...c, replaySec, durationSec: round(replaySec * (1 / REPLAY_SPEED - 1)), relAt });
      continue;
    }
    if (c.kind === 'replay') {
      const replaySec = Math.min(c.replaySec ?? REPLAY_SEC, relAt);
      if (replaySec < 0.4) continue;
      cutIns.push({ ...c, replaySec, durationSec: round(replaySec / REPLAY_SPEED), relAt });
      continue;
    }
    let durationSec = c.durationSec;
    if (c.kind === 'meme') durationSec = clamp(Math.min(durationSec, c.meme!.durationSec || durationSec), MIN_MEME_SEC, MAX_MEME_SEC);
    if (c.kind === 'freeze') {
      const line = plan.voiceover ? voiceLines.find((l) => Math.abs(l.at - c.at) <= FREEZE_SNAP_SEC) : undefined;
      if (line) {
        // The record scratch opens the freeze; the line comes in just after it, so its first word isn't lost
        line.at = c.at;
        line.offsetSec = FREEZE_VOICE_DELAY_SEC;
        if (line.durationSec) durationSec = Math.max(durationSec, FREEZE_VOICE_DELAY_SEC + line.durationSec + 0.35);
      }
      durationSec = Math.min(durationSec, MAX_FREEZE_SEC);
    }
    cutIns.push({ ...c, durationSec: round(durationSec), relAt });
  }
  const timed: TimedCutIn[] = [];
  for (const c of cutIns) {
    const start = c.kind === 'ramp' ? c.relAt - (c.replaySec ?? RAMP_SEC) : c.relAt;
    timed.push({ ...c, outAt: round(outputTime(start + plan.trimStart, plan.trimStart, timed)) });
  }
  return { cutIns: timed, voiceLines };
}

/**
 * Where a moment of the source lands in the Short. Cut-ins placed before it push it later; a moment
 * exactly at a cut-in lands at the cut-in's start (so a voice line on a freeze is spoken over it); a
 * moment inside a ramp is stretched with it.
 */
export function outputTime(sourceSec: number, trimStart: number, cutIns: Array<Pick<TimedCutIn, 'relAt' | 'durationSec' | 'kind' | 'replaySec'>>): number {
  const rel = sourceSec - trimStart;
  let out = rel;
  for (const c of cutIns) {
    if (c.kind === 'ramp') {
      const len = c.replaySec ?? RAMP_SEC;
      if (rel >= c.relAt - 1e-6) out += c.durationSec;
      else if (rel > c.relAt - len) out += (rel - (c.relAt - len)) * (1 / REPLAY_SPEED - 1);
    } else if (c.kind === 'skip') {
      // Moments after a cut-out come sooner; moments inside it land on the cut
      const len = -c.durationSec;
      if (rel >= c.relAt + len) out -= len;
      else if (rel > c.relAt) out -= rel - c.relAt;
    } else if (c.relAt < rel - 1e-6) out += c.durationSec;
  }
  return out;
}

/** Whether a moment of the source falls inside a cut-out (so it isn't in the Short at all). */
export const insideSkip = (sourceSec: number, cutIns: Array<Pick<CutIn, 'kind' | 'at' | 'skipSec'>>) =>
  cutIns.some((c) => c.kind === 'skip' && sourceSec > c.at + 0.02 && sourceSec < c.at + (c.skipSec ?? 0) - 0.02);

export const shortDuration = (clipSec: number, cutIns: Array<Pick<TimedCutIn, 'durationSec'>>, endingSec = 0) => clipSec + cutIns.reduce((s, c) => s + c.durationSec, 0) + endingSec;

// --------------------------------------------------------------------------
// Filter graph (pure, so it can be checked without ffmpeg)
// --------------------------------------------------------------------------

const fx = (n: number) => n.toFixed(3);
const NORM = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';

/** One piece of the Short, in order. */
export type Part =
  | { kind: 'clip'; from: number; to: number; holdSec: number; gain?: number; zoom?: number }
  | { kind: 'replay'; from: number; to: number }
  | { kind: 'ramp'; from: number; to: number }
  | { kind: 'meme'; input: number; durationSec: number; hasAudio: boolean };

/**
 * The clip cut at each cut-in, with the cut-ins in between. A freeze (and the ending) holds the
 * last frame of the piece before it; a ramp plays its stretch at half speed.
 */
export function parts(clipSec: number, cutIns: TimedCutIn[], memeInputs: Map<TimedCutIn, number>, endingSec = 0, recap: Part[] = []): Part[] {
  const out: Part[] = [];
  let cursor = 0;
  for (const c of cutIns) {
    const at = Math.min(c.relAt, clipSec);
    if (c.kind === 'ramp') {
      const from = Math.max(cursor, at - (c.replaySec ?? RAMP_SEC));
      if (from - cursor > 0.04) out.push({ kind: 'clip', from: cursor, to: from, holdSec: 0 });
      out.push({ kind: 'ramp', from, to: at });
      cursor = at;
      continue;
    }
    if (at - cursor > 0.04) out.push({ kind: 'clip', from: cursor, to: at, holdSec: 0 });
    cursor = Math.max(cursor, at);
    if (c.kind === 'skip') {
      cursor = Math.min(clipSec, at + (c.skipSec ?? 0));
      continue;
    }
    if (c.kind === 'freeze' || c.kind === 'skull') {
      const last = out[out.length - 1];
      if (last?.kind === 'clip') last.holdSec += c.durationSec;
    } else if (c.kind === 'replay') out.push({ kind: 'replay', from: Math.max(0, at - (c.replaySec ?? REPLAY_SEC)), to: at });
    else out.push({ kind: 'meme', input: memeInputs.get(c)!, durationSec: c.durationSec, hasAudio: c.meme?.hasAudio ?? false });
  }
  if (clipSec - cursor > 0.04) out.push({ kind: 'clip', from: cursor, to: clipSec, holdSec: 0 });
  out.push(...recap);
  if (endingSec > 0 && !recap.length) {
    const last = out[out.length - 1];
    if (last?.kind === 'clip') last.holdSec += endingSec;
    else out.push({ kind: 'clip', from: Math.max(0, clipSec - 0.04), to: clipSec, holdSec: endingSec });
  }
  return out;
}

const SIZE = { w: 1080, h: 1920 };

/** Fit a picture over a blurred, darkened copy of itself, full frame. */
const fitOverBlur = (inLabel: string, outLabel: string, tag: string) =>
  `${inLabel}split=2[${tag}bg][${tag}fg];` +
  `[${tag}bg]scale=${SIZE.w}:${SIZE.h}:force_original_aspect_ratio=increase,crop=${SIZE.w}:${SIZE.h},gblur=sigma=30,eq=brightness=-0.15[${tag}bgb];` +
  `[${tag}fg]scale=${SIZE.w}:${SIZE.h}:force_original_aspect_ratio=decrease,setsar=1[${tag}fgs];` +
  `[${tag}bgb][${tag}fgs]overlay=(W-w)/2:(H-h)/2,setsar=1${outLabel}`;

/** The clip, its cut-ins and its sound, joined into [cv] and [ca]. `base` is the clip already laid out at 1080x1920. */
export function joinGraph(options: { base: string; parts: Part[]; hasAudio: boolean; clipSec: number; muteExpr: string; fps: number }): string {
  const { parts: ps, fps } = options;
  const clipParts = ps.filter((p) => p.kind !== 'meme');
  const chains: string[] = [options.base];
  const n = clipParts.length;
  chains.push(n > 1 ? `[base]split=${n}${clipParts.map((_, i) => `[b${i}]`).join('')}` : `[base]null[b0]`);
  chains.push(
    options.hasAudio
      ? `[0:a]${NORM},volume='${options.muteExpr}':eval=frame${n > 1 ? `,asplit=${n}${clipParts.map((_, i) => `[g${i}]`).join('')}` : '[g0]'}`
      : `anullsrc=r=48000:cl=stereo,atrim=0:${fx(options.clipSec)}${n > 1 ? `,asplit=${n}${clipParts.map((_, i) => `[g${i}]`).join('')}` : '[g0]'}`,
  );
  let k = 0;
  const pairs: string[] = [];
  const slow = `setpts=${fx(1 / REPLAY_SPEED)}*(PTS-STARTPTS),fps=${fps}`;
  for (const [i, p] of ps.entries()) {
    if (p.kind === 'clip') {
      const hold = p.holdSec > 0 ? `,tpad=stop_mode=clone:stop_duration=${fx(p.holdSec)}` : '';
      const zoom = p.zoom && p.zoom > 1 ? `,crop=iw/${p.zoom}:ih/${p.zoom},scale=${SIZE.w}:${SIZE.h},setsar=1` : '';
      chains.push(`[b${k}]trim=start=${fx(p.from)}:end=${fx(p.to)},setpts=PTS-STARTPTS${zoom}${hold}[pv${i}]`);
      chains.push(`[g${k}]atrim=start=${fx(p.from)}:end=${fx(p.to)},asetpts=PTS-STARTPTS${p.gain != null ? `,volume=${p.gain}` : ''}${p.holdSec > 0 ? `,apad=pad_dur=${fx(p.holdSec)}` : ''}[pa${i}]`);
      k++;
    } else if (p.kind === 'replay') {
      chains.push(`[b${k}]trim=start=${fx(p.from)}:end=${fx(p.to)},${slow}[pv${i}]`);
      chains.push(`[g${k}]atrim=start=${fx(p.from)}:end=${fx(p.to)},asetpts=PTS-STARTPTS,atempo=${REPLAY_SPEED},volume=0.8[pa${i}]`);
      k++;
    } else if (p.kind === 'ramp') {
      // Slowed sound drops in pitch too: the deep "slow-mo" sound
      chains.push(`[b${k}]trim=start=${fx(p.from)}:end=${fx(p.to)},${slow}[pv${i}]`);
      chains.push(`[g${k}]atrim=start=${fx(p.from)}:end=${fx(p.to)},asetpts=PTS-STARTPTS,asetrate=${48000 * REPLAY_SPEED},aresample=48000[pa${i}]`);
      k++;
    } else {
      chains.push(fitOverBlur(`[${p.input}:v]fps=${fps},`, `,format=yuv420p,trim=duration=${fx(p.durationSec)},setpts=PTS-STARTPTS[pv${i}]`, `m${i}`));
      chains.push(
        p.hasAudio
          ? `[${p.input}:a]${NORM},apad,atrim=0:${fx(p.durationSec)},asetpts=PTS-STARTPTS[pa${i}]`
          : `anullsrc=r=48000:cl=stereo,atrim=0:${fx(p.durationSec)}[pa${i}]`,
      );
    }
    pairs.push(`[pv${i}][pa${i}]`);
  }
  chains.push(`${pairs.join('')}concat=n=${ps.length}:v=1:a=1[cv][ca]`);
  return chains.join(';');
}

const SHAKE_SEC = 0.5;
const SHAKE_PX = 18;

/** A short shake: the picture jitters around a slightly enlarged frame, dying away over half a second. */
export function shakeFilter(times: number[], size = SIZE): string | null {
  if (!times.length) return null;
  const a = SHAKE_PX;
  const term = (fn: 'sin' | 'cos', hz: number) => times.map((t) => `${fn}(2*PI*${hz}*(t-${fx(t)}))*exp(-7*(t-${fx(t)}))*between(t,${fx(t)},${fx(t + SHAKE_SEC)})`).join('+');
  return `crop=w=iw-${2 * a}:h=ih-${2 * a}:x='${a}+${a}*(${term('sin', 13)})':y='${a}+${a}*(${term('cos', 11)})',scale=${size.w}:${size.h},setsar=1`;
}

/** A flash on a hit (red by default; white between recap cuts): strong for two frames, then fading. */
export function flashFilter(times: number[], colour: 'red' | 'white' = 'red'): string | null {
  if (!times.length) return null;
  const [strong, soft] = colour === 'white' ? [0.55, 0.22] : [0.42, 0.2];
  return times
    .flatMap((t) => [
      `drawbox=x=0:y=0:w=iw:h=ih:color=${colour}@${strong}:t=fill:enable='between(t,${fx(t)},${fx(t + 0.07)})'`,
      `drawbox=x=0:y=0:w=iw:h=ih:color=${colour}@${soft}:t=fill:enable='between(t,${fx(t + 0.07)},${fx(t + 0.16)})'`,
    ])
    .join(',');
}

const enableAny = (windows: Array<{ from: number; to: number }>) => `enable='${windows.map((w) => `between(t,${fx(w.from)},${fx(w.to)})`).join('+')}'`;

/** The skull look: grey, darker, harder, with dark edges. */
export function skullLookFilter(windows: Array<{ from: number; to: number }>): string | null {
  if (!windows.length) return null;
  const on = enableAny(windows);
  return `hue=s=0:${on},eq=brightness=-0.1:contrast=1.2:${on},vignette=angle=PI/3.2:${on}`;
}

/** The comic-dot flash's picture: black and white, very hard (the dots are laid over it). */
export function comicFilter(windows: Array<{ from: number; to: number }>): string | null {
  if (!windows.length) return null;
  const on = enableAny(windows);
  return `hue=s=0:${on},eq=contrast=1.9:brightness=0.06:${on}`;
}

/** A whip: a quick sideways motion blur either side of each cut. */
export function whipFilter(times: number[]): string | null {
  if (!times.length) return null;
  return `dblur=angle=0:radius=55:${enableAny(times.map((t) => ({ from: Math.max(0, t - 0.07), to: t + 0.09 })))}`;
}

/** Punchier colour for the whole Short. */
export const GRADE_FILTER = 'eq=contrast=1.1:saturation=1.3:gamma=0.97,unsharp=5:5:0.55,vignette=angle=PI/5';

/** The look of the ending over its stretch: sepia for "to be continued", black for credits, black-and-white for a stamp. */
export function endingFilter(style: EndingStyle, from: number, to: number): string | null {
  const on = `enable='between(t,${fx(from)},${fx(to)})'`;
  if (style === 'tbc') return `colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131:${on},eq=contrast=1.08:${on}`;
  if (style === 'credits') return `drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:${on}`;
  if (style === 'stamp') return `hue=s=0:${on},eq=contrast=1.25:brightness=-0.05:${on}`;
  if (style === 'skull') return skullLookFilter([{ from, to }]);
  return null;
}

/**
 * A punch-in aimed at a spot (output pixels) instead of the centre: the visible window is kept
 * centred on it as far as the frame allows.
 */
export function zoomWindow(focus: { x: number; y: number } | null): { x: string; y: string } {
  if (!focus) return { x: 'iw/2-(iw/zoom/2)', y: 'ih/2-(ih/zoom/2)' };
  return { x: `max(0,min(iw-iw/zoom,${fx(focus.x)}-iw/zoom/2))`, y: `max(0,min(ih-ih/zoom,${fx(focus.y)}-ih/zoom/2))` };
}

/** Where a point of the source picture lands in the 1080x1920 frame for a layout. */
export function framePoint(layout: ClipLayout, width: number, height: number, p: FramePoint): { x: number; y: number } {
  if (!(width > 0 && height > 0)) return { x: SIZE.w * p.x, y: SIZE.h * p.y };
  const s = layout === 'crop' ? Math.max(SIZE.w / width, SIZE.h / height) : Math.min(SIZE.w / width, SIZE.h / height);
  const ox = (SIZE.w - width * s) / 2;
  const oy = (SIZE.h - height * s) / 2;
  return { x: Math.round(ox + p.x * width * s), y: Math.round(oy + p.y * height * s) };
}

/** The game sound lowered under voice lines (times on the Short's clock). */
export function duckExpression(spans: Array<{ start: number; end: number }>, gain = 0.28): string {
  return spans.length ? spans.map((s) => `if(between(t,${fx(s.start)},${fx(s.end)}),${gain},1)`).join('*') : '1';
}

/** Mixes the joined sound [ca] with voice lines and sound effects into [a]. */
export function mixGraph(options: { durationSec: number; duck: Array<{ start: number; end: number }>; voices: Array<{ input: number; atSec: number }>; sfx: Array<{ input: number; atSec: number; volume: number; lengthSec?: number }>; fadeOut?: boolean }): string {
  const chains = [`[ca]volume='${duckExpression(options.duck)}':eval=frame[game]`];
  const labels = ['[game]'];
  for (const [i, v] of options.voices.entries()) {
    const ms = Math.max(0, Math.round(v.atSec * 1000));
    chains.push(`[${v.input}:a]${NORM},adelay=${ms}|${ms},volume=1.3[vo${i}]`);
    labels.push(`[vo${i}]`);
  }
  for (const [i, s] of options.sfx.entries()) {
    const ms = Math.max(0, Math.round(s.atSec * 1000));
    // A sound with a length (a music bed) is cut there, with a short fade so it doesn't click
    const cut = s.lengthSec ? `,atrim=0:${fx(s.lengthSec)},afade=t=in:st=0:d=0.15,afade=t=out:st=${fx(Math.max(0, s.lengthSec - 0.3))}:d=0.3` : '';
    chains.push(`[${s.input}:a]${NORM}${cut},adelay=${ms}|${ms},volume=${s.volume}[fx${i}]`);
    labels.push(`[fx${i}]`);
  }
  const fadeOut = Math.max(0, options.durationSec - 0.3);
  // A hard cut at the end (a few milliseconds of fade only, to avoid a click) unless a fade-out is asked for
  const fades = options.fadeOut ? `afade=t=in:st=0:d=0.1,afade=t=out:st=${fx(fadeOut)}:d=0.3` : `afade=t=in:st=0:d=0.03,afade=t=out:st=${fx(Math.max(0, options.durationSec - 0.04))}:d=0.04`;
  const finish = `alimiter=limit=0.95:level=disabled,${fades}[a]`;
  chains.push(labels.length > 1 ? `${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=first:dropout_transition=0,${finish}` : `[game]${finish}`);
  return chains.join(';');
}

// --------------------------------------------------------------------------
// Pictures drawn by the browser (header box, circle and arrow, emoji, ending cards)
// --------------------------------------------------------------------------

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const EMOJI_FONTS = `'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji'`;

/** The header's text as HTML, with the red words wrapped. */
export function headerHtml(header: HeaderBox): string {
  let html = escapeHtml(header.text);
  for (const word of header.highlight) {
    const w = escapeHtml(word);
    html = html.replace(new RegExp(`(^|[^\\p{L}\\p{N}>])(${escapeRe(w)})(?=$|[^\\p{L}\\p{N}])`, 'iu'), '$1<span class="hl">$2</span>');
  }
  return html;
}

const page = (body: string, css: string, width = SIZE.w) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;width:${width}px}${css}</style></head><body>${body}</body></html>`;

/** A page with just the box, drawn by the browser (colour emoji included) and captured as a PNG. */
export function headerDocument(header: HeaderBox, fontName?: string): string {
  const len = header.text.length;
  const size = len > 70 ? 50 : len > 45 ? 56 : 62;
  const font = `${fontName ? `'${fontName}', ` : ''}'Segoe UI', 'Helvetica Neue', Arial, ${EMOJI_FONTS}, sans-serif`;
  return page(
    `<div id="box">${headerHtml(header)}</div>`,
    `#box{box-sizing:border-box;margin:0 40px;padding:26px 38px 30px;background:#fff;border-radius:22px;
  box-shadow:0 10px 30px rgba(0,0,0,.35);color:#0b0b0b;font-family:${font};font-weight:800;
  font-size:${size}px;line-height:1.18;text-align:center;letter-spacing:-0.5px;word-wrap:break-word}
.hl{color:#e8202a}`,
  );
}

/** A red circle on a spot of the full frame, with a thick arrow pointing at it from above. */
export function circleDocument(at: { x: number; y: number }): string {
  const r = 105;
  const fromLeft = at.x > SIZE.w / 2;
  const sx = clamp(at.x + (fromLeft ? -300 : 300), 60, SIZE.w - 60);
  const sy = clamp(at.y - 300, 60, SIZE.h - 60);
  const ang = Math.atan2(at.y - sy, at.x - sx);
  const ex = at.x - Math.cos(ang) * (r + 18);
  const ey = at.y - Math.sin(ang) * (r + 18);
  const head = (da: number) => `${(ex - Math.cos(ang + da) * 60).toFixed(1)},${(ey - Math.sin(ang + da) * 60).toFixed(1)}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE.w}" height="${SIZE.h}" viewBox="0 0 ${SIZE.w} ${SIZE.h}">
<g fill="none" stroke-linecap="round" stroke-linejoin="round">
<circle cx="${at.x}" cy="${at.y}" r="${r}" stroke="#000" stroke-opacity=".45" stroke-width="22"/>
<circle cx="${at.x}" cy="${at.y}" r="${r}" stroke="#ff1f2d" stroke-width="13"/>
<path d="M${sx},${sy} L${ex.toFixed(1)},${ey.toFixed(1)} M${head(0.5)} L${ex.toFixed(1)},${ey.toFixed(1)} L${head(-0.5)}" stroke="#000" stroke-opacity=".45" stroke-width="30"/>
<path d="M${sx},${sy} L${ex.toFixed(1)},${ey.toFixed(1)} M${head(0.5)} L${ex.toFixed(1)},${ey.toFixed(1)} L${head(-0.5)}" stroke="#ff1f2d" stroke-width="18"/>
</g></svg>`;
  return page(svg, `body{height:${SIZE.h}px}svg{display:block}`);
}

/** A full-frame grid of black dots, laid over a comic flash. */
export function dotsDocument(): string {
  return page('<div id="d"></div>', `body{height:${SIZE.h}px}#d{width:${SIZE.w}px;height:${SIZE.h}px;background-image:radial-gradient(circle,rgba(0,0,0,.78) 34%,transparent 37%);background-size:16px 16px}`);
}

/** One big emoji, for a pop-up. */
export function emojiDocument(emoji: string, size = 230): string {
  return page(`<div id="e">${escapeHtml(emoji)}</div>`, `#e{width:${Math.round(size * 1.4)}px;height:${Math.round(size * 1.4)}px;display:flex;align-items:center;justify-content:center;font-size:${size}px;line-height:1;font-family:${EMOJI_FONTS},sans-serif;filter:drop-shadow(0 8px 14px rgba(0,0,0,.45))}`, 320);
}

/** A library emoji picture (as a data URL), sized like a typed one. */
export function emojiImageDocument(dataUrl: string, size = 250): string {
  const box = Math.round(size * 1.3);
  return page(`<div id="e"><img src="${dataUrl}"></div>`, `#e{width:${box}px;height:${box}px;display:flex;align-items:center;justify-content:center}#e img{max-width:${size}px;max-height:${size}px;filter:drop-shadow(0 8px 14px rgba(0,0,0,.45))}`, box);
}

/** The ending's card: an arrow banner, a red stamp, or white credit lines (the size of the full frame for credits). */
export function endingDocument(style: Exclude<EndingStyle, 'none'>, text: string): string {
  const t = escapeHtml(text);
  if (style === 'tbc') {
    return page(
      `<div id="c"><span>${t}</span></div>`,
      `#c{display:inline-flex;align-items:center;height:118px;padding:0 120px 0 44px;background:#3b2a12;color:#f3e3b5;
  font:italic 900 54px/1 'Georgia','Times New Roman',serif;letter-spacing:2px;border:5px solid #f3e3b5;
  clip-path:polygon(0 0,calc(100% - 70px) 0,100% 50%,calc(100% - 70px) 100%,0 100%);box-shadow:0 8px 20px rgba(0,0,0,.4)}`,
      900,
    );
  }
  if (style === 'stamp') {
    return page(
      `<div id="s">${t}</div>`,
      `#s{margin:40px auto;width:fit-content;max-width:820px;padding:18px 40px;border:12px solid #e3141f;outline:5px solid #e3141f;outline-offset:8px;
  color:#e3141f;font:900 112px/1.02 'Impact','Arial Black',sans-serif;text-transform:uppercase;text-align:center;transform:rotate(-11deg);
  opacity:.93;text-shadow:0 0 2px rgba(227,20,31,.6)}`,
      1000,
    );
  }
  const lines = t.split('\n').map((l, i) => `<div class="${i === 0 && t.includes('\n') ? 'k' : 'v'}">${l}</div>`).join('');
  return page(
    `<div id="cr">${lines}</div>`,
    `body{height:${SIZE.h}px}#cr{height:${SIZE.h}px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;color:#fff;
  font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif;text-align:center}.k{font-size:54px;font-weight:400;letter-spacing:1px}.v{font-size:84px;font-weight:700;letter-spacing:3px}`,
  );
}

/** Where the header sits: just above the clip when the clip doesn't fill the screen, else near the top. */
export function headerY(layout: ClipPlan['layout'], width: number, height: number, boxHeight: number): number {
  const top = 230;
  if (layout === 'crop' || !(width > 0 && height > 0)) return top;
  const clipH = Math.min(SIZE.h, Math.round((SIZE.w * height) / width));
  const clipTop = Math.round((SIZE.h - clipH) / 2);
  return Math.max(top, clipTop - boxHeight - 18);
}

/** The clip's band on screen (top and bottom, px): where emoji and stamps go. */
export function clipBand(layout: ClipLayout, width: number, height: number): { top: number; bottom: number } {
  if (layout === 'crop' || !(width > 0 && height > 0)) return { top: 420, bottom: 1400 };
  const clipH = Math.min(SIZE.h, Math.round((SIZE.w * height) / width));
  const top = Math.round((SIZE.h - clipH) / 2);
  return { top, bottom: top + clipH };
}
