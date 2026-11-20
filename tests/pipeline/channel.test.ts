import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_CHANNEL, channelPromptBlock, cleanHashtags, descriptionFooter, formatCredit, normalizeChannelProfile, shortBranding } from '../../src/lib/channel/profile.ts';
import { loadChannelProfile, saveChannelProfile } from '../../src/pipeline/channel/store.ts';
import { generateAssCaptions } from '../../src/pipeline/assembly/captions.ts';
import { withClosing } from '../../src/pipeline/clipping/render.ts';
import { buildScriptPrompt, planFromDraft } from '../../src/pipeline/clipping/script.ts';
import { composeUploadDescription } from '../../src/pipeline/clipping/package.ts';
import { buildCompilationPrompt, fallbackScript } from '../../src/pipeline/compile/script.ts';
import type { ClipAnalysis, ClipProject } from '../../src/pipeline/clipping/types.ts';

const analysis: ClipAnalysis = { durationSec: 30, width: 1920, height: 1080, hasAudio: true, loudness: [], peaks: [{ at: 12, score: 9 }], words: [], transcript: '', musicSections: [], frames: [] };
const project = (): ClipProject => ({
  id: '20261120-abcdef12',
  sourceUrl: 'https://x.com/a/status/1',
  creator: '@clipper',
  note: '',
  createdAt: '2026-11-20T00:00:00Z',
  updatedAt: '2026-11-20T00:00:00Z',
  status: 'ready',
  step: 'Ready',
  warnings: [],
  source: { title: '', postText: '', uploader: 'X', uploaderHandle: '@poster', platform: 'X', pageUrl: 'https://x.com/a/status/1', file: 'source.mp4' },
});

describe('channel profile', () => {
  it('starts as Lucia & Jason Daily and checks every saved field', () => {
    assert.equal(normalizeChannelProfile(undefined).name, 'Lucia & Jason Daily');
    const p = normalizeChannelProfile({ name: '  ', handle: '@@Lucia Jason', palette: 'neon', defaultVoiceStyle: 'info', hashtags: '#GTA6, gta-vi  #gta6', handleMark: 'yes' });
    assert.equal(p.name, DEFAULT_CHANNEL.name);
    assert.equal(p.handle, 'LuciaJason');
    assert.equal(p.palette, 'vice');
    assert.equal(p.defaultVoiceStyle, 'info');
    assert.deepEqual(p.hashtags, ['GTA6', 'gtavi']);
    assert.equal(p.handleMark, true);
  });

  it('cleans hashtags', () => {
    assert.deepEqual(cleanHashtags(['#GTA 6', 'GTA6', '', '#Shorts']), ['GTA6', 'Shorts']);
  });

  it('saves and loads from a file, defaults when there is none', async () => {
    const file = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'channel-')), 'settings', 'channel.json');
    assert.equal((await loadChannelProfile(file)).handle, DEFAULT_CHANNEL.handle);
    await saveChannelProfile({ ...DEFAULT_CHANNEL, handle: 'MyHandle', palette: 'classic' }, file);
    const back = await loadChannelProfile(file);
    assert.equal(back.handle, 'MyHandle');
    assert.equal(back.palette, 'classic');
  });

  it('formats the credit and the description footer', () => {
    assert.equal(formatCredit(DEFAULT_CHANNEL, '@a'), '🎥 Clip by @a');
    assert.equal(formatCredit({ ...DEFAULT_CHANNEL, creditFormat: 'Credit:' }, '@a'), 'Credit: @a');
    const footer = descriptionFooter(DEFAULT_CHANNEL, ['#GTA6FunnyMoments']);
    assert.match(footer, /^New GTA 6 clips every day/);
    assert.match(footer, /#Shorts #GTA6 #GTAVI #GTA6FunnyMoments/);
    assert.match(footer, /Not affiliated with Rockstar Games\.$/);
    assert.doesNotMatch(descriptionFooter(DEFAULT_CHANNEL, [], { shorts: false }), /#Shorts/);
  });
});

describe('channel in Shorts', () => {
  it('briefs the script writer and sets the default style and voice', () => {
    const channel = { ...DEFAULT_CHANNEL, defaultVoiceStyle: 'narrator' as const, voice: 'am_michael' };
    const prompt = buildScriptPrompt(project(), analysis, 'narrator', [], channel);
    assert.match(prompt, /CHANNEL\n- Name: Lucia & Jason Daily \(@TheLuciaJasonDaily\)/);
    assert.match(prompt, /never claim to be Rockstar/);
    assert.doesNotMatch(buildScriptPrompt(project(), analysis, 'hype', []), /CHANNEL/);
    const plan = planFromDraft(null, project(), analysis, undefined, channel);
    assert.equal(plan.voiceStyle, 'narrator');
    assert.equal(plan.voice, 'am_michael');
    // A Short's own choices win over the channel's
    assert.equal(planFromDraft(null, project(), analysis, { ...plan, voiceStyle: 'info', voice: '' }, channel).voiceStyle, 'info');
  });

  it('ends the description with the channel footer', () => {
    const p = project();
    p.plan = planFromDraft(null, p, analysis);
    p.plan.description = 'He did not see it coming.';
    p.plan.tags = ['gta 6 funny moments'];
    const d = composeUploadDescription(p, DEFAULT_CHANNEL);
    assert.match(d, /^He did not see it coming\.\n\n🎥 Clip by @clipper \(https:\/\/x\.com\/a\/status\/1\)\n\nNew GTA 6/);
    assert.match(d, /#Shorts #GTA6 #GTAVI #GTA6FunnyMoments/);
  });

  it('brands captions: palette, font, closing line and @handle', () => {
    const brand = shortBranding(DEFAULT_CHANNEL, 20_000);
    assert.equal(brand.highlightHex, '#ff3ea5');
    assert.deepEqual(brand.closing, { text: 'Follow for daily GTA 6', startMs: 17_500, endMs: 20_000, position: 'top' });
    assert.equal(shortBranding(DEFAULT_CHANNEL, 6_000).closing, null);
    assert.equal(shortBranding({ ...DEFAULT_CHANNEL, handleMark: false }, 20_000).mark, undefined);

    const { assContent, dialogues } = generateAssCaptions({
      beats: [{ index: 0, text: '' }],
      units: [{ unit_index: 0, duration_ms: 20_000 }],
      beatStartMs: [0],
      words: { 0: [] },
      preset: 'social_pop',
      resolution: { width: 1080, height: 1920 },
      highlightHex: brand.highlightHex,
      bannerHex: brand.bannerHex,
      fontName: brand.fontName,
      mark: brand.mark,
      banners: [brand.closing!],
    });
    assert.match(assContent, /Style: Banner, Segoe UI Black,/);
    assert.match(assContent, /Style: Mark, Segoe UI Black, 38, .*, 9, /);
    assert.ok(dialogues.some((d) => d.style === 'Banner' && d.text === '{\\c&H2BA6FF&}Follow for daily GTA 6'));
    assert.ok(dialogues.some((d) => d.style === 'Mark' && d.text === '@TheLuciaJasonDaily' && d.endMs === 20_000));
  });

  it('lets on-screen texts give way to the closing line', () => {
    const closing = { text: 'Follow', startMs: 17_500, endMs: 20_000, position: 'top' as const };
    const out = withClosing(
      [
        { text: 'hook', startMs: 0, endMs: 2500, position: 'top' as const },
        { text: 'lol', startMs: 16_000, endMs: 19_000, position: 'top' as const },
        { text: 'late', startMs: 17_400, endMs: 19_000, position: 'top' as const },
      ],
      closing,
    );
    assert.deepEqual(out.map((b) => [b.text, b.endMs]), [['hook', 2500], ['lol', 17_500], ['Follow', 20_000]]);
  });
});

describe('channel in compilations', () => {
  const c = { format: 'short' as const, theme: 'Police chases', items: [{ title: 'Bike bail', description: 'A crash', recipe: 'chase', creator: '@a' }] } as unknown as Parameters<typeof buildCompilationPrompt>[0];
  it('briefs the writer and signs off with the closing line', () => {
    const prompt = buildCompilationPrompt(c, DEFAULT_CHANNEL);
    assert.match(prompt, /CHANNEL\n- Name: Lucia & Jason Daily/);
    assert.match(prompt, /End with the channel's sign-off: "Follow for daily GTA 6"/);
    assert.equal(fallbackScript(c, DEFAULT_CHANNEL).outro, 'Which one was your favourite? Follow for daily GTA 6.');
    assert.match(channelPromptBlock(DEFAULT_CHANNEL), /fan channel/);
  });
});
