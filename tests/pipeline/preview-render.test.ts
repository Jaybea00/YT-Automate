import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { masterFinalVideo } from '../../src/pipeline/assembly/master.ts';
import { handleGetRender } from '../../src/app/api/videos/[id]/render/route.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

const execFileAsync = promisify(execFile);

async function size(file: string): Promise<string> {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
  return stdout.trim();
}

describe('Quick preview render', () => {
  it('masters a draft at half size, the final at full size', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-'));
    try {
      const program = path.join(dir, 'program.mp4');
      await execFileAsync('ffmpeg', [
        '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30', '-f', 'lavfi', '-i', 'sine=f=300:r=48000',
        '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', program,
      ]);
      const draft = path.join(dir, 'preview.mp4');
      await masterFinalVideo({ inputPath: program, outputPath: draft, draft: true });
      assert.equal(await size(draft), '960,540');
      const final = path.join(dir, 'final.mp4');
      await masterFinalVideo({ inputPath: program, outputPath: final });
      assert.equal(await size(final), '1920,1080');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('serves the preview with ?preview=1, and never falls back to the final', async () => {
    const id = `test-preview-${Date.now()}`;
    const dir = path.join(process.cwd(), 'storage', 'renders', id);
    const { supabase } = createMockSupabase();
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'final_video.mp4'), 'final');
      const missing = await handleGetRender(new Request(`http://x/api/videos/${id}/render?preview=1`), id, supabase);
      assert.equal(missing.status, 404);
      await fs.writeFile(path.join(dir, 'preview.mp4'), 'preview!');
      const res = await handleGetRender(new Request(`http://x/api/videos/${id}/render?preview=1`), id, supabase);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'preview!');
      const full = await handleGetRender(new Request(`http://x/api/videos/${id}/render`), id, supabase);
      assert.equal(await full.text(), 'final');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
