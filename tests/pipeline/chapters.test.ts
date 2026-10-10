import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTimestamp,
  parseTimestampToSeconds,
  extractChapterTitle,
  generateYouTubeChapters,
  parseChaptersText,
} from '../../src/pipeline/utils/chapters';

test('YouTube Chapters Utility', async (t) => {
  await t.test('1. formatTimestamp correctly handles mm:ss and hh:mm:ss', () => {
    assert.equal(formatTimestamp(0), '00:00');
    assert.equal(formatTimestamp(5), '00:05');
    assert.equal(formatTimestamp(65), '01:05');
    assert.equal(formatTimestamp(599), '09:59');
    assert.equal(formatTimestamp(3599), '59:59');

    // >= 3600 seconds switches to hh:mm:ss
    assert.equal(formatTimestamp(3600), '01:00:00');
    assert.equal(formatTimestamp(3665), '01:01:05');
    assert.equal(formatTimestamp(7325), '02:02:05');

    // forceHours flag
    assert.equal(formatTimestamp(45, true), '00:00:45');
  });

  await t.test('2. parseTimestampToSeconds parses mm:ss and hh:mm:ss', () => {
    assert.equal(parseTimestampToSeconds('00:00'), 0);
    assert.equal(parseTimestampToSeconds('01:15'), 75);
    assert.equal(parseTimestampToSeconds('01:02:03'), 3723);
    assert.equal(parseTimestampToSeconds('invalid'), 0);
  });

  await t.test('3. extractChapterTitle cleans titles and extracts headings', () => {
    // Beat 0 default
    assert.equal(
      extractChapterTitle({ index: 0, text: 'Welcome to this complete guide on React.' }, 0),
      'Introduction',
    );

    // Beat 0 with explicit Hook: prefix
    assert.equal(
      extractChapterTitle({ index: 0, text: 'Hook: Stop writing boilerplate code now!' }, 0),
      'Stop writing boilerplate code now',
    );

    // Beat 1 with Step prefix
    assert.equal(
      extractChapterTitle({ index: 1, text: 'Step 1: Setting up your local environment properly.' }, 1),
      'Setting up your local environment properly',
    );

    // Markdown stripping and punctuation cleanup
    assert.equal(
      extractChapterTitle({ index: 2, text: '**Crucial tip:** Always verify your DB indices...' }, 2),
      'Crucial tip: Always verify your DB indices',
    );

    // Custom title override takes precedence
    assert.equal(
      extractChapterTitle({ index: 1, text: 'Step 1: Setup' }, 1, 'My Custom Chapter Title'),
      'My Custom Chapter Title',
    );
  });

  await t.test('4. generateYouTubeChapters uses exact measured TTS duration_ms', () => {
    const beats = [
      { index: 0, text: 'Intro to the video', duration_estimate_seconds: 5 },
      { index: 1, text: 'First main concept and deep dive', duration_estimate_seconds: 10 },
      { index: 2, text: 'Step 2: Practical implementation', duration_estimate_seconds: 15 },
    ];

    // Measured TTS durations from yt_job_units
    const units = [
      { unit_index: 0, duration_ms: 4200 }, // 4.2s -> next starts at 00:04
      { unit_index: 1, duration_ms: 8500 }, // 8.5s -> next starts at 4.2 + 8.5 = 12.7s -> 00:12
      { unit_index: 2, duration_ms: 11000 },
    ];

    const result = generateYouTubeChapters({ beats, units });

    assert.equal(result.chapters.length, 3);
    assert.equal(result.hasMeasuredDurations, true);

    // First chapter ALWAYS at 00:00
    assert.equal(result.chapters[0].beatIndex, 0);
    assert.equal(result.chapters[0].timestamp, '00:00');
    assert.equal(result.chapters[0].startTimeMs, 0);
    assert.equal(result.chapters[0].title, 'Introduction');
    assert.equal(result.chapters[0].isMeasured, true);

    // Second chapter
    assert.equal(result.chapters[1].beatIndex, 1);
    assert.equal(result.chapters[1].startTimeMs, 4200);
    assert.equal(result.chapters[1].timestamp, '00:04');
    assert.equal(result.chapters[1].title, 'First main concept and deep dive');
    assert.equal(result.chapters[1].isMeasured, true);

    // Third chapter
    assert.equal(result.chapters[2].beatIndex, 2);
    assert.equal(result.chapters[2].startTimeMs, 12700);
    assert.equal(result.chapters[2].timestamp, '00:12');
    assert.equal(result.chapters[2].title, 'Practical implementation');
    assert.equal(result.chapters[2].isMeasured, true);

    // Formatted description text
    assert.equal(
      result.formattedText,
      '00:00 - Introduction\n00:04 - First main concept and deep dive\n00:12 - Practical implementation',
    );
  });

  await t.test('5. generateYouTubeChapters falls back to estimated seconds when TTS units absent', () => {
    const beats = [
      { index: 0, text: 'Intro', duration_estimate_seconds: 10 },
      { index: 1, text: 'Body Section', duration_estimate_seconds: 25 },
      { index: 2, text: 'Conclusion', duration_estimate_seconds: 15 },
    ];

    const result = generateYouTubeChapters({ beats });

    assert.equal(result.hasMeasuredDurations, false);
    assert.equal(result.chapters[0].timestamp, '00:00');
    assert.equal(result.chapters[1].timestamp, '00:10');
    assert.equal(result.chapters[2].timestamp, '00:35');
    assert.equal(result.totalDurationSeconds, 50);
  });

  await t.test('6. generateYouTubeChapters supports custom title overrides and space delimiter', () => {
    const beats = [
      { index: 0, text: 'Hook' },
      { index: 1, text: 'Overview' },
    ];
    const units = [
      { unit_index: 0, duration_ms: 15000 },
      { unit_index: 1, duration_ms: 20000 },
    ];

    const result = generateYouTubeChapters({
      beats,
      units,
      customTitles: { 0: 'Welcome to the Channel', 1: 'The Secret Formula' },
      formatStyle: 'space',
    });

    assert.equal(result.chapters[0].title, 'Welcome to the Channel');
    assert.equal(result.chapters[1].title, 'The Secret Formula');
    assert.equal(
      result.formattedText,
      '00:00 Welcome to the Channel\n00:15 The Secret Formula',
    );
  });

  await t.test('7. parseChaptersText extracts timestamps and titles from description strings', () => {
    const raw = `
Check out the video chapters below:
00:00 - Introduction
01:30 - The Hidden Trap
05:45 - Key Takeaways & Outro
Thanks for watching!
`;
    const parsed = parseChaptersText(raw);
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0].timestamp, '00:00');
    assert.equal(parsed[0].title, 'Introduction');
    assert.equal(parsed[0].seconds, 0);

    assert.equal(parsed[1].timestamp, '01:30');
    assert.equal(parsed[1].title, 'The Hidden Trap');
    assert.equal(parsed[1].seconds, 90);

    assert.equal(parsed[2].timestamp, '05:45');
    assert.equal(parsed[2].title, 'Key Takeaways & Outro');
    assert.equal(parsed[2].seconds, 345);
  });
});
