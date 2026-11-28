import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { descriptionFooter, type ChannelProfile } from '@/lib/channel/profile';
import { ensureSoundLibrary, soundPath } from '../assembly/sfx';
import { levelAudioInPlace } from '../assembly/level-audio';
import { getFfmpegPath } from '../utils/ffmpeg';
import { renderPictures } from '../clipping/reaction-render';
import { emojiImageDataUrl, findEmojiImage, isEmojiChar } from '../clipping/emojis';
import { voiceLines } from '../clipping/voice';
import { findSound } from '../clipping/sounds';
import type { VoiceLine } from '../clipping/types';
import { captionAss, cardDocument, chapterDocument, labelDocument, noteDocument, titleDocument } from './look';
import { mixBus, renderBaseTrack, type BasePicture } from './base';
import { guideFile, probeFootage, sharedLogo } from './store';
import { elevenLabsTts } from '../providers/tts/elevenlabs';
import { chapterList, clockTime } from './timeline';
import { alignWords, cardWindows, FPS, frameSize, voiceText, motionWindows, parseMarkup, planGuide, spokenParts, toFrames, WASTED_HIT_SEC, type Segment, type TimedWord } from './timeline';
import { motionConfig, prepareMotionClip, renderMotion, SOCIAL_PLAYERS } from './motion';
import type { FootageInfo, GuideProject, GuideVoice } from './types';

const execFileAsync = promisify(execFile);
const fx = (n: number) => n.toFixed(3);
const shortHash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 8);
const NORM = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
/** Where the title sits (with a logo above it, higher), and the item cards (top of the picture). */
const TITLE_Y = 520;
const TITLE_WITH_LOGO_Y = 260;
/** How long a social post's big opening hook text stays up before it settles into the post's caption. */
const SOCIAL_HOOK_SEC = 1.95;
const CARD_Y = 140;
/** Wide videos: how long a chapter card stays up, and a note at the top left. */
const WIDE_CARD_SEC = 2.8;
const NOTE_SEC = 4.5;

/**
 * Voices every spoken part (hook, items, outro, loop line) with the channel's voice, keeping parts
 * already voiced with the same text, voice and speed.
 */
export async function voiceGuide(dir: string, p: GuideProject, channelVoice: string): Promise<{ voiced: GuideVoice[]; warnings: string[] }> {
  const parts = spokenParts(p);
  const before = new Map((p.voiced ?? []).map((v) => [v.part, v]));
  const eleven = p.voiceEngine === 'elevenlabs';
  let engine: Parameters<typeof voiceLines>[4];
  if (eleven) {
    const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
    if (!apiKey) throw new Error('This guide is voiced by ElevenLabs, but ELEVENLABS_API_KEY is not set in .env.local');
    if (!p.voice) throw new Error('This guide is voiced by ElevenLabs: set "voice" to an ElevenLabs voice id');
    engine = { provider: elevenLabsTts, ctx: { apiKey, model: p.voiceModel || 'eleven_v3', options: {} } };
  }
  const lines: VoiceLine[] = parts.map((x) => {
    const text = voiceText(x.text, eleven);
    const old = before.get(x.part);
    return {
      at: 0,
      text,
      slot: 'other',
      ...(old && old.text === text ? { audioFile: old.audioFile, audioKey: old.audioKey, durationSec: old.durationSec, words: old.words } : {}),
    };
  });
  const result = await voiceLines(dir, lines, eleven ? p.voice : p.voice || channelVoice, p.speed, engine);
  return {
    voiced: result.lines.map((l, i) => ({ part: parts[i].part, text: l.text, audioFile: l.audioFile, audioKey: l.audioKey, durationSec: l.durationSec, words: l.words })),
    warnings: result.warnings,
  };
}

/** The guide's captions: every part's marked words with the voice's timings, on the Short's clock. */
export function guideWords(p: GuideProject, segments: Segment[], voiced: GuideVoice[]): TimedWord[] {
  const parts = new Map(spokenParts(p).map((x) => [x.part, x.text]));
  const out: TimedWord[] = [];
  for (const s of segments) {
    const marked = parseMarkup(parts.get(s.part) ?? '').words;
    const v = voiced.find((x) => x.part === s.part);
    const spoken = v?.words?.length ? v.words : [];
    const sec = v?.durationSec ?? s.durationSec;
    for (const w of alignWords(marked, spoken, sec)) out.push({ ...w, start: Number((s.start + w.start).toFixed(3)), end: Number((s.start + w.end).toFixed(3)) });
  }
  return out;
}

/**
 * Renders a guide Short: its footage cut to the voice and cropped to vertical, the title over the
 * opening shot, a card as each item starts, captions, the narrator over the game's own sound (low),
 * a whoosh into each item, then levelled to the feed's loudness. The end runs into the start.
 */
export async function renderGuide(dir: string, p: GuideProject, channel?: ChannelProfile): Promise<{ video: string; thumbnail: string; durationSec: number; warnings: string[] }> {
  const voiced = p.voiced ?? [];
  const spokenSec = (part: string) => {
    const v = voiced.find((x) => x.part === part);
    if (v?.durationSec) return v.durationSec;
    return Math.max(0.6, parseMarkup(spokenParts(p).find((x) => x.part === part)?.text ?? '').words.length / (3 * p.speed));
  };
  const plan = planGuide(p, (part) => spokenSec(part));
  const { segments, durationSec } = plan;
  const warnings = [...plan.warnings];
  if (!segments.length) throw new Error('The guide has nothing to say');

  const wide = p.format === 'wide';
  const { w: W, h: H } = frameSize(p.format);
  // Footage sizes
  const files = [...new Set(segments.flatMap((s) => s.cuts.flatMap((c) => [c.file, ...(c.beside ? [c.beside.file] : [])])))];
  const footage = new Map<string, FootageInfo>();
  for (const f of files) {
    try {
      footage.set(f, await probeFootage(guideFile(dir, f)));
    } catch (err) {
      throw new Error(`Footage ${f} can't be read: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (!wide) for (const [f, info] of footage) if (Math.min(info.width, info.height) < 1080 && info.width > info.height) warnings.push(`${f} is ${info.width}x${info.height}: the vertical crop will look soft. Record in 1440p or 4K.`);

  await fs.mkdir(path.join(dir, 'export'), { recursive: true });
  const work = path.join(dir, 'render-pictures');
  await fs.mkdir(work, { recursive: true });

  // Captions (none under the title or a card: they say it already)
  const hook = segments.find((s) => s.kind === 'hook');
  // The title shows for titleSec (the whole hook when missing); the hook's words are captioned after it
  const titleEnd = hook ? Math.min(hook.start + hook.durationSec, p.titleSec && p.titleSec > 0 ? p.titleSec : Infinity) : 0;
  const cards = cardWindows(segments, p.items, wide ? WIDE_CARD_SEC : undefined);
  const quiet = [...(hook && p.titleCard.trim() ? [{ from: 0, to: titleEnd }] : []), ...cards.map((c) => ({ from: c.from, to: c.to }))];
  // A social post opens on its own big hook text (no captions over it), then the captions drop below the card
  const socials = motionWindows(p, segments).filter((w) => w.motion.kind === 'social');
  quiet.push(...socials.map((w) => ({ from: w.from, to: Math.min(w.to, w.from + SOCIAL_HOOK_SEC) })));
  const low = socials.map((w) => ({ from: w.from + SOCIAL_HOOK_SEC, to: w.to }));
  const assName = 'guide.ass';
  await fs.writeFile(path.join(dir, assName), captionAss(guideWords(p, segments, voiced), {
    durationSec,
    quiet,
    low,
    fontName: channel?.captionFont,
    width: W,
    height: H,
    ...(channel?.handleMark && channel.handle ? { mark: { text: `@${channel.handle}`, corner: channel.handleMarkCorner } } : {}),
  }), 'utf-8');

  // Where the cut sounds and the side-by-side labels fall
  const inputs: string[] = [];
  let next = 0;
  const chains: string[] = [];
  const cutSounds: Array<{ query: string; atSec: number }> = [];
  const besides: Array<{ from: number; to: number; labels: [string, string] }> = [];
  for (const s of segments) {
    let cutAt = s.start;
    for (const c of s.cuts) {
      const len = toFrames(c.outSec) / FPS;
      if (c.sound) cutSounds.push({ query: c.sound, atSec: cutAt });
      if (c.beside && c.labels) besides.push({ from: cutAt, to: cutAt + len, labels: c.labels });
      cutAt += len;
    }
  }

  // Pictures: the title (with the logo) over the hook, a card for each item (wide: chapter cards,
  // labels over side-by-sides, notes). They're drawn first, then burned into the footage part by part.
  const font = channel?.captionFont;
  const pictures: Array<BasePicture & { html: string }> = [];
  if (hook && p.titleCard.trim()) {
    const logoFile = p.logo ? guideFile(dir, p.logo) : sharedLogo();
    const logo = (await fs.stat(logoFile).then((s) => s.isFile()).catch(() => false)) ? await emojiImageDataUrl(logoFile) : null;
    if (p.logo && !logo) warnings.push(`The logo ${p.logo} isn't there; the title shows without it.`);
    const html = titleDocument(p.titleCard, logo, font);
    pictures.push({ file: path.join(work, 'title.png'), html, key: shortHash(html), from: 0, to: titleEnd, y: wide ? '(H-h)/2' : logo ? TITLE_WITH_LOGO_Y : TITLE_Y, fade: 0.12 });
  }
  if (wide) {
    for (const c of cards) {
      const html = chapterDocument(p.items[c.itemIndex].heading, font);
      pictures.push({ file: path.join(work, `card_${c.itemIndex}.png`), html, key: shortHash(html), from: c.from, to: c.to, y: '(H-h)/2', fade: 0.25 });
    }
    const labelFiles = new Map<string, { file: string; html: string }>();
    const label = (text: string, green: boolean) => {
      const k = `${green ? 'g' : 'w'}:${text}`;
      if (!labelFiles.has(k)) labelFiles.set(k, { file: path.join(work, `label_${labelFiles.size}.png`), html: labelDocument(text, font, green) });
      return labelFiles.get(k)!;
    };
    for (const b of besides) {
      const [l, r] = [label(b.labels[0], false), label(b.labels[1], true)];
      pictures.push({ ...l, key: shortHash(l.html), from: b.from, to: b.to, y: 36, x: '(W/2)-w-28', fade: 0.15 });
      pictures.push({ ...r, key: shortHash(r.html), from: b.from, to: b.to, y: 36, x: 'W-w-28', fade: 0.15 });
    }
    for (const s of segments) {
      const note = s.kind === 'item' ? p.items[s.itemIndex!].note?.trim() : '';
      if (!note) continue;
      const from = s.start + (p.items[s.itemIndex!].heading.trim() ? WIDE_CARD_SEC + 0.2 : 0.4);
      const to = Math.min(s.start + s.durationSec - 0.1, from + NOTE_SEC);
      if (to - from < 1) continue;
      const html = noteDocument(note, font);
      pictures.push({ file: path.join(work, `note_${s.itemIndex}.png`), html, key: shortHash(html), from, to, y: 64, slide: true, fade: 0.2 });
    }
  }
  for (const c of wide ? [] : cards) {
    const item = p.items[c.itemIndex];
    let emoji: { char?: string; dataUrl?: string } | null = null;
    const e = item.emoji?.trim();
    if (e && isEmojiChar(e.replace(/\s+/g, ''))) emoji = { char: e };
    else if (e) {
      const found = await findEmojiImage(e);
      if (found) emoji = { dataUrl: await emojiImageDataUrl(found) };
      else warnings.push(`No emoji picture named like "${e}" in the emoji library; item ${c.itemIndex + 1}'s card shows without one.`);
    }
    const html = cardDocument(item.heading, p.numbered ? c.itemIndex + 1 : null, emoji, font);
    pictures.push({ file: path.join(work, `card_${c.itemIndex}.png`), html, key: shortHash(html), from: c.from, to: c.to, y: CARD_Y });
  }
  const drawn = [...new Map(pictures.map((x) => [x.file, x])).values()];
  await renderPictures(drawn.map((x) => ({ file: x.file, html: x.html, crop: 'element' as const, selector: 'body > div' })), wide ? { width: W + 80, height: H } : undefined);

  // The footage as one track: rendered a part at a time, each cut with its own sound at its level,
  // in colour, with the pictures on top
  const base = await renderBaseTrack(dir, segments, footage, { width: W, height: H, gameVolume: p.gameVolume, grade: p.grade, pictures });
  inputs.push('-i', base);
  chains.push(`[${next}:v]null[cv]`, `[${next}:a]anull[ca]`);
  next++;

  // The narrator, and the sound effects, each laid out on one track
  const voiceLines: Array<{ file: string; atSec: number; volume: number }> = [];
  for (const s of segments) {
    const v = voiced.find((x) => x.part === s.part);
    if (v?.audioFile) voiceLines.push({ file: guideFile(dir, v.audioFile), atSec: s.start, volume: 1 });
  }
  const voices: Array<{ input: number; atSec: number }> = [];
  if (voiceLines.length) {
    const bus = path.join(work, 'voice-bus.wav');
    await mixBus(voiceLines, durationSec, bus);
    voices.push({ input: next++, atSec: 0 });
    inputs.push('-i', bus);
  } else warnings.push('Nothing is voiced yet: the Short has no narrator (is the Kokoro server running?).');
  const effects: Array<{ file: string; atSec: number; volume: number }> = [];
  if (p.whooshes) {
    await ensureSoundLibrary();
    for (const s of segments.filter((x) => x.kind === 'item' && p.items[x.itemIndex!].heading.trim())) effects.push({ file: soundPath('whoosh'), atSec: Math.max(0, s.start - 0.12), volume: 0.4 });
  }
  for (const cs of cutSounds) {
    const found = await findSound(dir, cs.query).catch(() => null);
    if (!found) {
      warnings.push(`No sound like "${cs.query}" in the sound library; that cut plays without it.`);
      continue;
    }
    effects.push({ file: guideFile(dir, found.file), atSec: cs.atSec, volume: 0.9 });
  }
  let music: { input: number; volume: number } | undefined;
  if (p.music) {
    music = { input: next++, volume: p.musicVolume ?? 1 };
    inputs.push('-stream_loop', '-1', ...(p.musicFrom ? ['-ss', fx(p.musicFrom)] : []), '-i', guideFile(dir, p.music));
  }

  // Motion graphics (gta-components): each rendered once to an overlay video, then laid over its moment
  const windows = motionWindows(p, segments).filter(() => !wide);
  if (wide && motionWindows(p, segments).length) warnings.push('The GTA motion graphics are drawn for vertical Shorts; a wide video leaves them out (use chapter cards, notes and side-by-side labels).');
  const motionLayers: Array<{ input: number; from: number; to: number }> = [];
  const greys: Array<{ from: number; to: number }> = [];
  let wastedSound: string | null | undefined;
  for (const w of windows) {
    const m = w.motion;
    const len = Number((w.to - w.from).toFixed(3));
    let media: { ids: string[]; file: string } | undefined;
    if (m.kind === 'social' && m.clip) {
      const src = guideFile(dir, m.clip.file);
      const info = footage.get(m.clip.file) ?? (await probeFootage(src));
      const clipFile = path.join(dir, 'motion', `clip-${w.itemIndex}-${w.index}-${shortHash(JSON.stringify([m.clip, len]))}.webm`);
      await fs.mkdir(path.dirname(clipFile), { recursive: true });
      if (!(await fs.stat(clipFile).then((s) => s.size > 0).catch(() => false))) await prepareMotionClip(src, info, m.clip, len + 0.5, clipFile);
      media = { ids: SOCIAL_PLAYERS, file: clipFile };
    }
    console.log(`[Guide] Motion graphic: ${m.kind} for item ${w.itemIndex + 1} at ${w.from.toFixed(2)} s`);
    const file = await renderMotion(dir, { kind: m.kind, variant: m.variant, plate: m.plate, durationSec: len, config: motionConfig(m.kind, len, m.config), ...(media ? { media } : {}) });
    motionLayers.push({ input: next++, from: w.from, to: w.to });
    inputs.push('-i', guideFile(dir, file));
    if (m.kind === 'wasted') {
      // The world drains to black and white under the word, with the game's wasted sound on the hit
      greys.push({ from: w.from + WASTED_HIT_SEC, to: w.to });
      if (wastedSound === undefined) wastedSound = (await findSound(dir, 'gta wasted').catch(() => null))?.file ?? null;
      if (wastedSound) effects.push({ file: guideFile(dir, wastedSound), atSec: w.from + WASTED_HIT_SEC, volume: 0.9 });
    }
  }
  const sfx: Array<{ input: number; atSec: number; volume: number }> = [];
  if (effects.length) {
    const bus = path.join(work, 'sfx-bus.wav');
    await mixBus(effects, durationSec, bus);
    sfx.push({ input: next++, atSec: 0, volume: 1 });
    inputs.push('-i', bus);
  }

  // Picture: the footage (already in colour, with its pictures), black and white under each WASTED,
  // the motion graphics, then the captions
  const greyFilter = greys.length ? `hue=s=0:enable='${greys.map((g) => `between(t,${fx(g.from)},${fx(g.to)})`).join('+')}',` : '';
  let label = '[mg0]';
  chains.push(`[cv]${greyFilter}null${label}`);
  for (const [k, l] of motionLayers.entries()) {
    const out = `[mg${k + 1}]`;
    chains.push(`[${l.input}:v]format=rgba,setpts=PTS-STARTPTS+${fx(l.from)}/TB[mo${k}];${label}[mo${k}]overlay=0:0:eof_action=pass:enable='between(t,${fx(l.from)},${fx(l.to)})'${out}`);
    label = out;
  }
  chains.push(`${label}ass=${assName},format=yuv420p[v]`);
  chains.push(guideMixGraph({ durationSec, voices, sfx, music }));

  const graphFile = path.join(dir, 'guide.filter');
  await fs.writeFile(graphFile, chains.join(';\n'), 'utf-8');
  const name = wide ? 'video' : 'short';
  const tmp = path.join(dir, 'export', `${name}.rendering.mp4`);
  const out = path.join(dir, 'export', `${name}.mp4`);
  try {
    await execFileAsync(
      getFfmpegPath(),
      [
        '-y', '-hide_banner', '-v', 'error', ...inputs,
        '-/filter_complex', graphFile,
        '-map', '[v]', '-map', '[a]',
        '-t', fx(durationSec),
        '-c:v', 'libx264', '-preset', 'faster', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS),
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', tmp,
      ],
      { cwd: dir, maxBuffer: 32 * 1024 * 1024, timeout: Number(process.env.GUIDE_TIMEOUT_MS) || 30 * 60_000 },
    );
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    throw new Error(`The render failed: ${(stderr || (err instanceof Error ? err.message : String(err))).trim().split('\n').slice(-3).join(' ').slice(0, 400)}`);
  } finally {
    // GUIDE_KEEP=1 keeps the graph, captions and pictures (to rerun the last step by hand)
    if (process.env.GUIDE_KEEP) await fs.writeFile(path.join(dir, 'guide.args.json'), JSON.stringify(inputs), 'utf-8');
    else {
      await fs.unlink(path.join(dir, assName)).catch(() => {});
      await fs.unlink(graphFile).catch(() => {});
      await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }
  await levelAudioInPlace(tmp);
  await fs.rename(tmp, out);

  // The thumbnail: a ready-made one when the guide has it, else the opening shot with its title
  const thumb = path.join(dir, 'export', 'thumbnail.jpg');
  const made = p.thumbnail ? guideFile(dir, p.thumbnail) : null;
  if (made && (await fs.stat(made).then((s) => s.isFile()).catch(() => false))) {
    await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', '-i', made, '-q:v', '2', thumb]);
  } else {
    if (made) warnings.push(`The thumbnail ${p.thumbnail} isn't there; a frame from the video is used instead.`);
    await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', '-ss', fx(Math.min(0.6, durationSec / 2)), '-i', out, '-frames:v', '1', '-q:v', '2', thumb]).catch(() => {});
  }
  if (channel) await writeGuideUploadInfo(dir, p, channel, wide ? chapterList(p, segments) : []);
  return { video: `export/${name}.mp4`, thumbnail: 'export/thumbnail.jpg', durationSec, warnings };
}

/** How loud the music bed sits once levelled (LUFS), before its volume and the ducking. */
export const MUSIC_LUFS = -27;

/**
 * The guide's sound, from [ca] (the game's own sound, already turned down): the narrator on top; the
 * game and the music ducking under the narrator whenever it speaks (a compressor keyed by the voice);
 * the music levelled first, so a track that swells halfway through stays put; sound effects as
 * they are; then a limiter and a hard cut at the end ([a]).
 */
export function guideMixGraph(o: {
  durationSec: number;
  voices: Array<{ input: number; atSec: number }>;
  sfx: Array<{ input: number; atSec: number; volume: number }>;
  music?: { input: number; volume: number };
}): string {
  const end = fx(o.durationSec);
  const ms = (sec: number) => Math.max(0, Math.round(sec * 1000));
  const ch: string[] = [];
  // The narrator: every line in place, as one bus, split to key the ducking (only as many copies as
  // are used: a copy sent nowhere, into anullsink, stalls ffmpeg's whole graph)
  const split = o.music ? 'asplit=3[voice][key1][key2]' : 'asplit=2[voice][key1]';
  if (o.voices.length) {
    for (const [k, v] of o.voices.entries()) ch.push(`[${v.input}:a]${NORM},adelay=${ms(v.atSec)}|${ms(v.atSec)},volume=1.3[vo${k}]`);
    ch.push(`${o.voices.map((_, k) => `[vo${k}]`).join('')}amix=inputs=${o.voices.length}:normalize=0:duration=longest,apad,atrim=0:${end},${split}`);
  } else ch.push(`anullsrc=r=48000:cl=stereo,atrim=0:${end},${split}`);
  ch.push(`[ca]apad,atrim=0:${end}[g0];[g0][key1]sidechaincompress=threshold=0.015:ratio=4:attack=15:release=350[game]`);
  const beds = ['[voice]', '[game]'];
  if (o.music) {
    ch.push(
      `[${o.music.input}:a]${NORM},atrim=0:${end},asetpts=PTS-STARTPTS,loudnorm=I=${MUSIC_LUFS}:LRA=3:TP=-6,aresample=48000,volume=${o.music.volume}[m0];` +
        `[m0][key2]sidechaincompress=threshold=0.015:ratio=8:attack=20:release=500[music]`,
    );
    beds.push('[music]');
  }
  for (const [k, s] of o.sfx.entries()) {
    ch.push(`[${s.input}:a]${NORM},adelay=${ms(s.atSec)}|${ms(s.atSec)},volume=${s.volume}[fx${k}]`);
    beds.push(`[fx${k}]`);
  }
  ch.push(
    `${beds.join('')}amix=inputs=${beds.length}:normalize=0:duration=first:dropout_transition=0,alimiter=limit=0.95:level=disabled,` +
      `afade=t=in:st=0:d=0.03,afade=t=out:st=${fx(Math.max(0, o.durationSec - 0.04))}:d=0.04[a]`,
  );
  return ch.join(';');
}

/**
 * export/upload-info.txt: the title and the description (the guide's own, else the title) with the
 * channel's footer and hashtags; a wide video's chapter list goes after the description's first
 * paragraph, where YouTube reads it as chapters.
 */
export async function writeGuideUploadInfo(dir: string, p: GuideProject, channel: ChannelProfile, chapters: Array<{ at: number; title: string }> = []): Promise<void> {
  const title = p.title.trim();
  const plainTitle = title.replace(/\s*#\S+/g, '').trim();
  const paragraphs = (p.description.trim() || plainTitle).split(/\n\s*\n/);
  if (chapters.length) paragraphs.splice(1, 0, ['Chapters:', ...chapters.map((c) => `${clockTime(c.at)} ${c.title}`)].join('\n'));
  const description = [paragraphs.join('\n\n'), descriptionFooter(channel, p.tags)].filter(Boolean).join('\n\n');
  await fs.writeFile(path.join(dir, 'export', 'upload-info.txt'), `TITLE\n${title}\n\nDESCRIPTION\n${description}\n`, 'utf-8');
}
