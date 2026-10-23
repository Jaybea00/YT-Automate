import * as fsp from 'node:fs/promises';
import { listLibrary } from '@/pipeline/visuals/clip-library';

/** A clip's thumbnail. */
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const clip = (await listLibrary()).find((c) => c.id === id);
  const bytes = clip ? await fsp.readFile(clip.thumbPath).catch(() => null) : null;
  if (!bytes) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600' } });
}
