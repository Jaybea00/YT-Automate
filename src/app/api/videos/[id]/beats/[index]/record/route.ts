import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { prepareRecording, saveBeatVoice } from '@/pipeline/tts/beat-voice-store';
import { handleRegenTts } from '../regen-tts/route';

interface RouteContext {
  params: Promise<{ id: string; index: string }>;
}

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Multipart `audio`: the creator's own recording of this beat (from the microphone), cleaned up
 * and used as the beat's narration from now on (voicing runs keep it until it's removed).
 */
export async function POST(req: Request, context: RouteContext) {
  const { id, index } = await context.params;
  const beatIndex = Number.parseInt(index, 10);
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || !Number.isInteger(beatIndex) || beatIndex < 0) {
    return NextResponse.json({ error: 'Invalid video or beat' }, { status: 400 });
  }
  const form = await req.formData().catch(() => null);
  const file = form?.get('audio');
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: 'No recording received' }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'The recording is too long' }, { status: 413 });

  const tmp = path.join(os.tmpdir(), `beat-recording-${Date.now()}${path.extname(file.name) || '.webm'}`);
  const supabase = getSupabaseServerClient();
  try {
    await fs.writeFile(tmp, Buffer.from(await file.arrayBuffer()));
    const recorded = await prepareRecording(tmp, id, beatIndex);
    const voice = await saveBeatVoice(supabase, id, beatIndex, { recorded });
    const voiced = await handleRegenTts(new Request(req.url, { method: 'POST', body: '{}' }), id, String(beatIndex), supabase);
    const result = await voiced.json();
    if (!voiced.ok) return NextResponse.json({ error: result.error, voice }, { status: voiced.status });
    return NextResponse.json({ voice, ...result });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  } finally {
    await fs.rm(tmp, { force: true });
  }
}
