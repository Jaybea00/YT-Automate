import type * as fs from 'node:fs';

export interface SafeWebStreamOptions {
  signal?: AbortSignal;
}

/**
 * Safely converts a Node.js fs.ReadStream to a Web ReadableStream.
 *
 * In Node 20/22+, `Readable.toWeb(stream)` throws an unhandled
 * `TypeError: Invalid state: Controller is already closed (code: 'ERR_INVALID_STATE')`
 * as an uncaughtException whenever a client aborts an in-flight HTTP request
 * (e.g., HTML5 <video> seeking, buffering partial ranges, or navigating away).
 *
 * This wrapper:
 * 1. Safely guards controller lifecycle methods (`close`, `error`, `enqueue`) against invalid state errors.
 * 2. Destroys the underlying Node.js stream immediately when the consumer cancels the WebStream or when `signal` aborts.
 * 3. Handles Node stream backpressure cleanly with `pause()` and `resume()`.
 */
export function createSafeWebStream(
  stream: fs.ReadStream,
  options?: SafeWebStreamOptions,
): ReadableStream<Uint8Array> {
  let isClosed = false;

  const destroyNodeStream = () => {
    if (!stream.destroyed) {
      stream.destroy();
    }
  };

  if (options?.signal) {
    if (options.signal.aborted) {
      destroyNodeStream();
    } else {
      options.signal.addEventListener('abort', destroyNodeStream, { once: true });
    }
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const safeClose = () => {
        if (!isClosed) {
          isClosed = true;
          try {
            controller.close();
          } catch {
            // Controller might already be closed or errored by the consumer
          }
        }
      };

      const safeError = (err: unknown) => {
        if (!isClosed) {
          isClosed = true;
          try {
            controller.error(err);
          } catch {
            // Controller might already be closed or errored
          }
        }
      };

      stream.on('data', (chunk: string | Buffer) => {
        if (isClosed) return;
        try {
          const uint8 = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
          controller.enqueue(uint8);
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            stream.pause();
          }
        } catch {
          // If controller is closed or errored, stop emitting and clean up
          isClosed = true;
          destroyNodeStream();
        }
      });

      stream.on('end', () => {
        safeClose();
      });

      stream.on('error', (err) => {
        safeError(err);
      });

      stream.on('close', () => {
        safeClose();
      });
    },
    pull() {
      if (!isClosed && stream.isPaused()) {
        stream.resume();
      }
    },
    cancel() {
      isClosed = true;
      destroyNodeStream();
    },
  });
}
