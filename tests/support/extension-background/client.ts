// Extension client unit cases using shared fake Chrome, socket, timer, and page fixtures.
import {
  test,
  mock,
  assert,
  protocol,
  KEEPALIVE_MS,
  RETRY_MS,
  claimPairing,
  tick,
  SECRET,
  FakeWs,
  fakeTimers,
  client,
  handshake,
} from './fixture.ts';

export function registerClient() {
  test('the client connects to the paired port, proves the secret, checks MoPilot’s proof, then passes chat messages on and pings', async () => {
    const { c, timers, handled, statuses } = client();
    await c.connect();
    await c.connect();
    assert.equal(FakeWs.all.length, 1, 'one connection at a time');
    const ws = FakeWs.all[0];
    assert.equal(ws.url, 'ws://127.0.0.1:47615/mopilot-chrome');
    c.send({ chat: 'x' });
    assert.equal(ws.sent.length, 0, 'nothing is sent before the handshake');
    await handshake(ws);
    assert.equal(c.status, 'connected');
    assert.deepEqual(statuses, ['connecting', 'connected']);
    await ws.from({ chat: 'a', id: 1, method: 'chrome.tabs.create', params: [] });
    await ws.from({ type: 'pong' });
    await ws.from('not json');
    await ws.from('null');
    assert.deepEqual(handled, [{ chat: 'a', id: 1, method: 'chrome.tabs.create', params: [] }]);
    assert.equal(timers.intervals[0].ms, KEEPALIVE_MS);
    timers.intervals[0].f();
    assert.deepEqual(ws.sent.at(-1), { type: 'ping' });
    c.send({ chat: 'a', id: 1, result: {} });
    assert.deepEqual(ws.sent.at(-1), { chat: 'a', id: 1, result: {} });
    ws.readyState = 3;
    c.send({ chat: 'a' });
    assert.deepEqual(ws.sent.at(-1), { chat: 'a', id: 1, result: {} });
    // a message for a socket that is no longer the client's is ignored
    const late = ws.onmessage;
    await c.reset();
    await late({ data: '{"chat":"a","id":9}' });
    assert.equal(handled.length, 1);
  });

  test('an impostor on the port: a wrong welcome proof, or anything but the handshake, closes it as unauthorized', async () => {
    const bad = client();
    await bad.c.connect();
    await handshake(FakeWs.all[0], { badWelcome: true });
    assert.equal(bad.c.status, 'unauthorized');
    assert.equal(FakeWs.all[0].closed, 1);
    assert.equal(bad.sess.handle.mock.callCount(), 0);
    // a command sent before the handshake
    const early = client();
    await early.c.connect();
    await FakeWs.all[0].from({ chat: 'a', id: 1, method: 'chrome.debugger.attach', params: [{ tabId: 1 }] });
    assert.equal(early.c.status, 'unauthorized');
    assert.equal(early.sess.handle.mock.callCount(), 0);
    // a second hello, or a welcome before our auth
    const again = client();
    await again.c.connect();
    await FakeWs.all[0].from({ type: 'hello', protocol: 1, nonce: 'n' });
    await FakeWs.all[0].from({ type: 'hello', protocol: 1, nonce: 'n' });
    assert.equal(again.c.status, 'unauthorized');
    const welcomeFirst = client();
    await welcomeFirst.c.connect();
    await FakeWs.all[0].from({ type: 'welcome', proof: 'x' });
    assert.equal(welcomeFirst.c.status, 'unauthorized');
    // after unauthorized, the next try waits the longest delay
    FakeWs.all[0].onclose();
    assert.equal(welcomeFirst.c.status, 'unauthorized');
    assert.equal(welcomeFirst.timers.timeouts.at(-1)?.ms, RETRY_MS.at(-1));
  });

  test('without a pairing it stays unpaired; a dropped connection is tried again with growing delays and lets go of the debuggers', async () => {
    const { c, timers, statuses, sess, setPairing } = client({ pairing: null });
    await c.connect();
    assert.equal(c.status, 'unpaired');
    assert.equal(FakeWs.all.length, 0);
    setPairing({ port: 47615, secret: SECRET });
    await c.connect();
    const ws = FakeWs.all[0];
    await handshake(ws);
    ws.onclose();
    assert.equal(c.status, 'offline');
    assert.equal(sess.peerGone.mock.callCount(), 1, 'every debugger is let go');
    assert.equal(timers.intervals.length, 0, 'no more pings');
    assert.equal(timers.timeouts.at(-1)?.ms, RETRY_MS[0]);
    ws.onclose();
    // the retry connects again; a connection that never opens backs off further
    await timers.timeouts.at(-1)?.f();
    assert.equal(FakeWs.all.length, 2);
    FakeWs.all[1].onclose();
    assert.equal(timers.timeouts.at(-1)?.ms, RETRY_MS[1]);
    assert.equal(sess.peerGone.mock.callCount(), 1, 'never connected: nothing to let go of');
    for (let i = 0; i < 6; i++) {
      await timers.timeouts.at(-1)?.f();
      FakeWs.all.at(-1)?.onclose();
    }
    assert.equal(timers.timeouts.at(-1)?.ms, RETRY_MS.at(-1));
    FakeWs.all.at(-1)?.onerror();
    assert.ok(statuses.includes('offline'));
  });

  test('a WebSocket that can’t be made counts as offline and is tried again; letting go of the tabs failing is logged', async () => {
    const { c, timers } = client({
      WebSocket: class {
        constructor() {
          throw new Error('bad url');
        }
      },
    });
    await c.connect();
    assert.equal(c.status, 'offline');
    assert.equal(timers.timeouts.length, 1);
    const logged: string[] = [];
    const ok = client({ log: (what: string) => logged.push(what) });
    ok.sess.peerGone = mock.fn(() => Promise.reject(new Error('x')));
    await ok.c.connect();
    await handshake(FakeWs.all[0]);
    FakeWs.all[0].onclose();
    await tick();
    assert.equal(ok.c.status, 'offline');
    assert.deepEqual(logged, ['let go of the tabs']);
  });

  test('reset drops the connection (letting go of the debuggers) and connects with the pairing as it is now', async () => {
    const { c, sess, setPairing, timers } = client();
    await c.connect();
    await handshake(FakeWs.all[0]);
    setPairing({ port: 50000, secret: SECRET });
    await c.reset();
    assert.equal(FakeWs.all[0].closed, 1);
    assert.equal(sess.peerGone.mock.callCount(), 1);
    assert.equal(FakeWs.all[1].url, 'ws://127.0.0.1:50000/mopilot-chrome');
    // reset while still connecting: nothing to let go of
    await c.reset();
    assert.equal(sess.peerGone.mock.callCount(), 1);
    setPairing(null);
    await c.reset();
    assert.equal(c.status, 'unpaired');
    // reset with no connection at all
    await c.reset();
    assert.equal(timers.intervals.length, 0);
    // letting go failing on reset, with no log given
    setPairing({ port: 47615, secret: SECRET });
    await c.connect();
    await handshake(FakeWs.all.at(-1) as FakeWs);
    sess.peerGone = mock.fn(() => Promise.reject(new Error('x')));
    await c.reset();
    await tick();
  });

  test('claimPairing: trades the claim code for the pairing code of the claim’s port, or gets nothing', async () => {
    const timers = fakeTimers();
    const run = async (script: (ws: FakeWs) => Promise<unknown>) => {
      FakeWs.all = [];
      const p = claimPairing(FakeWs, { port: 47615, token: 'T' }, { timers });
      await script(FakeWs.all[0]);
      return p;
    };
    const good = protocol.pairingCode(47615, SECRET);
    const got = await run(async (ws) => {
      await ws.from({ type: 'hello', protocol: 1, nonce: 'n' });
      assert.deepEqual(ws.sent[0], { type: 'claim', protocol: 1, token: 'T' });
      await ws.from({ type: 'paired', code: good });
    });
    assert.equal(got, good);
    assert.equal(FakeWs.all[0].closed > 0, true);
    // a code for another port, junk, a close, no answer in time
    assert.equal(await run((ws) => ws.from({ type: 'paired', code: protocol.pairingCode(50000, SECRET) })), null);
    assert.equal(await run((ws) => ws.from('junk')), null);
    assert.equal(await run((ws) => ws.from('null')), null);
    assert.equal(await run(async (ws) => ws.onclose()), null);
    assert.equal(await run(async () => timers.timeouts.at(-1)?.f()), null);
    const cannot = class {
      constructor() {
        throw new Error('bad url');
      }
    };
    assert.equal(await claimPairing(cannot, { port: 47615, token: 'T' }, { timers }), null);
    // the worker's own timers by default
    FakeWs.all = [];
    const d = claimPairing(FakeWs, { port: 47615, token: 'T' });
    FakeWs.all[0].onclose();
    assert.equal(await d, null);
  });

  test('two connects racing on the pairing read make one connection', async () => {
    const { c } = client();
    await Promise.all([c.connect(), c.connect()]);
    assert.equal(FakeWs.all.length, 1);
  });
}
