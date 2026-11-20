import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildUploadChecks, hardToRead, missingCredits, tagChars, uploadVerdict, type UploadCheckInput } from '../../src/pipeline/publish/upload-check.ts';

const ready: UploadCheckInput = {
  videoId: 'v1',
  rendered: true,
  qualityReport: { passed: true, checks: [{ status: 'pass', label: 'Loudness' }] },
  openNotes: [],
  title: 'You Won the Wrong Game',
  description: 'Hook line.\n\n0:00 Intro\n1:10 The trap\n\nMusic: "Darkest Child" Kevin MacLeod (incompetech.com), CC BY 4.0',
  credits: 'Music:\n"Darkest Child" Kevin MacLeod (incompetech.com), CC BY 4.0',
  chapters: '0:00 Intro\n1:10 The trap',
  tags: ['arrival fallacy', 'psychology'],
  thumbnailTexts: ['EMPTY?', 'NOW WHAT', 'NOT MY DREAM'],
  hasTimeline: true,
  endScreenSec: 11.4,
  drawn: true,
  aiVisuals: [],
  permissionFootage: 0,
};

const byId = (input: UploadCheckInput) => Object.fromEntries(buildUploadChecks(input).map((c) => [c.id, c]));

describe('ready-to-upload check', () => {
  it('passes a finished, credited video, with what to answer in Studio', () => {
    const checks = byId(ready);
    assert.deepEqual(uploadVerdict(Object.values(checks)), { ready: true, fail: 0, warn: 0 });
    assert.equal(checks['ai-use'].label, 'AI use: No');
    assert.match(checks['ai-use'].detail, /Drawn animation/);
    assert.match(checks['end-screen'].detail, /last 11 s/);
    assert.equal(checks.kids.status, 'info');
  });

  it('fails what hurts a live video: no render, failed check, high AI notes, missing credits, too many tags', () => {
    const checks = byId({
      ...ready,
      rendered: false,
      qualityReport: { passed: false, checks: [{ status: 'fail', label: 'Loudness' }, { status: 'warn', label: 'Dead air' }] },
      openNotes: [{ source: 'ai', severity: 'high' }, {}],
      description: 'Hook line only.',
      tags: Array.from({ length: 60 }, (_, i) => `long tag number ${i}`),
    });
    for (const id of ['rendered', 'quality', 'notes', 'description', 'tags']) assert.equal(checks[id].status, 'fail', id);
    assert.match(checks.quality.detail, /Failed: Loudness/);
    assert.match(checks.notes.detail, /2 open notes, 1 marked high/);
    assert.match(checks.description.detail, /1 required credit is missing: "Darkest Child"/);
    assert.equal(checks.chapters.status, 'warn');
    assert.equal(uploadVerdict(Object.values(checks)).ready, false);
  });

  it('warns about long titles, hard-to-read thumbnails and realistic AI pictures', () => {
    const checks = byId({
      ...ready,
      title: 'Why Winning Everything You Ever Wanted Can Leave You Feeling Completely Empty',
      thumbnailTexts: ['WRONG DIPLOMA CHASED BY YOU', 'EMPTY?'],
      drawn: false,
      aiVisuals: ['AI illustration (Pollinations)', 'AI Motion Video'],
    });
    assert.equal(checks.title.status, 'warn');
    assert.match(checks.thumbnails.detail, /WRONG DIPLOMA CHASED BY YOU/);
    assert.match(checks.thumbnails.detail, /2 thumbnails|Hard to read/);
    assert.equal(checks['ai-use'].label, 'AI use: likely Yes');
    assert.match(checks['ai-use'].detail, /2 AI-made pictures or clips/);
    assert.ok(checks.title.fix?.href === '#publish-title');
  });

  it('matches credits word for word and counts tags as YouTube does', () => {
    assert.deepEqual(missingCredits('… "darkest child" kevin macleod (incompetech.com), cc by 4.0 …', ready.credits), []);
    assert.deepEqual(missingCredits('', 'Footage:\n- Clip by Jane (CC BY)'), ['Clip by Jane (CC BY)']);
    assert.equal(tagChars(['a b', 'c']), 7);
    assert.deepEqual(hardToRead(['NOW WHAT', 'A VERY LONG HEADLINE HERE TODAY']), ['A VERY LONG HEADLINE HERE TODAY']);
  });

  it('notes streamers’ footage that needs permission on record', () => {
    assert.match(byId({ ...ready, permissionFootage: 3 }).permission.detail, /3 shots use streamers/);
    assert.equal(byId(ready).permission, undefined);
  });
});
