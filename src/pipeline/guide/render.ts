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
import { GRADE_FILTER } from '../clipping/reaction';
import { emojiImageDataUrl, findEmojiImage, isEmojiChar } from '../clipping/emojis';
import { voiceLines } from '../clipping/voice';
import { findSound } from '../clipping/sounds';
import type { VoiceLine } from '../clipping/types';
import { captionAss, cardDocument, titleDocument } from './look';
import { guideFile, probeFootage, sharedLogo } from './store';
import { alignWords, cardWindows, cropFor, FPS, motionWindows, parseMarkup, planGuide, SHORT_H, SHORT_W, spokenParts, toFrames, WASTED_HIT_SEC, type Segment, type TimedWord } from './timeline';
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

/**
 * Voices every spoken part (hook, items, outro, loop line) with the channel's voice, keeping parts
 * already voiced with the same text, voice and speed.
 */
export async function voiceGuide(dir: string, p: GuideProject, channelVoice: string): Promise<{ voiced: GuideVoice[]; warnings: string[] }> {
  const parts = spokenParts(p);
  const before = new Map((p.voiced ?? []).map((v) => [v.part, v]));
  const lines: VoiceLine[] = parts.map((x) => {
    const text = parseMarkup(x.text).plain;
    const old = before.get(x.part);
    return {
      at: 0,
      text,
      slot: 'other',
      ...(old && old.text === text ? { audioFile: old.audioFile, audioKey: old.audioKey, durationSec: old.durationSec, words: old.words } : {}),
    };
  });
  const result = await voiceLines(dir, lines, p.voice || channelVoice, p.speed);
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

  // Footage sizes
  const files = [...new Set(segments.flatMap((s) => s.cuts.map((c) => c.file)))];
  const footage = new Map<string, FootageInfo>();
  for (const f of files) {
    try {
      footage.set(f, await probeFootage(guideFile(dir, f)));
    } catch (err) {
      throw new Error(`Footage ${f} can't be read: ${err instanceof Error ? err.message : err}`);
    }
  }
  for (const [f, info] of footage) if (Math.min(info.width, info.height) < 1080 && info.width > info.height) warnings.push(`${f} is ${info.width}x${info.height}: the vertical crop will look soft. Record in 1440p or 4K.`);

  await fs.mkdir(path.join(dir, 'export'), { recursive: true });
  const work = path.join(dir, 'render-pictures');
  await fs.mkdir(work, { recursive: true });

  // Captions (none under the title or a card: they say it already)
  const hook = segments.find((s) => s.kind === 'hook');
  // The title shows for titleSec (the whole hook when missing); the hook's words are captioned after it
  const titleEnd = hook ? Math.min(hook.start + hook.durationSec, p.titleSec && p.titleSec > 0 ? p.titleSec : Infinity) : 0;
  const cards = cardWindows(segments);
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
    ...(channel?.handleMark && channel.handle ? { mark: { text: `@${channel.handle}`, corner: channel.handleMarkCorner } } : {}),
  }), 'utf-8');

  // Inputs: every cut (its own stretch of its recording), the voice, the sounds, then the pictures
  const inputs: string[] = [];
  let next = 0;
  const chains: string[] = [];
  const pieces: string[] = [];
  const cutSounds: Array<{ query: string; atSec: number }> = [];
  for (const s of segments) {
    let cutAt = s.start;
    for (const c of s.cuts) {
      const info = footage.get(c.file)!;
      const i = next++;
      inputs.push('-ss', fx(c.from), '-t', fx(c.srcSec + 0.2), '-i', guideFile(dir, c.file));
      const crop = cropFor(info, c.focusX, c.zoom, c.focusY);
      const frames = toFrames(c.outSec);
      const stretch = c.outSec / Math.max(0.01, c.srcSec);
      // A push: the picture creeps closer across the cut (on a near-still stretch, a freeze-frame that zooms in)
      const push = c.push ? `,zoompan=z='1+${c.push}*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${SHORT_W}x${SHORT_H}:fps=${FPS}` : '';
      chains.push(
        `[${i}:v]setpts=(PTS-STARTPTS)*${stretch.toFixed(4)},fps=${FPS},crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${SHORT_W}:${SHORT_H}:flags=lanczos,setsar=1,` +
          `tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${frames}${push},setpts=PTS-STARTPTS[v${i}]`,
      );
      if (c.sound) cutSounds.push({ query: c.sound, atSec: cutAt });
      cutAt += frames / FPS;
      chains.push(info.hasAudio ? `[${i}:a]${NORM},asetpts=PTS-STARTPTS,apad,atrim=duration=${fx(frames / FPS)},asetpts=PTS-STARTPTS[a${i}]` : `anullsrc=r=48000:cl=stereo,atrim=duration=${fx(frames / FPS)}[a${i}]`);
      pieces.push(`[v${i}][a${i}]`);
    }
  }
  chains.push(`${pieces.join('')}concat=n=${pieces.length}:v=1:a=1[cv][cg]`, `[cg]volume=${Math.max(0, Math.min(1, p.gameVolume))}[ca]`);

  const voices: Array<{ input: number; atSec: number }> = [];
  for (const s of segments) {
    const v = voiced.find((x) => x.part === s.part);
    if (!v?.audioFile) continue;
    voices.push({ input: next++, atSec: s.start });
    inputs.push('-i', guideFile(dir, v.audioFile));
  }
  if (!voices.length) warnings.push('Nothing is voiced yet: the Short has no narrator (is the Kokoro server running?).');
  const sfx: Array<{ input: number; atSec: number; volume: number; lengthSec?: number }> = [];
  if (p.whooshes) {
    await ensureSoundLibrary();
    for (const s of segments.filter((x) => x.kind === 'item')) {
      sfx.push({ input: next++, atSec: Math.max(0, s.start - 0.12), volume: 0.4 });
      inputs.push('-i', soundPath('whoosh'));
    }
  }
  for (const cs of cutSounds) {
    const found = await findSound(dir, cs.query).catch(() => null);
    if (!found) {
      warnings.push(`No sound like "${cs.query}" in the sound library; that cut plays without it.`);
      continue;
    }
    sfx.push({ input: next++, atSec: cs.atSec, volume: 0.9 });
    inputs.push('-i', guideFile(dir, found.file));
  }
  let music: { input: number; volume: number } | undefined;
  if (p.music) {
    music = { input: next++, volume: p.musicVolume ?? 1 };
    inputs.push('-stream_loop', '-1', ...(p.musicFrom ? ['-ss', fx(p.musicFrom)] : []), '-i', guideFile(dir, p.music));
  }

  // Motion graphics (gta-components): each rendered once to an overlay video, then laid over its moment
  const windows = motionWindows(p, segments);
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
      if (wastedSound) {
        sfx.push({ input: next++, atSec: w.from + WASTED_HIT_SEC, volume: 0.9 });
        inputs.push('-i', guideFile(dir, wastedSound));
      }
    }
  }

  // Pictures: the title (with the logo) over the hook, a card for each item
  const font = channel?.captionFont;
  const pictures: Array<{ file: string; html: string; from: number; to: number; y: number }> = [];
  if (hook && p.titleCard.trim()) {
    const logoFile = p.logo ? guideFile(dir, p.logo) : sharedLogo();
    const logo = (await fs.stat(logoFile).then((s) => s.isFile()).catch(() => false)) ? await emojiImageDataUrl(logoFile) : null;
    if (p.logo && !logo) warnings.push(`The logo ${p.logo} isn't there; the title shows without it.`);
    pictures.push({ file: path.join(work, 'title.png'), html: titleDocument(p.titleCard, logo, font), from: 0, to: titleEnd, y: logo ? TITLE_WITH_LOGO_Y : TITLE_Y });
  }
  for (const c of cards) {
    const item = p.items[c.itemIndex];
    let emoji: { char?: string; dataUrl?: string } | null = null;
    const e = item.emoji?.trim();
    if (e && isEmojiChar(e.replace(/\s+/g, ''))) emoji = { char: e };
    else if (e) {
      const found = await findEmojiImage(e);
      if (found) emoji = { dataUrl: await emojiImageDataUrl(found) };
      else warnings.push(`No emoji picture named like "${e}" in the emoji library; item ${c.itemIndex + 1}'s card shows without one.`);
    }
    pictures.push({ file: path.join(work, `card_${c.itemIndex}.png`), html: cardDocument(item.heading, p.numbered ? c.itemIndex + 1 : null, emoji, font), from: c.from, to: c.to, y: CARD_Y });
  }
  await renderPictures(pictures.map((x) => ({ file: x.file, html: x.html, crop: 'element' as const, selector: 'body > div' })));
  const pictureInputs = pictures.map((x) => {
    inputs.push('-loop', '1', '-framerate', String(FPS), '-t', fx(durationSec), '-i', x.file);
    return next++;
  });

  // Picture: (colour), black and white under each WASTED, the motion graphics, captions, then the title and cards
  const greyFilter = greys.length ? `hue=s=0:enable='${greys.map((g) => `between(t,${fx(g.from)},${fx(g.to)})`).join('+')}',` : '';
  let label = '[mg0]';
  chains.push(`[cv]${p.grade ? `${GRADE_FILTER},` : ''}${greyFilter}null${label}`);
  for (const [k, l] of motionLayers.entries()) {
    const out = `[mg${k + 1}]`;
    chains.push(`[${l.input}:v]format=rgba,setpts=PTS-STARTPTS+${fx(l.from)}/TB[mo${k}];${label}[mo${k}]overlay=0:0:eof_action=pass:enable='between(t,${fx(l.from)},${fx(l.to)})'${out}`);
    label = out;
  }
  chains.push(`${label}ass=${assName}[lk0]`);
  label = '[lk0]';
  for (const [k, x] of pictures.entries()) {
    const out = `[lk${k + 1}]`;
    chains.push(
      `[${pictureInputs[k]}:v]format=rgba,${x.from > 0 ? `fade=t=in:st=${fx(x.from)}:d=0.08:alpha=1,` : ''}fade=t=out:st=${fx(Math.max(x.from, x.to - 0.12))}:d=0.12:alpha=1[pic${k}];` +
        `${label}[pic${k}]overlay=x=(W-w)/2:y=${x.y}:enable='between(t,${fx(x.from)},${fx(x.to)})'${out}`,
    );
    label = out;
  }
  chains.push(`${label}format=yuv420p[v]`);
  chains.push(guideMixGraph({ durationSec, voices, sfx, music }));

  const graphFile = path.join(dir, 'guide.filter');
  await fs.writeFile(graphFile, chains.join(';\n'), 'utf-8');
  const tmp = path.join(dir, 'export', 'short.rendering.mp4');
  const out = path.join(dir, 'export', 'short.mp4');
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
      { cwd: dir, maxBuffer: 32 * 1024 * 1024, timeout: 30 * 60_000 },
    );
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    throw new Error(`The render failed: ${(stderr || (err instanceof Error ? err.message : String(err))).trim().split('\n').slice(-3).join(' ').slice(0, 400)}`);
  } finally {
    await fs.unlink(path.join(dir, assName)).catch(() => {});
    await fs.unlink(graphFile).catch(() => {});
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
  await levelAudioInPlace(tmp);
  await fs.rename(tmp, out);

  // The thumbnail: the opening shot with its title
  const thumb = path.join(dir, 'export', 'thumbnail.jpg');
  await execFileAsync(getFfmpegPath(), ['-y', '-v', 'error', '-ss', fx(Math.min(0.6, durationSec / 2)), '-i', out, '-frames:v', '1', '-q:v', '2', thumb]).catch(() => {});
  if (channel) await writeGuideUploadInfo(dir, p, channel);
  return { video: 'export/short.mp4', thumbnail: 'export/thumbnail.jpg', durationSec, warnings };
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

/** export/upload-info.txt: the title and the description (the guide's own, else the title) with the channel's footer and hashtags. */
export async function writeGuideUploadInfo(dir: string, p: GuideProject, channel: ChannelProfile): Promise<void> {
  const title = p.title.trim();
  const plainTitle = title.replace(/\s*#\S+/g, '').trim();
  const description = [p.description.trim() || plainTitle, descriptionFooter(channel, p.tags)].filter(Boolean).join('\n\n');
  await fs.writeFile(path.join(dir, 'export', 'upload-info.txt'), `TITLE\n${title}\n\nDESCRIPTION\n${description}\n`, 'utf-8');
}
