// The remote methods on MoMo's channels and groups (A2; phones only, and listed in the Mac's hello only for an account MoMo is allowed for): list, create (a name only), rename, archive, delete, move into a group, the answer to a channel's first row, and the group calls. Each runs the channel operations (remote/momoChannelOps.cjs) through the handlers the Mac's windows use; while `momo.channels` is off the list says `enabled: false` and every change is refused. A channel's instructions are the Mac's to write. Allowed while MoMo is paused, as the user's own edits are.
const { RemoteError } = require('../serviceErrors.cjs');

/** MoMo's operations, once main made them. */
function opsOf(/** @type {any} */ svc) {
  const ops = svc.momo();
  if (!ops) throw new RemoteError('failed', 'MoMo is not ready.');
  return ops;
}

/** A change the user asked for: a paired phone's, with its answer as the Mac's window would get it. */
const change =
  (/** @type {(c: any, p: any) => Promise<unknown>} */ run) =>
  async (/** @type {any} */ svc, /** @type {any} */ client, /** @type {any} */ p) => {
    svc.assertPaired(client);
    return run(opsOf(svc).channels, p);
  };

module.exports = {
  // read only: the answer says whether channels are on, so a phone draws nothing of them while they are off
  'momo.channels.list': (svc) => opsOf(svc).channels.list(),
  'momo.channels.create': change((c, p) => c.create(p.name, p.group)),
  'momo.channels.rename': change((c, p) => c.rename(p.channelId, p.name)),
  'momo.channels.archive': change((c, p) => c.archive(p.channelId)),
  'momo.channels.delete': change((c, p) => c.remove(p.channelId)),
  'momo.channels.move': change((c, p) => c.move(p.channelId, p.group)),
  'momo.channels.welcome': change((c, p) => c.welcome(p.channelId, p.answer)),
  'momo.channels.group.create': change((c, p) => c.group.create(p.name)),
  'momo.channels.group.rename': change((c, p) => c.group.rename(p.groupId, p.name)),
  'momo.channels.group.delete': change((c, p) => c.group.remove(p.groupId)),
};
