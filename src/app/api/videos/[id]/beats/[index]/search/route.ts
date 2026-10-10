import { NextResponse } from 'next/server';
import { aggregateMediaCandidates } from '@/pipeline/visuals/media-aggregator';

interface RouteContext {
  params: Promise<{ id: string; index: string }>;
}

export async function POST(req: Request, context: RouteContext) {
  try {
    const { id: videoId, index: indexStr } = await context.params;
    const beatIndex = parseInt(indexStr, 10);

    if (!videoId || isNaN(beatIndex) || beatIndex < 0) {
      return NextResponse.json({ error: 'Invalid videoId or beatIndex' }, { status: 400 });
    }

    const body = await req.json();
    const query = (body.query || '').trim();

    if (!query) {
      return NextResponse.json({ error: 'Search query is required' }, { status: 400 });
    }

    const { candidates, intent } = await aggregateMediaCandidates({
      query,
      text: query,
      explicitType: body.type,
      limit: 6,
    });

    return NextResponse.json({
      success: true,
      query,
      intent,
      candidates,
    });
  } catch (err) {
    console.error('[Search] Error searching media candidates:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
