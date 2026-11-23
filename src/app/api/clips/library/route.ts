import * as path from 'node:path';
import { NextResponse } from 'next/server';
import { emojiNames } from '@/pipeline/clipping/emojis';
import { listLibrary } from '@/pipeline/clipping/memes';
import { BUILTIN_SOUNDS, soundLibraryDir } from '@/pipeline/clipping/sounds';

/** What the emoji and sound libraries hold, as names to pick from on the clip page. */
export async function GET() {
  const sounds = (await listLibrary(soundLibraryDir(), /\.(mp3|wav|m4a|aac|ogg|opus|flac)$/i)).map((f) =>
    path
      .basename(f)
      .replace(/\.[a-z0-9]{2,4}$/i, '')
      // "Vine Boom sound effect meme" -> "Vine Boom": the words that name the sound
      .replace(/\s*[-–(].*$|\s*sound effect.*$/i, '')
      .trim(),
  );
  return NextResponse.json({
    emojis: await emojiNames(),
    sounds: [...new Set([...sounds.filter(Boolean), ...BUILTIN_SOUNDS.map((s) => s.names[0])])].sort((a, b) => a.localeCompare(b)),
  });
}
