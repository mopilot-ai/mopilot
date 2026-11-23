// A second client of This Mac's Host, run by the specs of its background Host in a plain Node process (the Host's modules read import.meta, which Playwright's loader does not take): paired under a name with a code the Host prints, it answers the card that waits on a chat, as a phone does. Prints the Host's reply.
//   node hostSecondClient.mjs <socket> <identity file> <device name> <chat id> <allow|deny> <key>
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { createRequire } from 'node:module';
import { lineClient } from '../../../scripts/host-accept/wire.mjs';
import { helloParams } from '../../../shared/host/schema.mjs';
import { pendingOf } from '../../../shared/host/approvals.mjs';

const require = createRequire(import.meta.url);
/** This stand-in client's key is sealed only for form's sake: it is a throwaway identity in a test folder. */
const keySafe = {
  isEncryptionAvailable: () => true,
  encryptString: (/** @type {string} */ s) => Buffer.from(s),
  decryptString: (/** @type {Buffer} */ b) => b.toString(),
};
const { loadIdentity, pairWith, authenticate } = require('../../../electron/host/pairingClient.cjs');
const { HOST_CLI } = require('../../../electron/host/install.cjs');
const [socketPath, identityFile, name, chatId, kind, key] = process.argv.slice(2);

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

const printed = execFileSync('/bin/sh', ['-c', `${HOST_CLI} pair`], { encoding: 'utf8' });
const code = /Pairing code: (\S+)/.exec(printed)?.[1];
if (!code) throw new Error(`The Host printed no pairing code: ${printed}`);
const identity = loadIdentity(identityFile, keySafe);
const pairing = open();
await pairWith((method, params) => pairing.request(method, params), identity, code, name);
pairing.close();
const client = open();
await authenticate((method, params) => client.request(method, params), identity);
await client.request('host.hello', helloParams());
const until = Date.now() + 60_000;
let card;
while (!card && Date.now() < until) {
  card = pendingOf(await client.request('host.pending')).cards.find((c) => c.chatId === chatId);
  if (!card) await new Promise((r) => setTimeout(r, 500));
}
if (!card) throw new Error(`No card waits on ${chatId}.`);
const option = card.options.find((o) => o.kind === kind);
if (!option) throw new Error(`The card has no ${kind} option.`);
const reply = await client.request('chat.answer', { chatId, epoch: card.epoch, key, requestId: card.requestId, optionId: option.optionId });
client.close();
process.stdout.write(JSON.stringify(reply ?? null));
process.exit(0);
