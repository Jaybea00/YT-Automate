import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { rendersDir } from '@/pipeline/publish/publish-assets';
import { loadFootageUsage, usedElsewhere } from '@/pipeline/visuals/footage-usage';
import { loadStoryboard, type StoryboardShot } from '@/pipeline/visuals/storyboard';
import { measureShot, reviewStoryboard, type ShotLook, type StoryboardIssue } from '@/pipeline/visuals/storyboard-review';

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface SavedReview {
  reviewedAt: string;
  shotsReviewed: number;
  issues: StoryboardIssue[];
  /** Whether the local model's text/logo check ran. */
  textCheck: boolean;
}

const reviewFile = (videoId: string) => path.join(rendersDir(videoId), 'storyboard-review.json');
const publicShot = ({ clipPath: _clip, ...rest }: StoryboardShot) => rest;

/** The video's shots in order, with the last review. */
export async function GET(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!/^[\w-]+$/.test(id)) return NextResponse.json({ error: 'Invalid video' }, { status: 400 });
  const board = await loadStoryboard(getSupabaseServerClient(), id);
  const review = (await fs.readFile(reviewFile(id), 'utf-8').then((t) => JSON.parse(t) as SavedReview).catch(() => null)) ?? null;
  return NextResponse.json({ shots: board.shots.map(publicShot), missingBeats: board.missingBeats, review });
}

/** Reviews the whole storyboard (measuring each shot's frame once) and saves the result. */
export async function POST(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!/^[\w-]+$/.test(id)) return NextResponse.json({ error: 'Invalid video' }, { status: 400 });
  try {
    const board = await loadStoryboard(getSupabaseServerClient(), id);
    if (!board.shots.length) return NextResponse.json({ error: 'No rendered shots yet: source the visuals first.' }, { status: 400 });
    const looks = new Map<number, ShotLook>();
    let useModel = process.env.CLIP_LOCAL_LOOK !== 'false';
    for (const shot of board.shots) {
      let look: ShotLook | undefined;
      try {
        look = await measureShot(shot, useModel);
      } catch (err) {
        // Most likely the local model: carry on without the text/logo check (a shot whose frame
        // can't be read is simply left out of the comparisons)
        if (useModel) {
          useModel = false;
          console.warn('[Storyboard] Text/logo check unavailable:', err instanceof Error ? err.message.slice(0, 160) : err);
          look = await measureShot(shot, false).catch(() => undefined);
        }
      }
      if (look) looks.set(shot.order, look);
    }
    const usage = await loadFootageUsage();
    const issues = reviewStoryboard(board.shots, looks, (url) => usedElsewhere(usage, url, id));
    const review: SavedReview = { reviewedAt: new Date().toISOString(), shotsReviewed: looks.size, issues, textCheck: useModel };
    await fs.mkdir(rendersDir(id), { recursive: true });
    await fs.writeFile(reviewFile(id), JSON.stringify(review, null, 2), 'utf-8');
    return NextResponse.json({ shots: board.shots.map(publicShot), missingBeats: board.missingBeats, review });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
