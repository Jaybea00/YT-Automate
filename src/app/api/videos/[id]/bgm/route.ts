import { NextResponse } from 'next/server';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { PRESET_TRACKS, ensureDefaultBgmPresets } from '@/pipeline/assembly/bgm';
import { PRESET_SFX, ensureDefaultSfxPresets } from '@/pipeline/assembly/sfx';
import { isCaptionPreset, type CaptionPreset } from '@/pipeline/assembly/captions';

export async function handleGetBgm(
  _req: Request,
  id: string,
  supabaseClient?: SupabaseClient,
) {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return NextResponse.json({ error: 'Invalid video ID' }, { status: 400 });
  }

  const supabase = supabaseClient ?? getSupabaseServerClient();
  const { data: video, error } = await supabase
    .from('videos')
    .select('id, bgm_track, bgm_volume, bgm_enabled, bgm_custom_url, script_json')
    .eq('id', id)
    .maybeSingle();

  if (error || !video) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  }

  // Ensure default presets are available on disk
  await ensureDefaultBgmPresets().catch(() => {});
  await ensureDefaultSfxPresets().catch(() => {});

  const bgm = {
    enabled: video.bgm_enabled !== false && video.script_json?.bgm?.enabled !== false,
    track: video.bgm_track || video.script_json?.bgm?.track || 'story',
    volume: Number(video.bgm_volume ?? video.script_json?.bgm?.volume ?? 0.2),
    customUrl: video.bgm_custom_url || video.script_json?.bgm?.customUrl || null,
    // Swells into reveals, silence before key lines, stings at chapter changes
    accents: video.script_json?.bgm?.accents !== false,
  };

  const sfx = {
    enabled: video.script_json?.sfx?.enabled !== false,
    track: video.script_json?.sfx?.track || 'smart',
    volume: Number(video.script_json?.sfx?.volume ?? 0.25),
    // Real sounds on the words that describe them (with Smart)
    narration: video.script_json?.sfx?.narration !== false,
    // The style's real recordings for on-screen effects (with Smart)
    palette: video.script_json?.sfx?.palette !== false,
  };

  const padStyle = (video.script_json?.pad_style || 'blur') as 'blur' | 'black';
  const stillMotion = (video.script_json?.still_motion || 'zoom') as 'zoom' | 'static';
  const transition = (video.script_json?.transition || 'cut') as string;
  const beatPauseSeconds = Number(video.script_json?.beat_pause_seconds ?? 0.5);
  const captionPreset = isCaptionPreset(video.script_json?.captions?.preset)
    ? video.script_json.captions.preset
    : 'none';

  return NextResponse.json({
    bgm,
    sfx,
    padStyle,
    stillMotion,
    transition,
    beatPauseSeconds,
    captionPreset,
    look: video.script_json?.look === 'off' ? 'off' : 'auto',
    archiveLook: video.script_json?.archive_look === 'off' ? 'off' : 'auto',
    parallax: video.script_json?.parallax !== false,
    transitionIntensity: ['subtle', 'balanced', 'bold'].includes(video.script_json?.transition_intensity) ? video.script_json.transition_intensity : 'balanced',
    transitionRendered: video.script_json?.transition_rendered !== false,
    // Shakes, freeze-frames, chapter zooms; letterbox follows the style unless set
    emphasis: {
      enabled: video.script_json?.emphasis?.enabled !== false,
      letterbox: typeof video.script_json?.emphasis?.letterbox === 'boolean' ? (video.script_json.emphasis.letterbox ? 'on' : 'off') : 'auto',
    },
    presets: PRESET_TRACKS,
    sfxPresets: PRESET_SFX,
    soundMoments: video.script_json?.sound_moments?.moments ?? null,
    soundBeds: video.script_json?.sound_moments?.beds ?? null,
  });
}

export async function handlePostBgm(
  req: Request,
  id: string,
  supabaseClient?: SupabaseClient,
) {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return NextResponse.json({ error: 'Invalid video ID' }, { status: 400 });
  }

  const supabase = supabaseClient ?? getSupabaseServerClient();
  const contentType = req.headers.get('content-type') || '';

  let enabled = true;
  let track = 'story';
  let volume = 0.2;
  let customUrl: string | null = null;

  let padStyle: 'blur' | 'black' | undefined;
  let stillMotion: 'zoom' | 'static' | undefined;
  let transition: string | undefined;
  let beatPauseSeconds: number | undefined;
  let captionPreset: CaptionPreset | 'none' | undefined;
  let look: 'auto' | 'off' | undefined;
  let archiveLook: 'auto' | 'off' | undefined;
  let emphasisEnabled: boolean | undefined;
  let parallax: boolean | undefined;
  let transitionIntensity: 'subtle' | 'balanced' | 'bold' | undefined;
  let transitionRendered: boolean | undefined;
  let letterbox: 'auto' | 'on' | 'off' | undefined;

  let sfxEnabled: boolean | undefined;
  let sfxTrack: string | undefined;
  let sfxVolume: number | undefined;
  let sfxNarration: boolean | undefined;
  let sfxPalette: boolean | undefined;
  let musicAccents: boolean | undefined;

  if (contentType.includes('multipart/form-data')) {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const enabledVal = formData.get('enabled');
    const trackVal = formData.get('track');
    const volumeVal = formData.get('volume');
    const padVal = formData.get('padStyle');
    const motionVal = formData.get('stillMotion');
    const transitionVal = formData.get('transition');
    const pauseVal = formData.get('beatPauseSeconds') ?? formData.get('beat_pause_seconds');

    const sfxEnVal = formData.get('sfxEnabled');
    const sfxTrkVal = formData.get('sfxTrack');
    const sfxVolVal = formData.get('sfxVolume');

    if (enabledVal !== null) enabled = enabledVal === 'true';
    if (trackVal) track = String(trackVal);
    if (volumeVal) volume = parseFloat(String(volumeVal));
    if (padVal === 'blur' || padVal === 'black') padStyle = padVal;
    if (motionVal === 'zoom' || motionVal === 'static') stillMotion = motionVal;
    if (transitionVal) transition = String(transitionVal);
    if (pauseVal !== null) {
      const p = parseFloat(String(pauseVal));
      if (!isNaN(p)) beatPauseSeconds = Math.max(0, Math.min(2.5, p));
    }

    if (sfxEnVal !== null) sfxEnabled = sfxEnVal === 'true';
    if (sfxTrkVal) sfxTrack = String(sfxTrkVal);
    if (sfxVolVal) sfxVolume = parseFloat(String(sfxVolVal));

    if (file && typeof file.arrayBuffer === 'function') {
      const ext = path.extname(file.name).toLowerCase().replace('.', '') || 'mp3';
      const bgmDir = path.join(process.cwd(), 'storage', 'bgm', id);
      await fsp.mkdir(bgmDir, { recursive: true });
      const filePath = path.join(bgmDir, `custom.${ext}`);
      const buffer = Buffer.from(await file.arrayBuffer());
      await fsp.writeFile(filePath, buffer);
      customUrl = `storage/bgm/${id}/custom.${ext}`;
      track = 'custom';
    }
  } else {
    const body = await req.json().catch(() => ({}));
    if (body.enabled !== undefined) enabled = Boolean(body.enabled);
    if (body.track) track = String(body.track);
    if (body.volume !== undefined) volume = parseFloat(String(body.volume));
    if (body.customUrl) customUrl = String(body.customUrl);
    if (body.padStyle === 'blur' || body.padStyle === 'black') padStyle = body.padStyle;
    if (body.stillMotion === 'zoom' || body.stillMotion === 'static') stillMotion = body.stillMotion;
    if (body.transition) transition = String(body.transition);

    const pauseVal = body.beatPauseSeconds ?? body.beat_pause_seconds;
    if (pauseVal !== undefined && pauseVal !== null) {
      const p = parseFloat(String(pauseVal));
      if (!isNaN(p)) beatPauseSeconds = Math.max(0, Math.min(2.5, p));
    }

    if (body.captionPreset === 'none' || isCaptionPreset(body.captionPreset)) {
      captionPreset = body.captionPreset;
    }
    if (body.look === 'auto' || body.look === 'off') look = body.look;
    if (body.archiveLook === 'auto' || body.archiveLook === 'off') archiveLook = body.archiveLook;
    if (body.emphasisEnabled !== undefined) emphasisEnabled = Boolean(body.emphasisEnabled);
    if (body.parallax !== undefined) parallax = Boolean(body.parallax);
    if (['subtle', 'balanced', 'bold'].includes(body.transitionIntensity)) transitionIntensity = body.transitionIntensity;
    if (body.transitionRendered !== undefined) transitionRendered = Boolean(body.transitionRendered);
    if (body.letterbox === 'auto' || body.letterbox === 'on' || body.letterbox === 'off') letterbox = body.letterbox;

    if (body.sfxEnabled !== undefined) sfxEnabled = Boolean(body.sfxEnabled);
    if (body.sfxTrack) sfxTrack = String(body.sfxTrack);
    if (body.sfxVolume !== undefined) sfxVolume = parseFloat(String(body.sfxVolume));
    if (body.sfxNarration !== undefined) sfxNarration = Boolean(body.sfxNarration);
    if (body.sfxPalette !== undefined) sfxPalette = Boolean(body.sfxPalette);
    if (body.musicAccents !== undefined) musicAccents = Boolean(body.musicAccents);
    if (body.sfx) {
      if (body.sfx.narration !== undefined) sfxNarration = Boolean(body.sfx.narration);
      if (body.sfx.enabled !== undefined) sfxEnabled = Boolean(body.sfx.enabled);
      if (body.sfx.track) sfxTrack = String(body.sfx.track);
      if (body.sfx.volume !== undefined) sfxVolume = parseFloat(String(body.sfx.volume));
    }
  }

  // Clamp volumes
  volume = Math.max(0.02, Math.min(0.8, volume));
  if (sfxVolume !== undefined) {
    sfxVolume = Math.max(0.02, Math.min(0.8, sfxVolume));
  }

  // 1. Fetch current script_json to merge bgm & sfx settings
  const { data: video } = await supabase
    .from('videos')
    .select('script_json')
    .eq('id', id)
    .single();

  const scriptJson = video?.script_json || {};
  scriptJson.bgm = {
    enabled,
    track,
    volume,
    customUrl,
    accents: musicAccents !== undefined ? musicAccents : scriptJson.bgm?.accents !== false,
  };
  if (padStyle) {
    scriptJson.pad_style = padStyle;
  }
  if (stillMotion) {
    scriptJson.still_motion = stillMotion;
  }
  if (transition) {
    scriptJson.transition = transition;
  }
  if (beatPauseSeconds !== undefined) {
    scriptJson.beat_pause_seconds = beatPauseSeconds;
  }
  if (captionPreset !== undefined) {
    scriptJson.captions = { preset: captionPreset };
  }
  if (look !== undefined) {
    scriptJson.look = look;
  }
  if (transitionIntensity !== undefined) scriptJson.transition_intensity = transitionIntensity;
  if (parallax !== undefined) scriptJson.parallax = parallax;
  if (transitionRendered !== undefined) scriptJson.transition_rendered = transitionRendered;
  if (emphasisEnabled !== undefined || letterbox !== undefined) {
    const current = scriptJson.emphasis ?? {};
    const next: { enabled?: boolean; letterbox?: boolean } = { enabled: emphasisEnabled ?? current.enabled !== false };
    const box = letterbox ?? (typeof current.letterbox === 'boolean' ? (current.letterbox ? 'on' : 'off') : 'auto');
    if (box !== 'auto') next.letterbox = box === 'on';
    scriptJson.emphasis = next;
  }
  if (archiveLook !== undefined) {
    scriptJson.archive_look = archiveLook;
  }

  const currentSfx = scriptJson.sfx || {};
  scriptJson.sfx = {
    enabled: sfxEnabled !== undefined ? sfxEnabled : currentSfx.enabled !== false,
    track: sfxTrack || currentSfx.track || 'smart',
    volume: sfxVolume !== undefined ? sfxVolume : currentSfx.volume ?? 0.25,
    narration: sfxNarration !== undefined ? sfxNarration : currentSfx.narration !== false,
    palette: sfxPalette !== undefined ? sfxPalette : currentSfx.palette !== false,
  };

  // 2. Update videos table
  const updatePayload: Record<string, unknown> = {
    script_json: scriptJson,
    bgm_enabled: enabled,
    bgm_track: track,
    bgm_volume: volume,
  };
  if (customUrl) {
    updatePayload.bgm_custom_url = customUrl;
  }

  const { error: updateError } = await supabase
    .from('videos')
    .update(updatePayload)
    .eq('id', id);

  if (updateError) {
    // If columns don't exist yet in DB, update script_json only
    await supabase
      .from('videos')
      .update({ script_json: scriptJson })
      .eq('id', id);
  }

  return NextResponse.json({
    success: true,
    bgm: {
      enabled,
      track,
      volume,
      customUrl,
    },
    sfx: scriptJson.sfx,
    padStyle: scriptJson.pad_style || 'blur',
    stillMotion: scriptJson.still_motion || 'zoom',
    transition: scriptJson.transition || 'cut',
    captionPreset: scriptJson.captions?.preset || 'none',
    look: scriptJson.look === 'off' ? 'off' : 'auto',
    archiveLook: scriptJson.archive_look === 'off' ? 'off' : 'auto',
  });
}

export async function GET(
  req: Request,
  props: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await props.params;
    return await handleGetBgm(req, id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  props: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await props.params;
    return await handlePostBgm(req, id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
