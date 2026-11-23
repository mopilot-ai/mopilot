// Establishes a test socket within a real deadline, retrying only missing or not-yet-listening startup sockets.
import net from 'node:net';
import { once } from 'node:events';
import { waitFor, type WaitOptions } from './waitFor.ts';

const realTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

export async function connectSocket(socketPath: string, what: string, options: WaitOptions = {}): Promise<net.Socket> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = realTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`)), timeoutMs);
  try {
    return await waitFor(
      async () => {
        controller.signal.throwIfAborted();
        const attempt = net.connect(socketPath);
        try {
          await once(attempt, 'connect', { signal: controller.signal });
          controller.signal.throwIfAborted();
          return attempt;
        } catch (error) {
          attempt.destroy();
          if (controller.signal.aborted) throw controller.signal.reason;
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error;
          return null;
        }
      },
      what,
      options,
    );
  } finally {
    realClearTimeout(timer);
  }
}
