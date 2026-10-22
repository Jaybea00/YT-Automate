import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { STYLE_PACKS, STYLE_IDS, isVideoStyle, stylePack, withStyleDefaults } from '../../src/lib/styles/packs.ts';
import { ALL_THEMES } from '../../src/lib/styles/themes.ts';
import { STYLE_TEMPLATES, styleVoice } from '../../src/lib/script/style-templates.ts';
import { themeForStyle } from '../../src/pipeline/visuals/motion/theme.ts';
import { lookFilter } from '../../src/pipeline/assembly/look.ts';
import { deliveryForStyle } from '../../src/pipeline/tts/delivery.ts';
import { MOODS } from '../../src/pipeline/assembly/music-library.ts';
import { CAPTION_PRESETS } from '../../src/pipeline/assembly/captions.ts';
import { planShotsWith, repairRhythm } from '../../src/lib/script/shot-planner.ts';
import { analyzeRhythm, planToRhythmShots } from '../../src/lib/script/visual-rhythm.ts';
import type { LLMProvider } from '../../src/pipeline/providers/types.ts';
import type { ScriptBeat, ShotPlan, ShotType } from '../../src/lib/script/generate-script.ts';

/** WCAG relative-luminance contrast between two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

describe('Style packs', () => {
  it('includes the original nine styles and the seven niches', () => {
    for (const id of ['tech', 'cinematic', 'modernmba', 'listicle', 'story_driven', 'comparison', 'eli5', 'true_crime_pov', 'vox_explainer', 'car', 'sport', 'finance', 'space_science', 'tech_review', 'history', 'mystery']) {
      assert.ok(isVideoStyle(id), id);
    }
    assert.equal(STYLE_IDS.length, 16);
  });

  it('defines every pack completely and consistently', () => {
    for (const [key, p] of Object.entries(STYLE_PACKS)) {
      assert.equal(p.id, key);
      for (const field of ['name', 'label', 'description', 'shortName', 'tagline', 'icon', 'voice', 'delivery'] as const) {
        assert.ok(p[field].trim().length > 0, `${key}.${field}`);
      }
      assert.ok(ALL_THEMES.includes(p.theme), `${key} uses a registered theme`);
      assert.ok((MOODS as readonly string[]).includes(p.fallbackMood), `${key} mood`);
      const d = (p as { defaults?: { captionPreset?: string } }).defaults;
      if (d?.captionPreset) assert.ok((CAPTION_PRESETS as string[]).includes(d.captionPreset), `${key} caption preset`);
      const share = (p as { maxGraphicsShare?: number }).maxGraphicsShare;
      if (share !== undefined) assert.ok(share > 0.2 && share < 0.8, `${key} graphics share`);
    }
  });

  it('gives every theme readable text and a grade', () => {
    const names = new Set<string>();
    for (const t of ALL_THEMES) {
      assert.ok(!names.has(t.name), `unique theme name ${t.name}`);
      names.add(t.name);
      assert.ok(contrast(t.text, t.background) >= 4.5, `${t.name} text contrast ${contrast(t.text, t.background).toFixed(1)}`);
      assert.ok(contrast(t.text, t.surface) >= 4.5, `${t.name} card text contrast`);
      assert.ok(contrast(t.accentText, t.background) >= 3, `${t.name} accent text contrast ${contrast(t.accentText, t.background).toFixed(1)}`);
      assert.ok(lookFilter(t.name), `${t.name} has a grade`);
    }
  });

  it('feeds every stage from the pack', () => {
    for (const id of STYLE_IDS) {
      const p = STYLE_PACKS[id];
      assert.equal(themeForStyle(id), p.theme);
      assert.equal(deliveryForStyle(id), p.delivery);
      assert.ok(STYLE_TEMPLATES[id].systemPrompt.startsWith(p.voice), `${id} prompt starts with its voice`);
      assert.match(STYLE_TEMPLATES[id].systemPrompt, /RETENTION CRAFT/);
      assert.equal(styleVoice(id).replace(/\s+/g, ' '), p.voice.replace(/\s+/g, ' ').trim());
    }
    assert.equal(stylePack('not_a_style'), undefined);
    assert.equal(themeForStyle('not_a_style').name, 'documentary', 'unknown styles keep the documentary look');
  });

  it('sets a new niche video\'s starting captions and transition, never overriding existing settings', () => {
    assert.deepEqual(withStyleDefaults({ beats: [] }, 'car'), { beats: [], captions: { preset: 'social_pop' }, transition: 'cut' });
    assert.deepEqual(withStyleDefaults({ beats: [] }, 'vox_explainer'), { beats: [] }, 'original styles keep their behaviour');
    const own = { beats: [], captions: { preset: 'vox' }, transition: 'wipe' };
    assert.deepEqual(withStyleDefaults(own, 'sport'), { ...own, beat_pause_seconds: 1 }, 'own captions and transition kept; only the missing beat pause is added');
  });
});

describe('Style packs in the shot director', () => {
  const beat = (index: number): ScriptBeat => ({
    index,
    text: 'The new engine makes more power than any car before it, and the numbers prove it on the track.',
    visual_type: 'stock',
    visual_query: 'sports car',
    duration_estimate_seconds: 6,
  });
  const recordingLlm = (prompts: string[]): LLMProvider => ({
    kind: 'llm',
    id: 'mock',
    generateText: async () => ({ text: '', usage: {} }),
    generateJson: async (req) => {
      prompts.push(req.prompt);
      return { data: { beats: [] } as never, usage: {} };
    },
  });

  it('adds a niche pack\'s notes to the director prompt, and nothing for the original styles', async () => {
    const carPrompts: string[] = [];
    await planShotsWith(recordingLlm(carPrompts), { apiKey: 'k' }, { title_options: [], beats: [beat(0)] }, 'Cars', { style: 'car' });
    assert.match(carPrompts[0], /STYLE NOTES/);
    assert.match(carPrompts[0], /never put a caption or annotation naming a specific make or model on stock/);

    const voxPrompts: string[] = [];
    await planShotsWith(recordingLlm(voxPrompts), { apiKey: 'k' }, { title_options: [], beats: [beat(0)] }, 'Topic', { style: 'vox_explainer' });
    assert.doesNotMatch(voxPrompts[0], /STYLE NOTES/);
  });

  it('applies the pack\'s graphics limit', () => {
    const types: ShotType[] = ['stat', 'stock', 'chart', 'stock', 'comparison', 'stock', 'timeline', 'stock', 'geo_map', 'stock'];
    const beats = types.map((t, i): ScriptBeat => ({ ...beat(i), shots: [{ visual_type: t, visual_query: 'q', covers: 'a b c d e', word_start: 0, word_count: 10 } as ShotPlan] }));
    // 5 of 10 shots are graphics: fine at the default 55%, too many for Car's 45%
    assert.equal(repairRhythm(beats).fixes.filter((f) => f.rule === 'graphics_share').length, 0);
    const car = repairRhythm(beats, STYLE_PACKS.car.maxGraphicsShare);
    assert.ok(car.fixes.some((f) => f.rule === 'graphics_share'));
    assert.ok(analyzeRhythm(planToRhythmShots(car.beats), 'plan', [], 0.45).graphicsShare <= 0.45);
  });
});
