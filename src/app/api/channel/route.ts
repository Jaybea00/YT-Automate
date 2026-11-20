import { NextResponse } from 'next/server';
import { loadChannelProfile, saveChannelProfile } from '@/pipeline/channel/store';

/** The channel profile every Short and compilation uses. */
export async function GET() {
  return NextResponse.json({ channel: await loadChannelProfile() });
}

/** Saves the profile. Body: { channel: ChannelProfile } (missing fields take the defaults). */
export async function PUT(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { channel?: unknown };
    return NextResponse.json({ channel: await saveChannelProfile(body.channel) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to save the channel profile' }, { status: 500 });
  }
}
