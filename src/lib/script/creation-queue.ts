/**
 * Script writing for new videos runs in the background, one video at a time (so a batch of topics
 * doesn't hit the writing model all at once). The queue lives in the server process; a video whose
 * writing was lost (the server restarted) shows a Retry button on its review page, since the queue
 * no longer knows it.
 */

interface QueueState {
  chain: Promise<void>;
  /** Waiting, in order. */
  pending: string[];
  active: string | null;
}

const holder = globalThis as typeof globalThis & { __ytCreationQueue?: QueueState };

function state(): QueueState {
  // Kept on globalThis so a dev-server hot reload doesn't forget queued videos
  holder.__ytCreationQueue ??= { chain: Promise.resolve(), pending: [], active: null };
  return holder.__ytCreationQueue;
}

/**
 * Queues a video's writing. Registered at once (so the review page sees it as queued straight
 * away); `run` starts when every earlier video is done. The returned promise settles when this
 * video's writing ends; it never rejects (`run` reports its own failures on the video).
 */
export function enqueueCreation(videoId: string, run: () => Promise<void>): Promise<void> {
  const q = state();
  if (q.active === videoId || q.pending.includes(videoId)) return q.chain;
  q.pending.push(videoId);
  const job = q.chain.then(async () => {
    q.pending = q.pending.filter((id) => id !== videoId);
    q.active = videoId;
    try {
      await run();
    } catch (err) {
      console.error(`[creation] Writing video ${videoId} failed:`, err);
    } finally {
      q.active = null;
    }
  });
  q.chain = job;
  return job;
}

export interface CreationQueueStatus {
  /** Being written right now. */
  active: boolean;
  /** Waiting its turn. */
  queued: boolean;
  /** How many videos will be written before this one starts. */
  ahead: number;
}

export function creationQueueStatus(videoId: string): CreationQueueStatus {
  const q = state();
  if (q.active === videoId) return { active: true, queued: false, ahead: 0 };
  const index = q.pending.indexOf(videoId);
  if (index < 0) return { active: false, queued: false, ahead: 0 };
  return { active: false, queued: true, ahead: index + (q.active ? 1 : 0) };
}

/** For tests: forget everything queued. */
export function resetCreationQueue(): void {
  holder.__ytCreationQueue = { chain: Promise.resolve(), pending: [], active: null };
}
