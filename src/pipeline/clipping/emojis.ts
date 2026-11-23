import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { libraryMatches, listLibrary } from './memes';

/**
 * Emoji pop-ups can be a typed emoji (drawn with the system's colour emoji) or a picture from the
 * emoji library, storage/emojis, found by name ("skull exploding", "blue guy holding laugh"):
 * transparent PNGs (or GIF/WebP) named by what they show.
 */

export const emojiLibraryDir = () => process.env.EMOJI_LIBRARY_DIR || path.join(process.cwd(), 'storage', 'emojis');
const IMAGES = /\.(png|gif|webp)$/i;

/** A typed emoji (one or a few emoji characters, nothing else). */
export const isEmojiChar = (s: string) => /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️)+$/u.test(s) && !/^[\d#*]+$/.test(s);

/** The library picture for a name, as an absolute path; null when none matches. */
export async function findEmojiImage(name: string, dir = emojiLibraryDir()): Promise<string | null> {
  const match = libraryMatches(await listLibrary(dir, IMAGES), name)[0];
  return match ? path.join(dir, match) : null;
}

/** The picture as a data URL, for drawing it in the browser. */
export async function emojiImageDataUrl(file: string): Promise<string> {
  const ext = path.extname(file).slice(1).toLowerCase();
  return `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${(await fs.readFile(file)).toString('base64')}`;
}

/** Names of the library's emoji, for the page and the writer. */
export async function emojiNames(dir = emojiLibraryDir()): Promise<string[]> {
  return (await listLibrary(dir, IMAGES)).map((f) => path.basename(f).replace(IMAGES, ''));
}
