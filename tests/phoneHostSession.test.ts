// The phone's client of a Host (shared/remote/phoneHost.mjs): auth over the Host's challenge, hello and the feature gate, requests
// with the Host's refusal codes and a timeout, events, and a session that ends under a request. A fake Host runs the real session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';
import { createRelaySession } from '../shared/host/relaySession.mjs';
import { createPhoneHost, mintKey, PhoneHostError, CARD_FEATURES, PHONE_FEATURES } from '../shared/remote/phoneHost.mjs';
import { fromBase64 } from '../shared/remote/envelope.mjs';
import { waitFor } from './support/waitFor.ts';
import { FEATURES, PROTOCOL } from '../shared/host/schema.mjs';

const prim = createNodePrimitives();
const HOST_KEY = 'a'.repeat(32);
const enc = new TextEncoder();
const dec = new TextDecoder();

type Reply = Record<string, any> | null | 'silent';

function rig(
  opts: {
    hostKey?: string;
    features?: string[];
    requestMs?: number;
    maxLine?: number;
    noEvents?: boolean;
    handler?: (m: any) => Reply;
  } = {},
) {
  const root = prim.randomBytes(32);
  const identity = prim.edKeypair();
  const toHost: any[] = [];
  const toApp: any[] = [];
  const seen: any[] = [];
  const events: any[] = [];
  const states: string[] = [];
  let hostStream: any = null;
  let nonce = 'n0';
  let connected = true;
  const handler =
    opts.handler ??
    ((m: any) => {
      if (m.method === 'host.challenge')
        return {
          result: {
            nonce: (nonce = `n${seen.length}`),
            hostId: opts.hostKey ?? HOST_KEY,
          },
        };
      if (m.method === 'host.auth') return { result: { fingerprint: 'fp' } };
      if (m.method === 'host.hello')
        return {
          result: {
            protocol: { ...PROTOCOL },
            features: opts.features ?? [...FEATURES, ...CARD_FEATURES],
          },
        };
      return { result: { echoed: m.method } };
    });
  const host = createRelaySession({
    prim,
    root,
    pair: 'p_x',
    role: 'host',
    send: (f) => (toApp.push(f), true),
    onStream: (s) => {
      hostStream = s;
      let buf = '';
      s.onData = (b: Uint8Array) => {
        buf += dec.decode(b);
        s.consumed(b.length);
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const m = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          seen.push(m);
          const r = handler(m);
          if (r !== 'silent' && r) s.write(enc.encode(`${JSON.stringify({ id: m.id, ...r })}\n`));
        }
      };
    },
  });
  const phone = createPhoneHost({
    prim,
    enrollment: { root, pairId: 'p_x', hostKey: HOST_KEY },
    identity,
    send: (f) => connected && (toHost.push(f), true),
    onState: (s) => states.push(s),
    onEvent: opts.noEvents ? undefined : (e) => events.push(e),
    requestMs: opts.requestMs,
    maxLine: opts.maxLine,
  });
  const later = (ms = 30) => {
    const until = Date.now() + ms;
    return waitFor(() => (pump(), Date.now() >= until), 'the relay to flush', { timeoutMs: 5000 }).then(() => undefined);
  };
  const pump = () => {
    while (toHost.length || toApp.length) {
      while (toHost.length) host.handleFrame(toHost.shift());
      while (toApp.length) phone.handleFrame(toApp.shift());
    }
  };
  // the session coalesces writes for a few ms, so the relay is pumped on a real clock until the promise settles
  const settle = async <T>(p: Promise<T>): Promise<T> => {
    let done = false;
    const guarded = p.finally(() => (done = true));
    guarded.catch(() => undefined);
    await waitFor(() => (pump(), done), 'the exchange to finish', { timeoutMs: 5000 });
    return guarded;
  };
  const connect = () => settle(phone.connect());
  return {
    phone,
    host,
    identity,
    seen,
    events,
    states,
    connect,
    settle,
    pump,
    later,
    hostStream: () => hostStream,
    cut: () => (connected = false),
  };
}

test('connect proves the key over the Host challenge and negotiates', async () => {
  const r = rig();
  const got = await r.connect();
  assert.deepEqual(
    r.seen.map((m) => m.method),
    ['host.challenge', 'host.auth', 'host.hello'],
  );
  const auth = r.seen[1].params;
  const spki = fromBase64(auth.publicKey);
  assert.equal(spki.length, 44);
  assert.deepEqual([...spki.subarray(12)], [...r.identity.pk]);
  assert.ok(prim.edVerify(r.identity.pk, enc.encode(`auth\n${HOST_KEY}\n${auth.nonce}`), fromBase64(auth.signature)));
  assert.ok(got.features.includes('approvals2'));
  assert.equal(r.phone.supportsCards(), true);
  assert.equal(r.phone.state, 'open');
});

test('a Host that names itself otherwise is not signed for', async () => {
  const r = rig({ hostKey: 'b'.repeat(32) });
  await assert.rejects(r.connect(), (e: any) => e.code === 'wrong_host');
  assert.equal(
    r.seen.some((m) => m.method === 'host.auth'),
    false,
  );
});

test('a Host without approvals2 cannot serve cards', async () => {
  const r = rig({ features: ['epoch', 'dedupe'] });
  await r.connect();
  assert.equal(r.phone.supportsCards(), false);
});

test('the phone asks a Host for its chats only when both ends declare chatList', async () => {
  const r = rig();
  await r.connect();
  assert.equal(r.phone.supportsChatList(), true);
  assert.deepEqual(await r.settle(r.phone.chats({ limit: 5 })), { echoed: 'host.chats' });
  assert.deepEqual(r.seen.at(-1).params, { limit: 5 });
  await r.settle(r.phone.chats());
  assert.deepEqual(r.seen.at(-1).params, {}, 'the Host sets the bound when the phone names none');
  const older = rig({ features: ['epoch', 'dedupe'] });
  await older.connect();
  assert.equal(older.phone.supportsChatList(), false);
  assert.equal(rig().phone.supportsChatList(), false, 'nothing is agreed before hello');
});

test('a refused auth rejects with the Host code and a hello without protocol falls back', async () => {
  const refuse = rig({
    handler: (m) =>
      m.method === 'host.challenge' ? { result: { nonce: 'n', hostId: HOST_KEY } } : { error: 'No.', code: 'unknown_client' },
  });
  await assert.rejects(refuse.connect(), (e: any) => e instanceof PhoneHostError && e.code === 'unknown_client');
  const bare = rig({
    handler: (m) =>
      m.method === 'host.challenge'
        ? { result: { nonce: 'n', hostId: HOST_KEY } }
        : m.method === 'host.auth'
          ? { result: {} }
          : { result: {} },
  });
  await assert.rejects(bare.connect(), (e: any) => e.code === 'version_refused');
});

test('requests carry the Host result, refusals and events', async () => {
  const r = rig();
  await r.connect();
  const key = mintKey(prim);
  assert.match(key, /^phone-[0-9a-f]{24}$/);
  const answer = await r.settle(
    r.phone.answer({
      chatId: 'c',
      epoch: 2,
      requestId: 'q',
      optionId: 'allow',
      key,
    }),
  );
  assert.deepEqual(answer, { echoed: 'chat.answer' });
  const last = r.seen.at(-1);
  assert.deepEqual(last.params, {
    chatId: 'c',
    epoch: 2,
    requestId: 'q',
    optionId: 'allow',
    key,
  });
  assert.deepEqual(await r.settle(r.phone.pending()), {
    echoed: 'host.pending',
  });
  assert.deepEqual(await r.settle(r.phone.status()), { echoed: 'host.status' });
  assert.deepEqual(await r.settle(r.phone.stop({ chatId: 'c', epoch: 2, key })), { echoed: 'chat.stop' });
  assert.deepEqual(await r.settle(r.phone.send({ chatId: 'c', epoch: 2, key, text: 'hi' })), { echoed: 'chat.send' });
  // a switch of agent and a permission mode are the Host's own methods, named as it names them (#4859)
  assert.deepEqual(await r.settle(r.phone.switchTo({ chatId: 'c', epoch: 2, key, harness: 'codex' })), { echoed: 'chat.switch' });
  assert.deepEqual(await r.settle(r.phone.permit({ chatId: 'c', epoch: 2, key, value: 'default' })), { echoed: 'chat.permit' });
  r.hostStream().write(enc.encode('{"event":"attention","chatId":"c"}\nnot json\n[1]\nnull\n42\n\n{"id":99,"result":1}\n'));
  await r.later();
  assert.deepEqual(r.events, [{ event: 'attention', chatId: 'c' }]);
});

test('a refusal without a code reads as refused, and a line that never ends is cut off', async () => {
  const r = rig({ maxLine: 64 });
  await r.connect();
  const p = r.phone.request('x.y');
  r.hostStream().write(enc.encode('{"id":99,"error":"No."}\n'));
  await r.later();
  r.hostStream().write(enc.encode('x'.repeat(100)));
  await r.later();
  assert.equal(r.phone.state, 'closed');
  await p;
  const q = rig({
    handler: (m) => (m.method === 'host.challenge' ? { result: { nonce: 'n', hostId: HOST_KEY } } : { error: 'No.' }),
  });
  await assert.rejects(q.connect(), (e: any) => e.code === 'refused');
});

test('a line split across chunks is read whole, and a multi-byte character is not cut', async () => {
  const r = rig();
  await r.connect();
  const bytes = enc.encode('{"event":"x","t":"日本"}\n');
  r.hostStream().write(bytes.subarray(0, 14));
  r.hostStream().write(bytes.subarray(14));
  await r.later();
  assert.deepEqual(r.events, [{ event: 'x', t: '日本' }]);
});

test('a silent Host: timeout', async () => {
  const r = rig({
    requestMs: 400,
    handler: (m) => {
      if (m.method === 'host.challenge') return { result: { nonce: 'n', hostId: HOST_KEY } };
      if (m.method === 'host.auth') return { result: {} };
      if (m.method === 'host.hello')
        return {
          result: { protocol: { ...PROTOCOL }, features: [...FEATURES] },
        };
      return 'silent';
    },
  });
  await r.connect();
  await assert.rejects(r.settle(r.phone.pending()), (e: any) => e.code === 'timeout');
});

test('a session that ends fails what is in flight, and a closed phone has no Host', async () => {
  const r = rig({
    handler: (m) => {
      if (m.method === 'host.challenge') return { result: { nonce: 'n', hostId: HOST_KEY } };
      if (m.method === 'host.auth') return { result: {} };
      if (m.method === 'host.hello')
        return {
          result: { protocol: { ...PROTOCOL }, features: [...FEATURES] },
        };
      return 'silent';
    },
  });
  await r.connect();
  const p = r.phone.pending();
  r.phone.close();
  await assert.rejects(p, (e: any) => e.code === 'unreachable');
  await assert.rejects(r.phone.pending(), (e: any) => e.code === 'unreachable');
  assert.equal(r.phone.negotiated, null);
  assert.equal(r.phone.supportsCards(), false);
  assert.ok(r.states.includes('closed'));
});

test('the Host ending the stream, or a binary frame, ends the connection', async () => {
  const a = rig();
  await a.connect();
  a.hostStream().end();
  await a.later();
  await assert.rejects(a.phone.pending(), (e: any) => e.code === 'unreachable');
  const b = rig();
  await b.connect();
  b.hostStream().write(Uint8Array.of(0, 1, 2));
  await b.later();
  assert.equal(b.phone.state, 'closed');
  const c = rig();
  await c.connect();
  c.hostStream().reset();
  await c.later();
  await assert.rejects(c.phone.pending(), (e: any) => e.code === 'unreachable');
});

test('a second connect replaces the first, and an unreachable relay fails a connect', async () => {
  const r = rig();
  const first = r.phone.connect().catch((e) => e);
  await waitFor(() => r.phone.state === 'opening', 'the first connect to start');
  const second = r.phone.connect();
  const lost = await r.settle(first);
  assert.ok(lost instanceof Error);
  await r.settle(second);
  assert.equal(r.phone.state, 'open');
  const dead = rig();
  dead.cut();
  await assert.rejects(dead.phone.connect(), () => true);
});

test('the chat requests of a full client name their methods and carry their params', async () => {
  const r = rig();
  await r.connect();
  const sub = { chatId: 'c', epoch: 1, fromRev: 3, generation: 'g' };
  await r.settle(r.phone.subscribe(sub));
  await r.settle(r.phone.start({ epoch: 1, key: 'phone-12345678', harness: 'claude' }));
  const page = { chatId: 'c', epoch: 1, generation: 'g', rev: 3, index: 0, offset: 0 };
  await r.settle(r.phone.history(page));
  assert.deepEqual(
    r.seen.slice(-3).map((m) => m.method),
    ['chat.subscribe', 'chat.start', 'chat.history'],
  );
  assert.deepEqual(r.seen.at(-1).params, page);
});

test('an event line with no listener is dropped', async () => {
  const r = rig({ noEvents: true });
  await r.connect();
  r.hostStream().write(enc.encode('{"event":"attention"}\n'));
  await r.later();
  assert.equal(r.phone.state, 'open');
  assert.deepEqual(r.events, []);
});

test('every feature the phone declares is one the Host has', () => {
  assert.deepEqual(
    PHONE_FEATURES.filter((f) => !FEATURES.includes(f)),
    [],
  );
  assert.deepEqual(
    CARD_FEATURES.filter((f) => !PHONE_FEATURES.includes(f)),
    [],
  );
});

test("a refusal that names the current epoch carries it in its details, beside the Host's own", async () => {
  const r = rig({
    handler: (m: any) =>
      m.method === 'host.challenge'
        ? { result: { nonce: 'n', hostId: HOST_KEY } }
        : m.method === 'host.auth'
          ? { result: {} }
          : m.method === 'host.hello'
            ? { result: { protocol: { ...PROTOCOL }, features: [...FEATURES] } }
            : { error: 'stale', code: 'stale_epoch', current: 7, details: { x: 1 } },
  });
  await r.connect();
  await assert.rejects(
    r.settle(r.phone.send({ chatId: 'c', epoch: 1, key: 'k' })),
    (e: any) => e.code === 'stale_epoch' && e.details.current === 7 && e.details.x === 1,
  );
});
