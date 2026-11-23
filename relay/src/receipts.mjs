// A receiver's receipt: it says it durably holds a frame, and the relay forgets the frame. Repeats and receipts of expired or unknown frames change nothing.
import { parseAck } from './frames.mjs';

/**
 * @param {import('./hub.mjs').Hub} hub
 * @param {import('./connection.mjs').Conn} conn
 * @param {any} m the receipt message
 * @param {(code: string, extra?: object) => Promise<boolean>} fail answers the client with an error
 */
export async function receipt(hub, conn, m, fail) {
  if (!hub.mailbox) return void (await fail('bad_message'));
  const { deviceId } = conn.identity;
  if (!(await hub.pace(conn, hub.receiptBuckets.get(deviceId).take()))) return;
  const a = parseAck(m);
  if (!a) return void (await fail('bad_ack', { pair: m.pair }));
  const pair = await hub.pairRow(a.pairId);
  const role = pair?.macDeviceId === deviceId ? 'mac' : pair?.phoneDeviceId === deviceId ? 'phone' : null;
  if (!pair?.phoneDeviceId || !role) return void (await fail('unknown_pair', { pair: a.pairId }));
  if (a.dir !== (role === 'mac' ? 'p2m' : 'm2p')) return void (await fail('bad_dir', { pair: a.pairId }));
  const r = await hub.mailbox.ack(pair, deviceId, a.dir, a.ctr);
  if (r.code === 'forbidden') await fail('unknown_pair', { pair: a.pairId });
}
