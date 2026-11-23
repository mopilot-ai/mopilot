// A second client of a Host, run by a spec in a plain Node process (the Host's modules read import.meta, which Playwright's loader does not take): paired under a name with the code it is given, it reads the Host's chat list (`host.chats`) as a phone does until a chat has the title the spec expects (up to a minute), and prints the list. Exits 1, printing the last list, when none has it.
//   node hostChatsClient.mjs <socket> <identity file> <device name> <pairing code> <title>
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
const [socketPath, identityFile, name, code, title] = process.argv.slice(2);

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
const client = open();
await authenticate((method, params) => client.request(method, params), identity);
await client.request('host.hello', helloParams());
const until = Date.now() + 60_000;
let chats = [];
while (Date.now() < until && !chats.some((c) => c.title === title)) {
  chats = (await client.request('host.chats', { limit: 50 }))?.chats ?? [];
  if (!chats.some((c) => c.title === title)) await new Promise((r) => setTimeout(r, 500));
}
client.close();
process.stdout.write(JSON.stringify(chats));
process.exit(chats.some((c) => c.title === title) ? 0 : 1);
