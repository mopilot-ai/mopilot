// Socket-free mutual capability negotiation and stale cryptographic handshake continuations in the extension Client.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
import { Client } from '../electron/chrome-extension/src/client.mjs';
import { MEMBERSHIP_CAPABILITY, PROTOCOL_VERSION, proof } from '../electron/chrome-extension/src/protocol.mjs';
import { deferred } from './support/async-scenarios.ts';

export const GUARDS = ['electron/chrome-extension/'];

async function setup(crypto: any = webcrypto, handle: any = null) {
  const sockets: Socket[] = [];
  const requests: any[] = [];
  class Socket {
    sent: any[] = [];
    readyState = 1;
    onmessage: any;
    onclose: any;
    onerror: any;
    url: string;
    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }
    send(text: string) {
      this.sent.push(JSON.parse(text));
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    receive(message: any) {
      return this.onmessage?.({ data: JSON.stringify(message) });
    }
  }
  const timers: any = { setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 2, clearInterval: () => {} };
  const client = new Client({
    WebSocket: Socket,
    crypto,
    pairing: async () => ({ port: 12345, secret: 'secret' }),
    timers,
    sessions: { handle: handle ?? ((...args: any[]) => requests.push(args)), peerGone: () => {} },
    version: '0.3.0',
  });
  await client.connect();
  const hello = async (caps: any = [MEMBERSHIP_CAPABILITY], ws = sockets.at(-1)!) => {
    await ws.receive({ type: 'hello', protocol: 1, nonce: 'app', capabilities: caps });
    return ws.sent.at(-1);
  };
  const welcome = async (caps: any = [MEMBERSHIP_CAPABILITY], ws = sockets.at(-1)!) => {
    const auth = ws.sent.at(-1);
    await ws.receive({ type: 'welcome', proof: await proof(webcrypto, 'secret', 'app', auth.nonce, 'app'), capabilities: caps });
  };
  return { client, sockets, requests, hello, welcome };
}

const valid = [MEMBERSHIP_CAPABILITY];
const other = ['future-capability', MEMBERSHIP_CAPABILITY];
const invalid = [
  null,
  false,
  true,
  'tab-membership-v1',
  {},
  [],
  ['unknown'],
  [MEMBERSHIP_CAPABILITY, false],
  [MEMBERSHIP_CAPABILITY, MEMBERSHIP_CAPABILITY],
];
for (const [stage, value] of [
  ...invalid.map((caps) => ['hello', caps] as const),
  ...invalid.map((caps) => ['welcome', caps] as const),
  ['hello', other],
  ['welcome', other],
] as const) {
  test(`${stage} capability ${JSON.stringify(value)} only enables exact mutually acknowledged membership`, async () => {
    const w = await setup();
    const auth = await w.hello(stage === 'hello' ? value : valid);
    assert.equal(auth.protocol, 1);
    assert.equal(PROTOCOL_VERSION, 1);
    const accepted = value === other;
    assert.deepEqual(auth.capabilities, stage === 'hello' && !accepted ? undefined : valid);
    await w.welcome(stage === 'welcome' ? value : valid);
    assert.equal(w.client.status, 'connected', 'legacy authentication stays compatible');
    await w.sockets[0].receive({ chat: 'a', method: 'session.open' });
    assert.equal(w.requests[0][2], accepted);
  });
}

test('absent capabilities preserve old main/new extension and welcome cannot introduce an unoffered feature', async () => {
  const w = await setup();
  const socket = w.sockets[0];
  await socket.receive({ type: 'hello', protocol: 1, nonce: 'app' });
  assert.equal(socket.sent[0].capabilities, undefined);
  await w.welcome();
  await socket.receive({ chat: 'a', method: 'session.open' });
  assert.equal(w.requests[0][2], false);
});

test('an unacknowledged welcome keeps legacy mode, while exact hello/auth/welcome enables receipts', async () => {
  for (const acknowledge of [false, true]) {
    const w = await setup();
    const auth = await w.hello();
    assert.deepEqual(auth.capabilities, valid);
    await w.sockets[0].receive({
      type: 'welcome',
      proof: await proof(webcrypto, 'secret', 'app', auth.nonce, 'app'),
      ...(acknowledge ? { capabilities: valid } : {}),
    });
    await w.sockets[0].receive({ chat: 'a', method: 'chrome.tabs.remove' });
    assert.equal(w.requests[0][2], acknowledge);
  }
});

for (const stage of ['hello', 'welcome', 'invalid welcome']) {
  test(`replaced socket cannot publish a delayed ${stage} proof or authenticate the new peer`, async () => {
    const wait = deferred<void>();
    const entered = deferred<void>();
    let block = stage === 'hello';
    const crypto = {
      getRandomValues: (bytes: Uint8Array<ArrayBuffer>) => webcrypto.getRandomValues(bytes),
      subtle: {
        importKey: (...args: any[]) => (webcrypto.subtle.importKey as any)(...args),
        sign: async (...args: any[]) => {
          if (block) {
            entered.resolve();
            await wait.promise;
          }
          return (webcrypto.subtle.sign as any)(...args);
        },
      },
    };
    const w = await setup(crypto);
    const old = w.sockets[0];
    let pending: Promise<any>;
    if (stage === 'hello') pending = w.hello();
    else {
      const auth = await w.hello();
      block = true;
      pending = old.receive({
        type: 'welcome',
        capabilities: valid,
        proof: stage === 'invalid welcome' ? 'invalid' : await proof(webcrypto, 'secret', 'app', auth.nonce, 'app'),
      });
    }
    await entered.promise;
    await w.client.reset();
    wait.resolve();
    await pending;
    assert.equal(w.client.ws, w.sockets[1]);
    assert.equal(w.client.authed, false);
    assert.equal(w.client.status, 'connecting');
    assert.equal(w.sockets[1].sent.length, 0);
    assert.equal(old.sent.length, stage === 'hello' ? 0 : 1);
    block = false;
    await w.hello();
    await w.welcome();
    await w.sockets[1].receive({ chat: 'a', method: 'session.open' });
    assert.equal(w.requests[0][2], true, 'replacement can authenticate and negotiate independently');
  });
}

test('old session replies stay on their captured peer and cannot reuse request IDs after reconnect', async () => {
  const wait = deferred<void>();
  let reply: any;
  const w = await setup(webcrypto, async (_m: any, respond: any) => {
    reply = respond;
    await wait.promise;
    respond({ chat: 'a', id: 1, result: {} });
  });
  await w.hello();
  await w.welcome();
  const pending = w.sockets[0].receive({ chat: 'a', id: 1, method: 'chrome.tabs.create' });
  assert.equal(typeof reply, 'function');
  await w.client.reset();
  await w.hello();
  await w.welcome();
  wait.resolve();
  await pending;
  assert.equal(
    w.sockets[1].sent.some((m) => m.id === 1),
    false,
  );
});

test('duplicate hello and wrong protocol cannot negotiate or dispatch session commands', async () => {
  for (const duplicate of [false, true]) {
    const w = await setup();
    if (duplicate) await w.hello();
    await w.sockets[0].receive({ type: 'hello', protocol: duplicate ? 1 : 2, nonce: 'other', capabilities: valid });
    // a second hello is an impostor; a first in another protocol version asks for an update (#1986)
    assert.equal(w.client.status, duplicate ? 'unauthorized' : 'update-required');
    assert.equal(w.client.authed, false);
    assert.equal(w.requests.length, 0);
  }
});
