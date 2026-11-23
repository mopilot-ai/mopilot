// DEV ONLY: the `gap` scenario's work: moves the Mac's send counter for a paired phone n frames past what the phone has seen, as a long stretch of lost frames would, so the phone's catch-up (more than 4096 ahead) and its "pair again" state (beyond the cap) can be reproduced.
import { toHex } from '../../shared/remote/envelope.mjs';

/**
 * @param {object} o
 * @param {{ sessions: Map<string, any>, crypto: { createSender(o: { pair: string, dir: 'm2p', chain: Uint8Array, ctr: number }): any } } | null} o.channel the Mac's sealed channel (null while Mobile Remote is off)
 * @param {{ update(deviceId: string, patch: object, pairId: string): Promise<unknown> } | null} o.devices the Mac's paired-phone list
 * @param {number} o.n how many counters to move on
 * @param {string} [o.pairId] one phone (every paired phone when left out)
 * @returns {Promise<string>} one line per phone
 */
export async function advanceTx({ channel, devices, n, pairId }) {
  if (!channel || !devices) throw new Error('Mobile Remote is not running.');
  const sessions = pairId === undefined ? [...channel.sessions.values()] : [channel.sessions.get(pairId)].filter(Boolean);
  if (!sessions.length) throw new Error(pairId === undefined ? 'No phone is paired.' : `No paired phone has the pair id ${pairId}.`);
  const lines = [];
  for (const s of sessions) {
    // a seal in flight (or queued behind it) finishes first, so the swap below cannot race it
    for (let seen; seen !== s.sending; ) {
      seen = s.sending;
      await seen;
    }
    const ahead = s.tx.peek(n);
    const saved = s.savedTx;
    // swapped and marked saved with no wait in between: a seal that starts next uses the new counter
    s.tx = channel.crypto.createSender({ pair: s.device.pairId, dir: 'm2p', chain: ahead.chain, ctr: ahead.ctr });
    s.savedTx = ahead.ctr;
    s.sealed = null;
    try {
      await devices.update(s.device.id, { tx: { ctr: ahead.ctr, chain: toHex(ahead.chain) } }, s.device.pairId);
    } catch (error) {
      // not on disk: the next seal saves it again
      s.savedTx = saved;
      throw error;
    }
    lines.push(`gap: advanced the Mac's counter for ${s.device.pairId} by ${n} to ${ahead.ctr}`);
  }
  return lines.join('; ');
}
