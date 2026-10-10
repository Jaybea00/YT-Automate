import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSafeWebStream } from '../../src/lib/streaming';

describe('Streaming Utility Tests', () => {
  let tempDir: string;
  let testFile: string;
  const sampleData = Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(100)); // 3600 bytes

  before(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'yt-stream-test-'));
    testFile = path.join(tempDir, 'sample.bin');
    await fsp.writeFile(testFile, sampleData);
  });

  after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('1. Streams complete file into web stream correctly', async () => {
    const fileStream = fs.createReadStream(testFile);
    const webStream = createSafeWebStream(fileStream);

    const reader = webStream.getReader();
    const chunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }

    const result = Buffer.concat(chunks);
    assert.equal(result.length, sampleData.length);
    assert.deepEqual(result, sampleData);
  });

  it('2. Streams range slices correctly', async () => {
    const start = 10;
    const end = 50;
    const fileStream = fs.createReadStream(testFile, { start, end });
    const webStream = createSafeWebStream(fileStream);

    const reader = webStream.getReader();
    const chunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }

    const result = Buffer.concat(chunks);
    assert.equal(result.length, end - start + 1);
    assert.deepEqual(result, sampleData.subarray(start, end + 1));
  });

  it('3. Client cancel does not throw ERR_INVALID_STATE or unhandled exception', async () => {
    const fileStream = fs.createReadStream(testFile);
    const webStream = createSafeWebStream(fileStream);

    const reader = webStream.getReader();
    // Read only the first chunk then cancel
    const { done, value } = await reader.read();
    assert.equal(done, false);
    assert.ok(value && value.length > 0);

    // Cancel abruptly (simulates browser closing 206 connection after reading moov atom)
    await reader.cancel('Aborted by client');

    // Wait for event loop ticks to ensure any trailing events on fileStream don't throw
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fileStream.destroyed, true);
  });

  it('4. AbortSignal abort immediately destroys stream without throwing', async () => {
    const abortController = new AbortController();
    const fileStream = fs.createReadStream(testFile);
    const webStream = createSafeWebStream(fileStream, { signal: abortController.signal });

    const reader = webStream.getReader();
    await reader.read();

    abortController.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fileStream.destroyed, true);
  });
});
