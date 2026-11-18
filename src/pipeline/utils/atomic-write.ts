import * as fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const LOCKED = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Writes a file so readers never see half of it: written beside the target, then renamed over it.
 * On Windows the rename fails while another request has the target open for reading, so it is
 * retried for a moment before giving up.
 */
export async function writeFileAtomic(target: string, data: string, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  const tmp = `${target}.${randomBytes(3).toString('hex')}.tmp`;
  await fs.writeFile(tmp, data, 'utf-8');
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!LOCKED.has(code) || attempt >= 20) {
        await fs.unlink(tmp).catch(() => {});
        throw err;
      }
      await wait(25 + attempt * 25);
    }
  }
}
