// Pairing by code in the app (R2b, #5576): the controller client (codePairClient.cjs) joined to this app's own parts: its device key (the one it pairs Hosts with), the relay's lane and enrollments, the machine list, and the `host.codePair` flag. Without a relay (a build or test that names none) it answers "isn't available yet".
const path = require('node:path');
const { createCodePairClient, failure, fileStore } = require('./codePairClient.cjs');
const { deviceName } = require('./pairingClient.cjs');
const { createCrypto } = require('../../shared/remote/crypto.mjs');
// the app's crypto runs in Electron, whose OpenSSL has no ChaCha20-Poly1305: sodium's (electron/platform/sodiumPrimitives.cjs) is the one that seals there
const { createSodiumPrimitives } = require('../platform/sodiumPrimitives.cjs');

/**
 * @param {object} o
 * @param {string} o.dir the user data dir
 * @param {any} o.relay relayPaths.cjs's service, or null
 * @param {{ add: (r: any) => unknown }} o.registry
 * @param {() => { publicKey: string, signCodePair: (message: Uint8Array) => Uint8Array }} o.key this app's identity key (pairingClient.cjs)
 * @param {() => boolean} [o.enabled]
 * @param {() => string} [o.name]
 */
function createCodePairWiring({
  dir,
  relay,
  registry,
  key,
  enabled = () => require('../platform/flags.cjs').isEnabled('host.codePair'),
  // the name this Mac introduces itself with to every Host (pairingClient.cjs `deviceName`), so the name the person approves is the one it keeps
  name = deviceName,
}) {
  // a build or test that names no relay offers nothing
  if (!relay) return { addByCode: async () => failure('off'), cancel: () => undefined, sweep: () => undefined };
  return createCodePairClient({
    crypto: createCrypto(createSodiumPrimitives()),
    enabled,
    relayUrl: () => relay.url(),
    device: () => {
      const identity = key();
      // the raw 32 bytes of an Ed25519 public key are the tail of its SPKI encoding
      const pub = new Uint8Array(Buffer.from(identity.publicKey, 'base64').subarray(-32));
      return { pub, name: name(), sign: (message) => new Uint8Array(identity.signCodePair(message)) };
    },
    lane: relay.lane,
    paths: relay,
    addMachine: ({ id, name: machineName, address, peerDevice }) =>
      registry.add({ id, name: machineName, address, socketPath: '', peerDevice, pairedBy: 'code' }),
    store: fileStore(path.join(dir, 'host-code-pair.json')),
  });
}

/**
 * What the machines service offers for pairing by code: the run and its cancel, refused where Host is not available.
 * @param {Parameters<typeof createCodePairWiring>[0]} deps @param {() => void} refuseUnlessAllowed
 */
function codePairActions(deps, refuseUnlessAllowed) {
  const codePair = createCodePairWiring(deps);
  return {
    addByCode: (/** @type {string} */ code) => (refuseUnlessAllowed(), codePair.addByCode(code)),
    cancelAddByCode: () => codePair.cancel(),
  };
}

module.exports = { createCodePairWiring, codePairActions };
