import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFfprobePath } from '../utils/ffmpeg';

const execFileAsync = promisify(execFile);

/**
 * The joined scenes of an assembly, kept until the render finishes. Joining a long video's scenes
 * with transitions takes up to an hour on a small laptop; if the run stops after that (a shutdown
 * during mastering), the next run reuses the join when its scenes and transitions are unchanged.
 */

export interface JoinResult {
  overlapSec: number;
  overlapsSec: number[];
}

/** A fingerprint of the scene files (path, size, modified time) and how they're joined. */
export async function joinFingerprint(scenePaths: string[], settings: unknown): Promise<string> {
  const files = await Promise.all(
    scenePaths.map(async (p) => {
      const st = await fs.stat(p).catch(() => null);
      return [p, st?.size ?? 0, Math.round(st?.mtimeMs ?? 0)];
    }),
  );
  return crypto.createHash('sha256').update(JSON.stringify({ files, settings })).digest('hex');
}

const sidecar = (checkpoint: string) => `${checkpoint}.json`;

/** The kept join, if it matches `key` and the file is whole (a cut-off file has no index). */
export async function readJoinCheckpoint(checkpoint: string, key: string): Promise<JoinResult | null> {
  const saved = await fs
    .readFile(sidecar(checkpoint), 'utf-8')
    .then((s) => JSON.parse(s) as { key: string } & JoinResult)
    .catch(() => null);
  if (!saved || saved.key !== key || !Array.isArray(saved.overlapsSec)) return null;
  try {
    const { stdout } = await execFileAsync(getFfprobePath(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', checkpoint]);
    if (!(Number.parseFloat(stdout.trim()) > 0)) return null;
  } catch {
    return null;
  }
  return { overlapSec: saved.overlapSec, overlapsSec: saved.overlapsSec };
}

/** Keeps a finished join (moved into place) with its fingerprint. */
export async function writeJoinCheckpoint(joinedPath: string, checkpoint: string, key: string, joined: JoinResult): Promise<void> {
  if (joinedPath !== checkpoint) await fs.rename(joinedPath, checkpoint);
  await fs.writeFile(sidecar(checkpoint), JSON.stringify({ key, overlapSec: joined.overlapSec, overlapsSec: joined.overlapsSec }), 'utf-8');
}

/** Removes the kept join once the render is done. */
export async function clearJoinCheckpoint(checkpoint: string): Promise<void> {
  await Promise.all([fs.rm(checkpoint, { force: true }), fs.rm(sidecar(checkpoint), { force: true })]).catch(() => {});
}
