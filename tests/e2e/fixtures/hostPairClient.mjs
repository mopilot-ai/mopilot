// Another client of a Host the specs started (fixtures/remoteHost.ts), run in a plain Node process (the Host's modules read import.meta, which Playwright's loader does not take): paired under a name with the Host's pairing code, and, when asked, a phone added as a client by it, so a machine's page has devices beyond this app to list and remove.
//   node hostPairClient.mjs <socket> <identity file> <device name> <pairing code> [<phone name>]
import crypto from 'node:crypto';
import net from 'node:net';
import { createRequire } from 'node:module';
import { lineClient } from '../../../scripts/host-accept/wire.mjs';
import { helloParams } from '../../../shared/host/schema.mjs';

const require = createRequire(import.meta.url);
/** This stand-in client's key is sealed only for form's sake: it is a throwaway identity in a test folder. */
const keySafe = {
  isEncryptionAvailable: () => true,
  encryptString: (/** @type {string} */ s) => Buffer.from(s),
  decryptString: (/** @type {Buffer} */ b) => b.toString(),
};
const { loadIdentity, pairWith, authenticate } = require('../../../electron/host/pairingClient.cjs');
const [socketPath, identityFile, name, code, phone] = process.argv.slice(2);

function open() {
  const socket = net.connect(socketPath);
  socket.on('error', () => undefined);
  const closed = new Promise((resolve) => socket.on('close', () => resolve(undefined)));
  return lineClient({
    write: (text) => socket.write(text),
    onData: (fn) => socket.on('data', (c) => fn(String(c))),
    kill: () => socket.destroy(),
    closed,
  });
}

const identity = loadIdentity(identityFile, keySafe);
const pairing = open();
await pairWith((method, params) => pairing.request(method, params), identity, code, name);
pairing.close();
const out = { paired: name, phone: null };
if (phone) {
  const client = open();
  await authenticate((method, params) => client.request(method, params), identity);
  await client.request('host.hello', helloParams());
  const publicKey = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  out.phone = (await client.request('host.clientAdd', { publicKey, name: phone, kind: 'phone' })).fingerprint;
  client.close();
}
process.stdout.write(JSON.stringify(out));
process.exit(0);
