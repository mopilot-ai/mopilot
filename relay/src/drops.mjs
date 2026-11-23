// Notices to a sender that frames it sent were dropped (they outlived the TTL): read from the plain mailbox's notice table and
// from the durable store, sent as `mailbox.dropped` events and removed once the sender's socket has taken them.

/** @typedef {import('./hub.mjs').Hub} Hub */
/** @typedef {import('./connection.mjs').Conn} Conn */

export async function deliverDrops(
  /** @type {Hub} */ hub,
  /** @type {Conn} */ conn,
  /** @type {string} */ pairId,
  /** @type {string} */ dir,
) {
  if (hub.mailbox) await deliverDurableDrops(hub, conn, pairId, dir);
  for (const d of await hub.store.takeDrops(pairId, dir)) {
    await hub.send(conn, {
      t: 'event',
      ev: 'mailbox.dropped',
      pair: d.pairId,
      dir: d.dir,
      count: d.dropped,
      firstCtr: d.firstCtr,
      lastCtr: d.lastCtr,
    });
  }
}

export async function deliverDurableDrops(
  /** @type {Hub} */ hub,
  /** @type {Conn} */ conn,
  /** @type {string} */ pairId,
  /** @type {string} */ dir,
) {
  const pair = await hub.store.getPair(pairId);
  if (!pair?.phoneDeviceId) return;
  const { deviceId } = conn.identity;
  for (const d of await hub.mailbox.drops(pair, deviceId, dir)) {
    const event = { t: 'event', ev: 'mailbox.dropped', pair: pairId, dir, count: d.dropped, firstCtr: d.firstCtr, lastCtr: d.lastCtr };
    if (await hub.send(conn, event)) await hub.mailbox.ackDrop(pair, deviceId, dir, d);
  }
}
