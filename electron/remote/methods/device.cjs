// The remote method a phone uses to leave: the Mac forgets the pair.
const { RemoteError } = require('../serviceErrors.cjs');
module.exports = {
  'device.unpair': async (svc, client) => {
    if ((await svc.policy.onUnpair?.(client.pairId)) !== true) throw new RemoteError('failed', 'The phone could not be removed.');
    return { unpaired: true };
  },
};
