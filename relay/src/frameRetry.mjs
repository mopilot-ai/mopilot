// Handling one frame message when something fails underneath it (a database timeout). The store reads a counter at or below a
// stream's high-water mark with no stored frame as "already consumed", so a later frame of the stream must never be stored ahead
// of one that failed: the sender's resend of the failed one would be acknowledged as consumed and the frame would be gone. A
// connection handles its messages one at a time, so the frame is tried again in place, a few times with a pause, and everything
// behind it waits (a transient failure then costs a delay and no frame). When it still fails the sender is told, the connection
// ends (the messages queued behind it are never handled) and the sender, which resends what it has no acknowledgement for in order after every
// reconnect, starts again from this frame. The close code is 4500: the relay ended it, a Mac is not reported as vanished.

import { messageOf } from './processGuards.mjs';

/** Pauses before each new attempt after a failure, in milliseconds. */
export const RETRY_PAUSES_MS = [250, 500, 1000];

export const STORE_FAILED_CLOSE = 4500;

/**
 * @param {import('./hub.mjs').Hub} hub
 * @param {import('./connection.mjs').Conn} conn
 * @param {any} m the frame message
 * @param {(code: string, extra?: object) => Promise<boolean>} fail answers the client with an error
 * @param {number} [attempt] how many times it has failed already
 * @returns {Promise<void>}
 */
export async function handleFrame(hub, conn, m, fail, attempt = 0) {
  try {
    // a new attempt does not pay the rate limits again: the first one did
    return await hub.frame(conn, m, fail, attempt > 0);
  } catch (error) {
    // a connection that ended or a relay that is shutting down: the frame was not stored or answered, and its sender resends it
    if (conn.closed || hub.draining) throw error;
    const pause = RETRY_PAUSES_MS[attempt];
    if (pause === undefined) {
      await fail('unavailable', { pair: m?.pair, ctr: m?.ctr });
      hub.drop(conn, STORE_FAILED_CLOSE, 'storing failed');
      throw error;
    }
    hub.log('frame_retry', { device: conn.identity.deviceId, attempt: attempt + 1, message: messageOf(error) });
    await hub.sleep(pause);
    if (conn.closed || hub.draining) return;
    return handleFrame(hub, conn, m, fail, attempt + 1);
  }
}
