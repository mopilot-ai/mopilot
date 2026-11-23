// The Mac's relay connection (electron/remote/relayClient.cjs) against a fake relay socket and mocked timers: the Bearer header, hello as ready, queued frames in order, backoff and jitter, token refusal and revocation, the ready timeout, the heartbeat and the JWT renewal, requests with their answers, and a stop that leaves nothing running.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { R, RelayClient, rig, withTimers } from './support/remote-relay-kit.ts';
import { deferred, tick } from './support/async-scenarios.ts';
import { FakeSocket } from './support/remoteSocket.ts';

const wire = (n: number) => ({ pair: 'p_abcdefgh', dir: 'm2p', ctr: n, nonce: 'AA==', box: 'AA==' });

test('connect: the JWT goes in the Authorization header, hello makes it ready, and presence is published', async () => {
  await withTimers(async () => {
    const { client, sockets, states } = rig();
    const opened: any[] = [];
    client.on('open', (v: any) => opened.push(v));
    client.start();
    client.start();
    await tick();
    assert.equal(sockets.length, 1, 'a second start() changes nothing');
    assert.deepEqual([sockets[0].url, sockets[0].headers], ['wss://relay.example/v1/ws', { authorization: 'Bearer jwt-1' }]);
    sockets[0].open();
    assert.deepEqual(sockets[0].sent, [], 'nothing is sent before the relay says hello');
    assert.equal(client.state, 'connecting');
    sockets[0].recv({ t: 'hello', device: 'mac-1', kind: 'desktop', pairs: [{ pair: 'p_abcdefgh' }] });
    assert.equal(client.state, 'open');
    assert.deepEqual(sockets[0].sent, [{ t: 'presence', state: 'online' }]);
    assert.deepEqual(opened, [{ pairs: [{ pair: 'p_abcdefgh' }], device: 'mac-1', peerEvents: false }]);
    assert.deepEqual(states, ['connecting', 'open']);
    client.stop();
  });
});

test('frames: queued while connecting and sent in order once open; an open socket sends at once', async () => {
  await withTimers(async () => {
    const { client, sockets } = rig();
    client.start();
    assert.equal(client.sendFrame(wire(1)), 'queued');
    assert.equal(client.sendFrame(wire(2)), 'queued');
    await tick();
    sockets[0].hello();
    assert.deepEqual(
      sockets[0].sentOf('frame').map((f) => f.ctr),
      [1, 2],
    );
    assert.equal(client.sendFrame(wire(3)), 'sent');
    assert.deepEqual(sockets[0].sent.at(-1), { t: 'frame', ...wire(3) });
    sockets[0].throwOnSend = true;
    assert.equal(client.sendFrame(wire(4)), 'dropped');
    client.stop();
  });
});

test('frames: the offline queue keeps 200 and refuses more; a stopped or revoked client refuses all', async () => {
  await withTimers(async () => {
    const { client, sockets } = rig();
    assert.equal(client.sendFrame(wire(1)), 'queued', 'before start() frames wait too');
    for (let i = 2; i <= R.MAX_QUEUED; i++) client.sendFrame(wire(i));
    assert.equal(client.sendFrame(wire(999)), 'dropped');
    client.start();
    await tick();
    sockets[0].hello();
    assert.equal(sockets[0].sentOf('frame').length, R.MAX_QUEUED);
    sockets[0].serverClose(R.CLOSE_REVOKED);
    assert.equal(client.sendFrame(wire(1)), 'dropped');
    client.start();
    client.stop();
    assert.equal(client.sendFrame(wire(1)), 'dropped');
  });
});

test('events from the relay reach the listeners; junk is ignored and a throwing listener is contained', async () => {
  await withTimers(async () => {
    const { client, sockets } = rig();
    const frames: any[] = [];
    const events: any[] = [];
    const errors: any[] = [];
    const offFrame = client.on('frame', (f: any) => frames.push(f));
    client.on('frame', () => {
      throw new Error('listener broke');
    });
    client.on('event', (e: any) => events.push(e));
    client.on('error', (e: any) => errors.push(e));
    client.start();
    await tick();
    sockets[0].hello();
    const s = sockets[0];
    s.recv({ t: 'frame', ...wire(1), extra: 'x' });
    s.recv({ t: 'event', ev: 'pair.removed', pair: 'p_abcdefgh', reason: 'unpaired' });
    s.recv({ t: 'error', code: 'mailbox_full', pair: 'p_abcdefgh', ctr: 5 });
    s.recv({ t: 'ok', op: 'presence' });
    s.recv({ t: 'ack', pair: 'p_abcdefgh' });
    s.recv('not json');
    s.recv({ t: 'mystery' });
    s.recv(null);
    s.onerror?.(new Error('x'));
    assert.deepEqual(frames, [wire(1)]);
    assert.deepEqual(events, [{ t: 'event', ev: 'pair.removed', pair: 'p_abcdefgh', reason: 'unpaired' }]);
    assert.deepEqual(errors, [{ code: 'mailbox_full', pair: 'p_abcdefgh', ctr: 5 }]);
    offFrame();
    s.recv({ t: 'frame', ...wire(2) });
    assert.equal(frames.length, 1);
    s.recv({ t: 'hello' });
    client.stop();
  });
});

test('backoff: 1 s doubling to a 10 s cap with jitter, reset by a good open', async () => {
  await withTimers(async () => {
    const { client, sockets, states } = rig({ random: () => 1 });
    client.start();
    await tick();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      sockets.at(-1)!.serverClose(1006);
      assert.equal(client.state, 'backoff');
      const before = sockets.length;
      let waited = 0;
      while (sockets.length === before) {
        mock.timers.tick(500);
        await tick();
        waited += 500;
        if (waited > 15_000) assert.fail('never reconnected');
      }
      delays.push(waited);
    }
    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 10000, 10000, 10000, 10000]);
    sockets.at(-1)!.hello();
    sockets.at(-1)!.serverClose(1006);
    const n = sockets.length;
    mock.timers.tick(1000);
    await tick();
    assert.equal(sockets.length, n + 1, 'a good open starts the backoff again at 1 s');
    assert.ok(states.includes('backoff'));
    client.stop();
  });
});

test('backoff: jitter takes between half and all of the delay', async () => {
  await withTimers(async () => {
    const { client, sockets } = rig({ random: () => 0 });
    client.start();
    await tick();
    sockets[0].serverClose(1006);
    mock.timers.tick(499);
    await tick();
    assert.equal(sockets.length, 1);
    mock.timers.tick(1);
    await tick();
    assert.equal(sockets.length, 2);
    client.stop();
  });
});

test('token: none (signed out) or a failing read retries with backoff and opens once there is one', async () => {
  await withTimers(async () => {
    const { client, sockets, asked } = rig({ tokens: [null, new Error('keychain'), 'jwt-ok'] });
    client.start();
    await tick();
    assert.equal(client.state, 'backoff');
    mock.timers.tick(1000);
    await tick();
    assert.equal(client.state, 'backoff');
    mock.timers.tick(2000);
    await tick();
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].headers.authorization, 'Bearer jwt-ok');
    assert.deepEqual(asked, [false, false, false]);
    client.stop();
  });
});

test('token: a refused token (4401) makes the next open ask for a fresh one, once', async () => {
  await withTimers(async () => {
    const { client, sockets, asked } = rig();
    client.start();
    await tick();
    sockets[0].serverClose(R.CLOSE_UNAUTHORIZED);
    mock.timers.tick(1000);
    await tick();
    sockets[1].serverClose(1006);
    mock.timers.tick(2000);
    await tick();
    assert.deepEqual(asked, [false, true, false]);
    client.stop();
  });
});

test('revoked: 4403 stops retrying until start() is called again', async () => {
  await withTimers(async () => {
    const { client, sockets, states } = rig();
    client.start();
    await tick();
    sockets[0].hello();
    sockets[0].serverClose(R.CLOSE_REVOKED);
    assert.equal(client.state, 'revoked');
    mock.timers.tick(120_000);
    await tick();
    assert.equal(sockets.length, 1);
    client.start();
    await tick();
    assert.equal(sockets.length, 2);
    assert.deepEqual(states.slice(-2), ['revoked', 'connecting']);
    client.stop();
  });
});

test('stop: closes cleanly, forgets queued frames, rejects waiting requests, and nothing reconnects', async () => {
  await withTimers(async () => {
    const { client, sockets } = rig();
    client.start();
    await tick();
    sockets[0].hello();
    const waiting = client.registerPair('p_abcdefgh');
    const caught = waiting.catch((e: Error) => e.message);
    client.stop();
    assert.deepEqual(sockets[0].closed, [1000]);
    assert.equal(await caught, 'The relay connection was closed');
    assert.equal(client.state, 'stopped');
    sockets[0].serverClose(1006);
    mock.timers.tick(200_000);
    await tick();
    assert.equal(sockets.length, 1);
    client.start();
    await tick();
    assert.equal(sockets.length, 2, 'start() after stop() opens again');
    client.stop();
    client.stop();
  });
});

test('stop: a socket that throws on close is noted; events of a socket from before are ignored', async () => {
  await withTimers(async () => {
    const { client, sockets } = rig();
    client.start();
    await tick();
    const old = sockets[0];
    old.hello();
    old.throwOnClose = true;
    client.stop();
    old.onopen?.();
    old.recv({ t: 'hello' });
    old.serverClose(1006);
    assert.equal(client.state, 'stopped');
    mock.timers.tick(5000);
    await tick();
    assert.equal(sockets.length, 1);
  });
});

test('stop: while the token is being read, no socket is ever made', async () => {
  await withTimers(async () => {
    const gate = deferred<string>();
    const sockets: FakeSocket[] = [];
    const client = new RelayClient({
      url: () => 'wss://x',
      getToken: () => gate.promise,
      createSocket: (u: string, h: any) => (sockets.push(new FakeSocket(u, h)), sockets.at(-1)),
    });
    client.start();
    client.stop();
    gate.resolve('late');
    await tick();
    assert.equal(sockets.length, 0);
  });
});

test('open: with a token but no relay named (a build without the MoPilot service), no socket is made and it waits to try again', async () => {
  await withTimers(async () => {
    const sockets: FakeSocket[] = [];
    let url: string | null = null;
    const client = new RelayClient({
      url: () => url,
      getToken: async () => 't',
      createSocket: (u: string, h: any) => (sockets.push(new FakeSocket(u, h)), sockets.at(-1)),
      random: () => 1,
    });
    client.start();
    await tick();
    assert.equal(client.state, 'backoff');
    assert.equal(sockets.length, 0);
    url = 'wss://x';
    mock.timers.tick(1000);
    await tick();
    assert.equal(sockets.length, 1);
    client.stop();
  });
});

test('open: a socket that can not be made retries; one that never says hello is closed and retried', async () => {
  await withTimers(async () => {
    const sockets: FakeSocket[] = [];
    let fail = true;
    const client = new RelayClient({
      url: () => 'wss://x',
      getToken: async () => 't',
      createSocket: (u: string, h: any) => {
        if (fail) throw new Error('bad url');
        sockets.push(new FakeSocket(u, h));
        return sockets.at(-1);
      },
      random: () => 1,
    });
    client.start();
    await tick();
    assert.equal(client.state, 'backoff');
    fail = false;
    mock.timers.tick(1000);
    await tick();
    sockets[0].open();
    mock.timers.tick(R.READY_TIMEOUT_MS - 1);
    assert.deepEqual(sockets[0].closed, []);
    mock.timers.tick(1);
    assert.deepEqual(sockets[0].closed, [R.CLOSE_STALE]);
    assert.equal(client.state, 'backoff', 'the close is handled even if the socket reports nothing');
    client.stop();
  });
});

test('open: a socket that throws when it is told to close does not stop the retry', async () => {
  await withTimers(async () => {
    const { client, sockets } = rig();
    client.start();
    await tick();
    sockets[0].open();
    sockets[0].throwOnClose = true;
    mock.timers.tick(R.READY_TIMEOUT_MS);
    assert.equal(client.state, 'backoff');
    client.stop();
  });
});

test('heartbeat: presence repeats every 30 s; answers keep it alive; three unanswered drop the socket', async () => {
  await withTimers(async () => {
    const { client, sockets } = rig();
    client.start();
    await tick();
    sockets[0].hello();
    for (let i = 0; i < 3; i++) {
      mock.timers.tick(R.HEARTBEAT_MS);
      sockets[0].recv({ t: 'ok', op: 'presence' });
    }
    assert.equal(sockets[0].sentOf('presence').length, 4);
    assert.deepEqual(sockets[0].closed, []);
    for (let i = 0; i < 3; i++) mock.timers.tick(R.HEARTBEAT_MS);
    assert.deepEqual(sockets[0].closed, []);
    mock.timers.tick(R.HEARTBEAT_MS);
    assert.deepEqual(sockets[0].closed, [R.CLOSE_STALE]);
    assert.equal(client.state, 'backoff');
    mock.timers.tick(1000);
    await tick();
    assert.equal(sockets.length, 2);
    client.stop();
  });
});

test('heartbeat: a beat after the socket is gone does nothing', async () => {
  await withTimers(async () => {
    const { client, sockets } = rig();
    client.start();
    await tick();
    sockets[0].hello();
    client.stop();
    mock.timers.tick(R.HEARTBEAT_MS * 2);
    assert.equal(sockets[0].sentOf('presence').length, 1);
  });
});

test('presence: published when set while open, remembered while down, and published again on every open', async () => {
  await withTimers(async () => {
    const { client, sockets } = rig();
    client.setPresence('sleeping');
    client.start();
    await tick();
    sockets[0].hello();
    assert.deepEqual(sockets[0].sent, [{ t: 'presence', state: 'sleeping' }]);
    client.setPresence('online');
    assert.deepEqual(sockets[0].sent.at(-1), { t: 'presence', state: 'online' });
    sockets[0].serverClose(1006);
    client.setPresence('sleeping');
    mock.timers.tick(1000);
    await tick();
    sockets[1].hello();
    assert.deepEqual(sockets[1].sent, [{ t: 'presence', state: 'sleeping' }]);
    client.stop();
  });
});

test('default socket: a global WebSocket is made with the headers option', async () => {
  const made: any[] = [];
  const real = (globalThis as any).WebSocket;
  (globalThis as any).WebSocket = class {
    constructor(...a: any[]) {
      made.push(a);
    }
    close() {}
  };
  try {
    await withTimers(async () => {
      const client = new RelayClient({ url: () => 'wss://relay.example/v1/ws', getToken: async () => 'jwt' });
      client.start();
      await tick();
      assert.deepEqual(made, [['wss://relay.example/v1/ws', { headers: { authorization: 'Bearer jwt' } }]]);
      client.stop();
    });
  } finally {
    (globalThis as any).WebSocket = real;
  }
});

test('acks: only a relay whose hello says so is sent receipts, and only while the socket is open', async () => {
  await withTimers(async () => {
    const { client, sockets } = rig();
    const f = { pair: 'p_abcdefgh', dir: 'p2m', ctr: 3 };
    assert.equal(client.sendAck(f), false, 'not connected');
    client.start();
    await tick();
    sockets[0].hello();
    assert.equal(client.acks, false);
    assert.equal(client.sendAck(f), false, 'a relay without acks would reject one');
    sockets[0].serverClose(1006);
    await tick();
    mock.timers.tick(1000);
    await tick();
    sockets[1].recv({ t: 'hello', device: 'mac-1', kind: 'desktop', pairs: [], acks: true });
    assert.equal(client.acks, true);
    assert.equal(client.sendAck(f), true);
    assert.deepEqual(sockets[1].sent.at(-1), { t: 'ack', ...f });
    sockets[1].throwOnSend = true;
    assert.equal(client.sendAck(f), false, 'a socket that refuses says so');
    sockets[1].serverClose(1006);
    assert.equal(client.acks, false, 'a lost connection forgets what the old relay said');
    client.stop();
    assert.equal(client.acks, false);
  });
});

test('reconnect: an open connection is dropped and a fresh one opens after the short wait, so the relay sends again what was not acknowledged', async () => {
  await withTimers(async () => {
    const { client, sockets } = rig({ random: () => 1 });
    client.start();
    await tick();
    client.reconnect();
    assert.equal(sockets.length, 1, 'nothing to drop before the relay said hello');
    sockets[0].hello();
    client.reconnect();
    assert.equal(client.state, 'backoff', 'the old socket is let go');
    mock.timers.tick(1000);
    await tick();
    assert.equal(sockets.length, 2, 'and a new one opens');
    sockets[1].hello();
    assert.equal(client.state, 'open');
    client.stop();
    client.reconnect();
    assert.equal(client.state, 'stopped', 'a stopped client stays stopped');
  });
});
