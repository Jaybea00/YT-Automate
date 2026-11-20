/**
 * The channel's identity, used by every Short the app makes: its name and @handle, how the
 * voiceover talks, the caption colours and font, a closing line, and what goes at the end of
 * each description. Browser-safe (the Channel page and the pipeline share it).
 */

export type ChannelVoiceStyle = 'hype' | 'narrator' | 'info';
export type ChannelPalette = 'vice' | 'leonida' | 'classic';
export type ChannelFont = 'Segoe UI Black' | 'Impact' | 'Arial Black';
export type ClosingAs = 'banner' | 'off';
export type MarkCorner = 'top-left' | 'top-right';

export interface ChannelProfile {
  name: string;
  /** Without the @. */
  handle: string;
  /** What the channel posts, told to the script writer. */
  niche: string;
  defaultVoiceStyle: ChannelVoiceStyle;
  /** TTS voice id for voiceovers; empty uses the narration stage's default voice. */
  voice: string;
  /** How the channel sounds, in a sentence or two, told to the script writer. */
  tone: string;
  /** Shown over the last seconds of every Short, and the compilation outro. */
  closingLine: string;
  closingAs: ClosingAs;
  palette: ChannelPalette;
  captionFont: ChannelFont;
  /** The @handle in a top corner of every Short. */
  handleMark: boolean;
  handleMarkCorner: MarkCorner;
  /** Hashtags every description ends with (without #). */
  hashtags: string[];
  /** A line at the end of every description (e.g. "New GTA 6 clips every day."). */
  footer: string;
  /** Says the channel is a fan channel, not Rockstar's. */
  fanNote: string;
  /** The clip credit; {creator} becomes the creator's name. */
  creditFormat: string;
}

export const PALETTES: Record<ChannelPalette, { label: string; highlight: string; banner: string }> = {
  vice: { label: 'Vice (pink and orange)', highlight: '#ff3ea5', banner: '#ffa62b' },
  leonida: { label: 'Leonida (teal and sunset)', highlight: '#2ee6d6', banner: '#ff7a59' },
  classic: { label: 'Classic (yellow)', highlight: '#ffd400', banner: '#ffd400' },
};

export const FONTS: ChannelFont[] = ['Segoe UI Black', 'Impact', 'Arial Black'];
export const VOICE_STYLES: Array<{ id: ChannelVoiceStyle; label: string }> = [
  { id: 'hype', label: 'Hype reactions' },
  { id: 'narrator', label: 'Storyteller' },
  { id: 'info', label: 'Tips and info' },
];

export const DEFAULT_CHANNEL: ChannelProfile = {
  name: 'Lucia & Jason Daily',
  handle: 'TheLuciaJasonDaily',
  niche: 'GTA 6 clips, news and funny moments, posted daily as Shorts',
  defaultVoiceStyle: 'hype',
  voice: '',
  tone: 'Fun, fast and a little cheeky, like a friend who plays GTA every day. Never mean, never clickbait.',
  closingLine: 'Follow for daily GTA 6',
  closingAs: 'banner',
  palette: 'vice',
  captionFont: 'Segoe UI Black',
  handleMark: true,
  handleMarkCorner: 'top-right',
  hashtags: ['GTA6', 'GTAVI', 'Shorts'],
  footer: 'New GTA 6 clips every day. Follow so you don’t miss one.',
  fanNote: 'Fan channel. Not affiliated with Rockstar Games.',
  creditFormat: '🎥 Clip by {creator}',
};

const str = (v: unknown, fallback: string, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : fallback);
const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);

/** Hashtags as plain words: no #, spaces or punctuation, no repeats, at most 10. */
export function cleanHashtags(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const tag = String(item ?? '').replace(/[^\p{L}\p{N}_]/gu, '');
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag.slice(0, 40));
  }
  return out.slice(0, 10);
}

/** A saved (or posted) profile with every field checked; missing ones take the defaults. */
export function normalizeChannelProfile(value: unknown): ChannelProfile {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const d = DEFAULT_CHANNEL;
  return {
    name: str(v.name, d.name, 60) || d.name,
    handle: str(v.handle, d.handle, 40).replace(/^@+/, '').replace(/\s+/g, ''),
    niche: str(v.niche, d.niche, 200),
    defaultVoiceStyle: oneOf(v.defaultVoiceStyle, ['hype', 'narrator', 'info'] as const, d.defaultVoiceStyle),
    voice: str(v.voice, d.voice, 80),
    tone: str(v.tone, d.tone, 400),
    closingLine: str(v.closingLine, d.closingLine, 50),
    closingAs: oneOf(v.closingAs, ['banner', 'off'] as const, d.closingAs),
    palette: oneOf(v.palette, ['vice', 'leonida', 'classic'] as const, d.palette),
    captionFont: oneOf(v.captionFont, FONTS, d.captionFont),
    handleMark: typeof v.handleMark === 'boolean' ? v.handleMark : d.handleMark,
    handleMarkCorner: oneOf(v.handleMarkCorner, ['top-left', 'top-right'] as const, d.handleMarkCorner),
    hashtags: v.hashtags === undefined ? d.hashtags : cleanHashtags(v.hashtags),
    footer: str(v.footer, d.footer, 300),
    fanNote: str(v.fanNote, d.fanNote, 200),
    creditFormat: str(v.creditFormat, d.creditFormat, 80) || d.creditFormat,
  };
}

/** The script writer's brief about the channel. */
export function channelPromptBlock(p: ChannelProfile): string {
  return `CHANNEL
- Name: ${p.name}${p.handle ? ` (@${p.handle})` : ''}
- Posts: ${p.niche || 'GTA clips'}
- Sounds like: ${p.tone || 'fun and clear'}
- It is a fan channel: never claim to be Rockstar or to have inside information.`;
}

/** The clip credit line, e.g. "🎥 Clip by @someone". */
export function formatCredit(p: ChannelProfile, creator: string): string {
  return p.creditFormat.includes('{creator}') ? p.creditFormat.replaceAll('{creator}', creator) : `${p.creditFormat} ${creator}`.trim();
}

/** The caption look for a rendered Short: colours, font, closing banner and @handle mark. */
export function shortBranding(p: ChannelProfile, durationMs: number): {
  highlightHex: string;
  bannerHex: string;
  fontName: string;
  closing: { text: string; startMs: number; endMs: number; position: 'top' } | null;
  mark: { text: string; corner: MarkCorner; endMs: number } | undefined;
} {
  const colours = PALETTES[p.palette];
  const closingSec = 2.5;
  const closing =
    p.closingAs === 'banner' && p.closingLine && durationMs > closingSec * 1000 * 3
      ? { text: p.closingLine, startMs: Math.round(durationMs - closingSec * 1000), endMs: Math.round(durationMs), position: 'top' as const }
      : null;
  return {
    highlightHex: colours.highlight,
    bannerHex: colours.banner,
    fontName: p.captionFont,
    closing,
    mark: p.handleMark && p.handle ? { text: `@${p.handle}`, corner: p.handleMarkCorner, endMs: Math.round(durationMs) } : undefined,
  };
}

/** The end of every description: footer, hashtags (#Shorts first on a Short, left out otherwise), fan note. */
export function descriptionFooter(p: ChannelProfile, extraTags: string[] = [], { shorts = true, maxTags = 6 } = {}): string {
  const tags = cleanHashtags([...(shorts ? ['Shorts'] : []), ...p.hashtags, ...extraTags])
    .filter((t) => shorts || t.toLowerCase() !== 'shorts')
    .slice(0, maxTags);
  return [p.footer, tags.map((t) => `#${t}`).join(' '), p.fanNote].filter(Boolean).join('\n\n');
}
