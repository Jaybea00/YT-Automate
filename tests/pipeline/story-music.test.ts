import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildExpression, buildMusicBed, segmentDurations } from '../../src/pipeline/assembly/music-bed.ts';
import { ensureMusicPlan, musicCredits, pickMusic, type MusicSegment } from '../../src/pipeline/assembly/music-plan.ts';
import { starterCredit, starterUrl, type Mood, type MusicTrack } from '../../src/pipeline/assembly/music-library.ts';
import { buildDescriptionCredits } from '../../src/pipeline/utils/credits.ts';
import type { LLMProvider } from '../../src/pipeline/providers/types.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

const execFileAsync = promisify(execFile);
const track = (title: string, credit: string | null = null): MusicTrack => ({ path: `/music/${title}.mp3`, title, credit, source: 'yours' });

describe('Music that follows the story', () => {
  it('centres each mood change on its section change, keeping the bed exactly as long as the video', () => {
    const d = segmentDurations([{ startMs: 0, endMs: 60_000 }, { startMs: 60_000, endMs: 100_000 }, { startMs: 100_000, endMs: 150_000 }], 3);
    assert.deepEqual(d, [61.5, 43, 51.5]);
    assert.equal(d.reduce((a, b) => a + b, 0) - 2 * 3, 150, 'two 3 s crossfades');
    assert.deepEqual(segmentDurations([{ startMs: 0, endMs: 42_000 }]), [42]);
    assert.match(buildExpression([60]), /^1\+0\.3\*\(min\(max\(0,min\(1,\(t-57\.000\)\/2\.5\)\),max\(0,min\(1,\(62\.000-t\)\/1\.5\)\)\)\)$/);
    assert.equal(buildExpression([]), '1');
  });

  it('continues one track through sections of the same mood, and never repeats a track back to back', async () => {
    const library: Record<string, MusicTrack[]> = { tense: [track('A'), track('B')], somber: [track('C')], calm: [] };
    const segments = await pickMusic(
      [
        { startMs: 0, endMs: 10_000, mood: 'tense' },
        { startMs: 10_000, endMs: 20_000, mood: 'tense' },
        { startMs: 20_000, endMs: 30_000, mood: 'somber' },
        { startMs: 30_000, endMs: 40_000, mood: 'tense' },
      ],
      async (m: Mood) => library[m] ?? [],
    );
    assert.deepEqual(segments!.map((s) => [s.mood, s.track.title, s.startMs, s.endMs]), [
      ['tense', 'A', 0, 20_000],
      ['somber', 'C', 20_000, 30_000],
      ['tense', 'B', 30_000, 40_000],
    ]);
    assert.equal(await pickMusic([{ startMs: 0, endMs: 1, mood: 'hopeful' }], async () => []), null);
  });

  it('plans moods with the LLM once, and keeps them while the script is unchanged', async () => {
    let calls = 0;
    const llm: LLMProvider = {
      kind: 'llm',
      id: 'mock',
      generateText: async () => ({ text: '', usage: {} }),
      generateJson: async () => {
        calls++;
        return { data: { sections: [{ index: 0, mood: 'tense' }, { index: 1, mood: 'somber' }] } as never, usage: {} };
      },
    };
    const scriptJson = { beats: Array.from({ length: 8 }, (_, i) => ({ text: `beat ${i}` })) };
    const { supabase, db } = createMockSupabase({ videos: [{ id: 'v1', script_json: scriptJson }] });
    const sections = [{ start_beat: 0, title: 'Crash' }, { start_beat: 4, title: 'Fallout' }];
    const moods = await ensureMusicPlan({ supabase, videoId: 'v1', scriptJson, sections, llm: { provider: llm, ctx: { apiKey: 'k' } } });
    assert.deepEqual(moods, ['tense', 'somber']);
    const saved = db.videos[0].script_json;
    await ensureMusicPlan({ supabase, videoId: 'v1', scriptJson: saved, sections, llm: { provider: llm, ctx: { apiKey: 'k' } } });
    assert.equal(calls, 1, 'reused, not re-planned');

    const fallback = await ensureMusicPlan({ supabase, videoId: 'v1', scriptJson: { beats: [{ text: 'new' }] }, sections: [{ start_beat: 0, title: 'x' }], style: 'true_crime_pov' });
    assert.deepEqual(fallback, ['tense'], 'without an LLM the style picks the mood');
  });

  it('credits each starter track once, in the licence\'s format', () => {
    const credit = starterCredit('Darkest Child');
    assert.equal(credit, '"Darkest Child" Kevin MacLeod (incompetech.com)\nLicensed under Creative Commons: By Attribution 4.0 License\nhttp://creativecommons.org/licenses/by/4.0/');
    assert.equal(starterUrl('Ossuary 1 - A Beginning'), 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Ossuary%201%20-%20A%20Beginning.mp3');
    const seg = (t: MusicTrack): MusicSegment => ({ startMs: 0, endMs: 1, mood: 'tense', track: t });
    assert.deepEqual(musicCredits([seg(track('A', 'credit A')), seg(track('B')), seg(track('A', 'credit A'))]), ['credit A']);
  });

  it('collects the description credits the licences require', () => {
    const text = buildDescriptionCredits(['"Sad Trio" Kevin MacLeod'], [
      { license_type: 'cc_by_sa', attribution_text: 'Photo by Jane Doe · Bain News Service' },
      { license_type: 'public_domain', attribution_text: 'Library of Congress' },
      { license_type: 'cc_by', attribution_text: 'Photo by Jane Doe' },
    ]);
    assert.equal(text, 'Music:\n"Sad Trio" Kevin MacLeod\n\nImages and footage:\n• Photo by Jane Doe (CC BY-SA)\n• Bain News Service (CC BY-SA)\n• Photo by Jane Doe (CC BY)');
    assert.equal(buildDescriptionCredits([], [{ license_type: 'royalty_free', attribution_text: 'Pixabay' }]), '');
  });
});

describe('Rendering the music bed', () => {
  let dir: string;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'music-bed-'));
  });
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('crossfades tracks at the section change, looping a track that is shorter than its section', async () => {
    const a = path.join(dir, 'a.wav');
    const b = path.join(dir, 'b.wav');
    await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=220:r=48000', '-t', '4', a]);
    await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=660:r=48000', '-t', '20', b]);
    const out = path.join(dir, 'bed.m4a');
    await buildMusicBed(
      [
        { startMs: 0, endMs: 10_000, mood: 'tense', track: { path: a, title: 'a', credit: null, source: 'yours' } },
        { startMs: 10_000, endMs: 16_000, mood: 'somber', track: { path: b, title: 'b', credit: null, source: 'yours' } },
      ],
      out,
    );
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]);
    assert.ok(Math.abs(Number.parseFloat(stdout) - 16) < 0.1, `bed is 16 s (${stdout.trim()})`);
    // The 4 s track loops to fill its 10 s section: still sounding at 7 s
    const { stderr } = await execFileAsync('ffmpeg', ['-v', 'info', '-ss', '6.5', '-t', '1', '-i', out, '-af', 'volumedetect', '-f', 'null', '-']);
    assert.ok(Number.parseFloat(stderr.match(/mean_volume: (-?[\d.]+)/)![1]) > -40, 'no gap where the short track ran out');
  });
});
