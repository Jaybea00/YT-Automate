import { BUILT_IN_FORMATS, type FormatDef, type SignatureShot } from './formats';
import { BUILT_IN_NICHES, type NicheDef } from './niches';
import { DOCUMENTARY_PACING, isVideoStyle, stylePack, type StylePack, type VideoStyle } from './packs';
import { themeByName, type MotionTheme } from './themes';

/**
 * A video's style as the creator picks it: a format (how it's built) plus a niche (what it's
 * about), with an optional look, audience and personal writing voice. composePack() turns that
 * into the StylePack every stage already reads.
 *
 * Storage: a new video keeps the closest original style id in videos.style (so everything keyed
 * by style id, such as transitions and sound palettes, still works), and saves its setup and the
 * composed pack in script_json (style_setup, style_pack). The saved pack is a snapshot: editing a
 * custom niche later never changes a video that's already made. packForVideo() reads it back.
 */

export type LookId = 'auto' | 'documentary' | 'collage' | 'warm' | 'clean' | 'tech' | 'corporate' | 'drawings';
export type Audience = 'beginner' | 'general' | 'enthusiast';

export interface StyleSetup {
  format: string;
  niche: string;
  look?: LookId;
  audience?: Audience;
  /** A saved writing voice (the creator's own style), or null for none. */
  voiceId?: string | null;
}

/** A creator's own writing style, written from scripts they pasted (or by hand). */
export interface WriterVoice {
  id: string;
  name: string;
  /** How they write, as instructions for the writer. */
  description: string;
  createdAt: string;
  /** How many scripts it was derived from, when it was. */
  sourceCount?: number;
}

/** The creator's own formats, niches and voices (storage/settings/style-library.json). */
export interface StyleLibrary {
  formats: FormatDef[];
  niches: NicheDef[];
  voices: WriterVoice[];
}

export const EMPTY_LIBRARY: StyleLibrary = { formats: [], niches: [], voices: [] };

export const LOOKS: Array<{ id: LookId; name: string; description: string }> = [
  { id: 'auto', name: 'Match the niche', description: "The niche's own colours, fonts and grade." },
  { id: 'documentary', name: 'Documentary', description: 'Dark, warm and filmic, with serif titles.' },
  { id: 'collage', name: 'Collage', description: 'Cut-out photos taped onto paper, with labelled illustrations.' },
  { id: 'warm', name: 'Warm', description: 'Friendly, bright and approachable.' },
  { id: 'clean', name: 'Clean', description: 'Light studio white with one bold accent.' },
  { id: 'tech', name: 'Tech', description: 'Dark, sharp and techy, with a neon accent.' },
  { id: 'corporate', name: 'Corporate', description: 'Polished navy and data-friendly charts.' },
  { id: 'drawings', name: 'Your drawings (stickman)', description: 'You draw the pictures; footage is never searched.' },
];

export const AUDIENCES: Array<{ id: Audience; name: string; description: string }> = [
  { id: 'beginner', name: 'Beginner', description: 'Zero prior knowledge: analogies, every term defined.' },
  { id: 'general', name: 'General', description: 'Curious viewers with no special background.' },
  { id: 'enthusiast', name: 'Enthusiast', description: 'Knows the basics: skip definitions, go deeper.' },
];

const AUDIENCE_RULES: Record<Audience, string> = {
  beginner: `AUDIENCE: complete beginners. Assume zero prior knowledge. Use concrete analogies for abstract
ideas, define any term before using it, build understanding step by step (the simple idea first, then
add complexity), and keep sentences short. Warm and patient, never condescending.`,
  general: '',
  enthusiast: `AUDIENCE: enthusiasts who already know the basics. Skip the definitions they already know, go
deeper on the specifics, and never over-explain.`,
};

const DRAWN_WRITING = `DRAWINGS: the pictures are the creator's own simple stickman drawings. Each beat must
describe one thing a simple drawing can show: a clear action, place or situation.`;

const DRAWN_DIRECTION = `This video is drawn by the creator: wherever these notes mention photos, footage or stock, use a drawing instead. Everything that isn't a graphic is a drawing.`;

const LOOK_THEMES: Partial<Record<LookId, string>> = {
  documentary: 'documentary',
  collage: 'vox',
  warm: 'warm',
  clean: 'review',
  tech: 'tech',
  corporate: 'business',
};

export const DEFAULT_SETUP: Required<StyleSetup> = {
  format: 'explainer',
  niche: 'general',
  look: 'auto',
  audience: 'general',
  voiceId: null,
};

/** Where each original style lands as a format and niche, so old videos map onto the new pickers. */
export const LEGACY_SETUPS: Record<VideoStyle, StyleSetup> = {
  tech: { format: 'quick_take', niche: 'tech', audience: 'enthusiast' },
  cinematic: { format: 'story', niche: 'general', look: 'documentary' },
  modernmba: { format: 'analysis', niche: 'business' },
  listicle: { format: 'countdown', niche: 'general', look: 'warm' },
  story_driven: { format: 'story', niche: 'general' },
  comparison: { format: 'comparison', niche: 'general', look: 'corporate' },
  eli5: { format: 'explainer', niche: 'general', look: 'warm', audience: 'beginner' },
  true_crime_pov: { format: 'investigation', niche: 'true_crime' },
  vox_explainer: { format: 'explainer', niche: 'general', look: 'collage' },
  car: { format: 'story', niche: 'cars' },
  sport: { format: 'story', niche: 'sport' },
  finance: { format: 'explainer', niche: 'finance' },
  space_science: { format: 'explainer', niche: 'space' },
  tech_review: { format: 'review', niche: 'tech', look: 'clean' },
  history: { format: 'story', niche: 'history' },
  mystery: { format: 'investigation', niche: 'mysteries' },
  stickman_pov: { format: 'pov', niche: 'general', look: 'drawings' },
  stickman_bible: { format: 'retelling', niche: 'faith', look: 'drawings' },
};

export function allFormats(library: StyleLibrary = EMPTY_LIBRARY): FormatDef[] {
  return [...BUILT_IN_FORMATS, ...library.formats.map((f) => ({ ...f, custom: true }))];
}

export function allNiches(library: StyleLibrary = EMPTY_LIBRARY): NicheDef[] {
  return [...BUILT_IN_NICHES, ...library.niches.map((n) => ({ ...n, custom: true }))];
}

const isLook = (v: unknown): v is LookId => LOOKS.some((l) => l.id === v);
const isAudience = (v: unknown): v is Audience => AUDIENCES.some((a) => a.id === v);

/** A setup with every field filled and every id checked against what exists (unknown ids get the defaults). */
export function normalizeSetup(raw: Partial<StyleSetup> | null | undefined, library: StyleLibrary = EMPTY_LIBRARY): Required<StyleSetup> {
  const format = allFormats(library).some((f) => f.id === raw?.format) ? raw!.format! : DEFAULT_SETUP.format;
  const niche = allNiches(library).some((n) => n.id === raw?.niche) ? raw!.niche! : DEFAULT_SETUP.niche;
  return {
    format,
    niche,
    look: isLook(raw?.look) ? raw.look : 'auto',
    audience: isAudience(raw?.audience) ? raw.audience : 'general',
    voiceId: raw?.voiceId && library.voices.some((v) => v.id === raw.voiceId) ? raw.voiceId : null,
  };
}

/** A short, stable id for a setup (the voice isn't part of it): "story+history", "pov+general+look:drawings". */
export function setupKey(setup: StyleSetup): string {
  const parts = [setup.format, setup.niche];
  if (setup.look && setup.look !== 'auto') parts.push(`look:${setup.look}`);
  if (setup.audience && setup.audience !== 'general') parts.push(`aud:${setup.audience}`);
  return parts.join('+');
}

const sameSetup = (a: StyleSetup, b: StyleSetup) =>
  a.format === b.format && a.niche === b.niche && (a.look ?? 'auto') === (b.look ?? 'auto') && (a.audience ?? 'general') === (b.audience ?? 'general');

/**
 * The original style id stored in videos.style: the exact original when the setup is one, else
 * the closest. It never implies drawings unless the setup is drawn (code that still reads only
 * videos.style must not wait for drawings on a footage video).
 */
export function legacyStyleFor(setup: StyleSetup, library: StyleLibrary = EMPTY_LIBRARY): VideoStyle {
  const exact = (Object.entries(LEGACY_SETUPS) as Array<[VideoStyle, StyleSetup]>).find(([, s]) => sameSetup(s, setup));
  if (exact) return exact[0];
  if (setup.look === 'drawings') return setup.niche === 'faith' ? 'stickman_bible' : 'stickman_pov';
  const niche = allNiches(library).find((n) => n.id === setup.niche);
  const format = allFormats(library).find((f) => f.id === setup.format);
  const base = niche?.baseStyle ?? format?.baseStyle ?? 'story_driven';
  return isVideoStyle(base) && !stylePack(base)?.drawn ? base : 'story_driven';
}

/** The setup an existing video was made with: its saved setup, else where its original style maps. */
export function setupForVideo(video: { style?: string | null; script_json?: unknown } | null | undefined): Required<StyleSetup> {
  const saved = (video?.script_json as { style_setup?: Partial<StyleSetup> } | null | undefined)?.style_setup;
  const fromStyle = isVideoStyle(video?.style) ? LEGACY_SETUPS[video!.style as VideoStyle] : null;
  const raw = saved ?? fromStyle ?? null;
  return {
    format: raw?.format ?? DEFAULT_SETUP.format,
    niche: raw?.niche ?? DEFAULT_SETUP.niche,
    look: isLook(raw?.look) ? raw.look : 'auto',
    audience: isAudience(raw?.audience) ? raw.audience : 'general',
    voiceId: raw?.voiceId ?? null,
  };
}

const unique = <T,>(xs: T[]) => [...new Set(xs)];

export interface ComposedStyle {
  setup: Required<StyleSetup>;
  pack: StylePack;
  /** For videos.style. */
  legacyStyle: VideoStyle;
}

/** Combines a format, niche, look, audience and voice into one StylePack. */
export function composePack(rawSetup: Partial<StyleSetup>, library: StyleLibrary = EMPTY_LIBRARY): ComposedStyle {
  const setup = normalizeSetup(rawSetup, library);
  const format = allFormats(library).find((f) => f.id === setup.format)!;
  const niche = allNiches(library).find((n) => n.id === setup.niche)!;
  const voice = setup.voiceId ? library.voices.find((v) => v.id === setup.voiceId) : undefined;
  const drawn = setup.look === 'drawings';

  const documentary =
    !niche.briskNarration && (format.pacing === 'documentary' || (format.pacing === 'normal' && Boolean(niche.slowNarration)));
  const themeName = drawn ? (niche.drawnTheme ?? 'doodle') : (LOOK_THEMES[setup.look] ?? niche.theme);

  const writer = [
    format.structure,
    niche.subject ? `SUBJECT: ${niche.subject}` : '',
    AUDIENCE_RULES[setup.audience],
    drawn ? DRAWN_WRITING : '',
    voice?.description.trim()
      ? `THE CREATOR'S OWN VOICE (write the way they write; every rule above and below still applies):\n${voice.description.trim()}`
      : '',
  ].filter(Boolean);

  const notes = [format.directorNotes, niche.directorNotes, drawn ? DRAWN_DIRECTION : ''].filter(Boolean);
  const signatureShots = unique<SignatureShot>([...(format.signatureShots ?? []), ...(niche.signatureShots ?? [])]);
  const baseEmphasis = niche.emphasis ?? format.emphasis;
  const emphasis = drawn ? (baseEmphasis?.chapterZoom ? { chapterZoom: true } : undefined) : baseEmphasis;
  const captionPreset = drawn ? 'doodle' : niche.captionPreset;
  const audienceLabel = setup.audience === 'beginner' ? ', for beginners' : setup.audience === 'enthusiast' ? ', for enthusiasts' : '';
  const nicheLabel = niche.id === 'general' ? '' : ` / ${niche.name}`;

  const pack: StylePack = {
    id: setupKey(setup),
    name: niche.id === 'general' ? format.name : `${format.name} · ${niche.name}`,
    label: `${format.name}${nicheLabel}${drawn ? ' (drawn)' : ''}${audienceLabel}`,
    description: niche.id === 'general' ? format.description : `${format.description} ${niche.description}`,
    shortName: niche.id === 'general' ? format.name : `${format.name} · ${niche.name}`,
    tagline: niche.description,
    icon: niche.id === 'general' ? format.icon : niche.icon,
    group: drawn ? 'stickman' : 'niche',
    voice: writer.join('\n\n'),
    delivery: [niche.delivery, format.energy].filter(Boolean).join(' '),
    theme: themeByName(themeName),
    // The General niche has no mood of its own: the format's (a story is mysterious) when it has one
    fallbackMood: (niche.id === 'general' ? format.mood : undefined) ?? niche.fallbackMood,
    ...(notes.length ? { directorNotes: notes.join('\n') } : {}),
    ...(drawn
      ? { maxGraphicsShare: Math.min(0.4, niche.maxGraphicsShare ?? 0.35) }
      : niche.maxGraphicsShare !== undefined
        ? { maxGraphicsShare: niche.maxGraphicsShare }
        : {}),
    ...(documentary ? { narration: DOCUMENTARY_PACING } : {}),
    ...(signatureShots.length ? { signatureShots } : {}),
    ...(drawn ? { drawn: { secondsPerShot: documentary ? 4 : 3 } } : {}),
    ...(setup.look === 'collage' ? { photoLook: 'collage' as const } : {}),
    ...(format.chartCallouts || niche.chartCallouts ? { chartCallouts: true } : {}),
    ...(niche.illustrations || setup.look === 'collage' ? { illustrations: true } : {}),
    ...(emphasis && (emphasis.letterbox || emphasis.chapterZoom) ? { emphasis } : {}),
    ...(captionPreset ? { defaults: { captionPreset } } : {}),
  };

  return { setup, pack, legacyStyle: legacyStyleFor(setup, library) };
}

/** A StylePack as saved in script_json: the theme by name. */
export type SavedPack = Omit<StylePack, 'theme'> & { theme: string };

export function savePack(pack: StylePack): SavedPack {
  return { ...pack, theme: pack.theme.name };
}

export function loadPack(saved: SavedPack): StylePack {
  return { ...saved, theme: themeByName(saved.theme) as MotionTheme };
}

function savedPackOf(scriptJson: unknown): SavedPack | null {
  const saved = (scriptJson as { style_pack?: unknown } | null | undefined)?.style_pack as Partial<SavedPack> | undefined;
  return saved && typeof saved === 'object' && typeof saved.voice === 'string' && typeof saved.theme === 'string'
    ? (saved as SavedPack)
    : null;
}

/**
 * A video's style pack: the composed pack saved when it was made, else its original style's pack.
 * Pass anything with the video's style and script_json.
 */
export function packForVideo(video: { style?: string | null; script_json?: unknown } | null | undefined): StylePack | undefined {
  const saved = savedPackOf(video?.script_json);
  return saved ? loadPack(saved) : stylePack(video?.style);
}

/** The saved style fields of a script_json (to carry them over when the script is replaced). */
export function keptStyle(scriptJson: unknown): { style_setup?: unknown; style_pack?: unknown } {
  const sj = scriptJson as { style_setup?: unknown; style_pack?: unknown } | null | undefined;
  return sj?.style_pack ? { style_setup: sj.style_setup, style_pack: sj.style_pack } : {};
}

/**
 * Stores a composed style on a new video's script_json: the setup, the pack snapshot, and the
 * style's starting settings (captions, transitions, beat pause).
 */
export function withComposedStyle<T extends object>(scriptJson: T, composed: ComposedStyle): T {
  const pack = composed.pack;
  const current = scriptJson as T & { captions?: unknown; transition?: unknown; beat_pause_seconds?: unknown };
  const captionPreset = pack.defaults?.captionPreset;
  const beatPause = pack.narration?.beatPauseSec;
  return {
    ...scriptJson,
    style_setup: composed.setup,
    style_pack: savePack(pack),
    ...(captionPreset && current.captions === undefined ? { captions: { preset: captionPreset } } : {}),
    ...(current.transition === undefined ? { transition: 'style' } : {}),
    ...(beatPause !== undefined && current.beat_pause_seconds === undefined ? { beat_pause_seconds: beatPause } : {}),
  };
}
