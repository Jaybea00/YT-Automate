import { formatAssTime, toAssColour } from '../assembly/captions';
import { SHORT_H, SHORT_W, type TimedWord } from './timeline';

/**
 * How a guide looks: captions a few words at a time in bold italic white with key words in green
 * (red for the bad stuff), the title over the opening shot, and a numbered card as each item starts.
 */

export const GREEN = '#39e639';
export const RED = '#ff3030';
/** Most words and letters in one caption. */
const MAX_WORDS = 3;
const MAX_CHARS = 18;
/** Where the captions sit: the middle of the caption block is this far down the picture. */
export const CAPTION_Y = Math.round(SHORT_H * 0.64);
/** Captions moved low (under a social post, which ends at y 1420): their bottom edge this far from the bottom. */
const LOW_MARGIN_V = 230;

/** Caption groups: up to three words, breaking after punctuation, never mixing two lines of the script. */
export function captionGroups(words: TimedWord[]): TimedWord[][] {
  const groups: TimedWord[][] = [];
  let cur: TimedWord[] = [];
  for (const w of words) {
    const chars = cur.reduce((a, x) => a + x.word.length + 1, 0) + w.word.length;
    const gap = cur.length ? w.start - cur[cur.length - 1].end : 0;
    if (cur.length && (cur.length >= MAX_WORDS || chars > MAX_CHARS || gap > 0.45)) {
      groups.push(cur);
      cur = [];
    }
    cur.push(w);
    if (/[.,!?;:…]$/.test(w.word)) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

const clean = (w: string) => w.replace(/[{}\\]/g, '');

/** Text in capitals, except a plural "s" after an all-caps word ("NPCs" stays NPCs, not NPCS). */
export function shout(text: string): string {
  return text
    .split(/(\s+)/)
    .map((w) => {
      const plural = w.match(/^([^\p{L}\p{N}]*[\p{Lu}\p{N}]{2,})s([^\p{L}\p{N}]*)$/u);
      return plural ? `${plural[1]}s${plural[2]}` : w.toUpperCase();
    })
    .join('');
}

/**
 * The caption track as ASS: each group's words appear one by one as they're said (the rest of the
 * group is there but invisible, so nothing shifts), coloured words in green or red. Nothing shows
 * during the `quiet` stretches (the title and the item cards say it already).
 */
export function captionAss(
  words: TimedWord[],
  opts: {
    durationSec: number;
    quiet?: Array<{ from: number; to: number }>;
    /** Stretches where the captions sit low on the screen (under a social post), out of a graphic's way. */
    low?: Array<{ from: number; to: number }>;
    fontName?: string;
    fontSize?: number;
    mark?: { text: string; corner: 'top-left' | 'top-right' };
  },
): string {
  const font = opts.fontName?.trim() || 'Segoe UI Black';
  const size = opts.fontSize ?? 86;
  const marginV = Math.round(SHORT_H - CAPTION_Y - size / 2);
  // The channel's @handle, small and steady in a top corner for the whole Short (as on the clips)
  const markText = opts.mark ? clean(opts.mark.text).trim() : '';
  const markStyle = markText
    ? `Style: Mark, ${font}, ${Math.round(SHORT_H * 0.02)}, &H40FFFFFF, &H40FFFFFF, &H60000000, &H00000000, -1, 0, 0, 0, 100, 100, 0, 0, 1, 2, 0, ${opts.mark!.corner === 'top-left' ? 7 : 9}, ${Math.round(SHORT_W * 0.045)}, ${Math.round(SHORT_W * 0.045)}, ${Math.round(SHORT_H * 0.03)}, 1\n`
    : '';
  const head = `[Script Info]
Title: Guide captions
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: ${SHORT_W}
PlayResY: ${SHORT_H}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Guide, ${font}, ${size}, &H00FFFFFF, &H00FFFFFF, &H00000000, &H90000000, -1, -1, 0, 0, 100, 100, 0, 0, 1, 7, 4, 2, 150, 150, ${marginV}, 1
Style: GuideLow, ${font}, ${size}, &H00FFFFFF, &H00FFFFFF, &H00000000, &H90000000, -1, -1, 0, 0, 100, 100, 0, 0, 1, 7, 4, 2, 150, 150, ${LOW_MARGIN_V}, 1
${markStyle}
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const green = toAssColour(GREEN);
  const red = toAssColour(RED);
  const quiet = opts.quiet ?? [];
  const lines: string[] = [];
  const groups = captionGroups(words);
  for (const [g, group] of groups.entries()) {
    const nextStart = groups[g + 1]?.[0].start ?? opts.durationSec;
    const groupEnd = Math.min(nextStart, group[group.length - 1].end + 0.35, opts.durationSec);
    for (const [k, w] of group.entries()) {
      let from = w.start;
      let to = k + 1 < group.length ? group[k + 1].start : groupEnd;
      // Left out when said in a quiet stretch, cut short where it runs into one
      if (quiet.some((q) => from >= q.from && from < q.to)) continue;
      for (const q of quiet) if (from < q.from && to > q.from) to = q.from;
      if (to - from < 0.03) continue;
      const text = group
        .map((x, i) => {
          const word = clean(shout(x.word));
          const colour = x.colour === 'green' ? `\\c${green}` : x.colour === 'red' ? `\\c${red}` : '';
          // A word pops in when it's said; later words are already placed but invisible
          if (i > k) return `{\\alpha&HFF&}${word}{\\r}`;
          if (i === k) return `{${colour}\\fscx112\\fscy112\\t(0,80,\\fscx100\\fscy100)}${word}{\\r}`;
          return colour ? `{${colour}}${word}{\\r}` : word;
        })
        .join(' ');
      const style = (opts.low ?? []).some((l) => from >= l.from && from < l.to) ? 'GuideLow' : 'Guide';
      lines.push(`Dialogue: 0,${formatAssTime(Math.round(from * 1000))},${formatAssTime(Math.round(to * 1000))},${style},,0,0,0,,${text}`);
    }
  }
  if (markText) lines.push(`Dialogue: 1,${formatAssTime(0)},${formatAssTime(Math.round(opts.durationSec * 1000))},Mark,,0,0,0,,${markText}`);
  return `${head}${lines.join('\n')}\n`;
}

// --------------------------------------------------------------------------
// Pictures drawn by the browser
// --------------------------------------------------------------------------

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const EMOJI_FONTS = `'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji'`;
const page = (body: string, css: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent}body{width:${SHORT_W}px;display:flex;flex-direction:column;align-items:center}${css}</style></head><body>${body}</body></html>`;

/** Marked text (*green*, ~red~) as HTML spans. */
export function markedHtml(text: string): string {
  return escapeHtml(text)
    .replace(/\*([^*]+)\*/g, '<span class="g">$1</span>')
    .replace(/~([^~]+)~/g, '<span class="r">$1</span>');
}

const textLook = (font: string, size: number) =>
  `font-family:'${font}','Segoe UI Black','Arial Black',${EMOJI_FONTS},sans-serif;font-weight:900;font-style:italic;font-size:${size}px;line-height:1.08;
  color:#fff;text-align:center;letter-spacing:-0.5px;
  -webkit-text-stroke:3px #000;paint-order:stroke fill;
  text-shadow:0 0 2px #000,0 5px 0 rgba(0,0,0,.85),0 8px 18px rgba(0,0,0,.55)`;

/** The logo (when there is one) over the title, for the opening shot. */
export function titleDocument(title: string, logoDataUrl: string | null, fontName = 'Segoe UI Black'): string {
  const len = title.replace(/[*~]/g, '').length;
  const size = len > 40 ? 76 : len > 26 ? 88 : 100;
  return page(
    `<div id="t">${logoDataUrl ? `<img src="${logoDataUrl}">` : ''}<div class="txt">${markedHtml(shout(title))}</div></div>`,
    `#t{display:flex;flex-direction:column;align-items:center;gap:26px;padding:10px 70px}
#t img{max-width:430px;max-height:330px;filter:drop-shadow(0 10px 20px rgba(0,0,0,.5))}
.txt{${textLook(fontName, size)};max-width:900px}.g{color:${GREEN}}.r{color:${RED}}`,
  );
}

/** An item's card: "2. SIX-STAR WANTED LEVEL" with its emoji (a typed one, or a picture from the library) under it. */
export function cardDocument(heading: string, number: number | null, emoji: { char?: string; dataUrl?: string } | null, fontName = 'Segoe UI Black'): string {
  const len = heading.length;
  const size = len > 28 ? 62 : len > 18 ? 70 : 78;
  const pic = emoji?.dataUrl ? `<img src="${emoji.dataUrl}">` : emoji?.char ? `<div class="e">${escapeHtml(emoji.char)}</div>` : '';
  return page(
    `<div id="c"><div class="txt">${number != null ? `<span class="g">${number}.</span> ` : ''}${markedHtml(shout(heading))}</div>${pic}</div>`,
    `#c{display:flex;flex-direction:column;align-items:center;gap:12px;padding:10px 70px}
.txt{${textLook(fontName, size)};max-width:880px}.g{color:${GREEN}}.r{color:${RED}}
.e{font-family:${EMOJI_FONTS},sans-serif;font-size:150px;line-height:1.1;filter:drop-shadow(0 8px 14px rgba(0,0,0,.5))}
#c img{max-width:180px;max-height:180px;filter:drop-shadow(0 8px 14px rgba(0,0,0,.5))}`,
  );
}
