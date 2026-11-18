import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { enqueueClip } from '../clipping/run';
import { clipDir, loadClip, newClipId, saveClip } from '../clipping/store';
import { timestampUrl } from './run';
import { huntDir, loadHunt, updateHunt } from './store';

/**
 * Sends a cut moment to the clip editor: a new clip project starting from the moment's file (no
 * download), credited to the streamer, with the judge's description as the note that steers the
 * script. Sending the same moment again opens the clip already made from it.
 */
export async function sendMomentToEditor(huntId: string, momentId: string): Promise<string> {
  const hunt = await loadHunt(huntId);
  if (!hunt) throw new Error('Hunt not found');
  const moment = hunt.moments.find((m) => m.id === momentId);
  if (!moment) throw new Error('Moment not found');
  if (moment.clipId && (await loadClip(moment.clipId))) return moment.clipId;
  if (moment.status !== 'cut' || !moment.file) throw new Error('This moment has not been cut from the stream yet');

  const id = newClipId();
  const dir = clipDir(id);
  await fs.mkdir(dir, { recursive: true });
  const ext = path.extname(moment.file) || '.mp4';
  await fs.copyFile(path.join(huntDir(huntId), moment.file), path.join(dir, `source${ext}`));

  const now = new Date().toISOString();
  const pageUrl = timestampUrl(hunt.pageUrl, hunt.platform, moment.start);
  await saveClip({
    id,
    sourceUrl: pageUrl,
    creator: hunt.creator || hunt.uploaderHandle || hunt.uploader,
    note: [moment.reason, moment.hook && `Hook idea: ${moment.hook}`].filter(Boolean).join(' '),
    createdAt: now,
    updatedAt: now,
    status: 'queued',
    step: 'Waiting to start',
    warnings: [],
    localSource: true,
    source: {
      title: hunt.title,
      postText: moment.reason,
      uploader: hunt.uploader,
      uploaderHandle: hunt.uploaderHandle,
      platform: hunt.platform,
      pageUrl,
      file: `source${ext}`,
    },
  });
  await updateHunt(huntId, (h) => {
    const m = h.moments.find((x) => x.id === momentId);
    if (m) m.clipId = id;
  });
  enqueueClip(id, 'all');
  return id;
}
