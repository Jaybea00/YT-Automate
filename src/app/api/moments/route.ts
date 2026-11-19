import { NextResponse } from 'next/server';
import { listLibrary } from '@/pipeline/compile/library';
import { suggestThemes } from '@/pipeline/compile/select';

/** Everything that can go into a compilation (hunted moments and clips), plus themes it can fill. */
export async function GET() {
  const items = await listLibrary();
  return NextResponse.json({
    items: items.map((i) => ({
      key: i.key,
      kind: i.kind,
      title: i.title,
      description: i.description,
      recipe: i.recipe,
      score: i.score,
      creator: i.creator,
      platform: i.platform,
      pageUrl: i.pageUrl,
      durationSec: Math.round((i.end - i.start) * 10) / 10,
      hasThumb: Boolean(i.thumb),
      usedIn: i.usedIn,
      createdAt: i.createdAt,
    })),
    themes: suggestThemes(items),
  });
}
