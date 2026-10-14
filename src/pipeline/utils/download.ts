import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/** Default cap for a single sourced media file; whole archive films can run to hundreds of MB. */
export const MAX_MEDIA_BYTES = 80 * 1024 * 1024;

export class DownloadTooLargeError extends Error {
  constructor(url: string, bytes: number, maxBytes: number) {
    super(`Download from ${url} exceeds ${Math.round(maxBytes / 1048576)} MB (${Math.round(bytes / 1048576)} MB)`);
    this.name = 'DownloadTooLargeError';
  }
}

/**
 * Streams a URL to disk, refusing files larger than `maxBytes` (checked against Content-Length
 * up front and enforced while streaming). A partial file is removed on any failure.
 */
export async function downloadToFile(
  url: string,
  targetPath: string,
  options: { maxBytes?: number; signal?: AbortSignal; headers?: Record<string, string> } = {},
): Promise<string> {
  const { maxBytes = MAX_MEDIA_BYTES, signal, headers } = options;
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });

  const res = await fetch(url, { signal, headers: { 'User-Agent': 'YT-Automation/1.0 (media sourcing)', ...headers } });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed from ${url} (HTTP ${res.status})`);
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body.cancel().catch(() => {});
    throw new DownloadTooLargeError(url, declared, maxBytes);
  }

  const file = fs.createWriteStream(targetPath);
  let received = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new DownloadTooLargeError(url, received, maxBytes);
      }
      if (!file.write(value)) await new Promise<void>((resolve) => file.once('drain', () => resolve()));
    }
    await new Promise<void>((resolve, reject) => file.end((err?: Error | null) => (err ? reject(err) : resolve())));
    return targetPath;
  } catch (err) {
    // Wait for the stream to finish opening and close; deleting first races the lazy open on
    // Windows and the partial file reappears
    await new Promise<void>((resolve) => {
      file.once('close', () => resolve());
      file.destroy();
    });
    await fsp.unlink(targetPath).catch(() => {});
    throw err;
  }
}
