// Computer access (#1364), this Mac's side over a real loopback connection: off unless the person turned it on (and the
// remote switch didn't turn it off), pairing only with a person's Allow here and a code shown on both sides, and only
// a paired device's own connection; what it listens on, and what Settings is shown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  world,
  until,
  ClientConnection,
  newKeyPair,
  parseOffer,
  RemoteOwners,
  HANDSHAKE_BYTES,
  HANDSHAKES_MAX,
  ATTEMPTS_PER_MINUTE,
} from './support/computer-access-kit.ts';

test('off by default: nothing listens until the person turns access on, and the remote switch keeps it off', async () => {
  let flag = true;
  const w = await world({ enabled: false, flag: () => flag });
  try {
    assert.equal(w.host.listening, null);
    assert.equal(w.host.state().enabled, false);
    assert.equal(w.host.startPairing(), null);
    flag = false;
    await w.host.setEnabled(true);
    assert.equal(w.host.listening, null);
    assert.equal(w.host.state().blocked, true);
    flag = true;
    await w.host.sync();
    assert.ok(w.host.listening.port > 0);
    assert.equal(w.host.listening.address, '127.0.0.1');
    // syncing again while listening on the same interface changes nothing
    const port = w.host.listening.port;
    await w.host.sync();
    assert.equal(w.host.listening.port, port);
  } finally {
    await w.close();
  }
});

test('pairing: the code matches on both sides, nothing is trusted before the person allows it, and scopes are theirs', async () => {
  const w = await world();
  try {
    const { c, device, code } = await w.pair({ browser: true, apps: true }, 'Du’s Laptop');
    assert.equal(device.name, 'Du’s Laptop');
    assert.deepEqual(device.scopes, { browser: true, chrome: false, apps: true, files: false });
    assert.match(code, /^\d{3} \d{3}$/);
    assert.equal(c.open, true);
    const st = w.host.state();
    assert.equal(st.devices.length, 1);
    assert.equal(st.devices[0].online, true);
    assert.equal(typeof st.devices[0].lastSeen, 'number');
    assert.match(st.devices[0].fingerprint, /^[0-9a-f]{32}$/);
    assert.equal('key' in st.devices[0], false);
    assert.deepEqual(
      w.log.recent().map((l: any) => l.event),
      ['connected', 'paired', 'pairing'],
    );
  } finally {
    await w.close();
  }
});

test('pairing: Deny, a cancelled dialog, a device that gave up and a request nobody answers all pair nothing', async () => {
  const w = await world();
  try {
    const start = async () => {
      const offer = parseOffer(w.host.startPairing().text);
      const c = new ClientConnection({
        url: w.url(),
        identity: newKeyPair(),
        pair: { name: 'x', secret: offer.secret, fingerprint: offer.fingerprint },
      });
      await c.connect();
      await until(() => w.host.request);
      return c;
    };
    let c = await start();
    let paired = c.paired();
    assert.equal(w.host.answerPairing(false), null);
    await assert.rejects(paired, /didn't accept this device's key/);
    c = await start();
    paired = c.paired();
    w.host.cancelPairing();
    await assert.rejects(paired, /not pairing a device right now/);
    // the device gives up while the person decides: an Allow afterwards pairs nothing
    c = await start();
    c.close();
    await until(() => !w.host.request);
    assert.equal(w.host.answerPairing(true), null);
    // a new offer drops a waiting device
    c = await start();
    paired = c.paired();
    w.host.startPairing();
    await assert.rejects(paired, /not pairing/);
    assert.equal(w.store.devices().length, 0);
    // nobody answers: the device is let go when the offer would have expired
    w.host.offers.ttlMs = 30;
    c = await start();
    paired = c.paired();
    await assert.rejects(paired, /not pairing/);
    assert.equal(w.host.request, null);
    // the person allowing after access went off pairs nothing either
    w.host.offers.ttlMs = 60_000;
    c = await start();
    paired = c.paired();
    paired.catch(() => {});
    const req = w.host.request;
    w.host.request = null;
    await w.host.stop('off');
    w.host.request = req;
    assert.equal(w.host.answerPairing(true), null);
    assert.equal(w.host.answerPairing(true), null);
  } finally {
    await w.close();
  }
});

test('pairing: a stolen offer is used up by its first try, and a second device finds no offer', async () => {
  const w = await world();
  try {
    const offer = parseOffer(w.host.startPairing().text);
    const thief = new ClientConnection({
      url: w.url(),
      identity: newKeyPair(),
      pair: { name: 'x', secret: 'S'.repeat(43), fingerprint: offer.fingerprint },
    });
    await assert.rejects(thief.connect(), /didn't accept|unauthorized|did not prove/);
    const late = new ClientConnection({
      url: w.url(),
      identity: newKeyPair(),
      pair: { name: 'y', secret: offer.secret, fingerprint: offer.fingerprint },
    });
    await assert.rejects(late.connect(), /not pairing a device right now/);
    assert.equal(w.store.devices().length, 0);
  } finally {
    await w.close();
  }
});

test('connections: a device that is not paired, a page in a browser, a wrong path and a stalled handshake are refused', async () => {
  const w = await world();
  try {
    const stranger = new ClientConnection({ url: w.url(), identity: newKeyPair(), hostKey: newKeyPair().x });
    await assert.rejects(stranger.connect(), /not paired with that computer/);
    // a browser page always sends an Origin header
    const port = w.host.listening.port;
    const http = await import('node:http');
    const status = (headers: any, p = '/mopilot-access') =>
      new Promise<number>((resolve) => {
        const req = http.request({
          host: '127.0.0.1',
          port,
          path: p,
          headers: {
            connection: 'Upgrade',
            upgrade: 'websocket',
            'sec-websocket-version': '13',
            'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
            ...headers,
          },
        });
        req.on('response', (res) => resolve(res.statusCode ?? 0));
        req.on('upgrade', () => resolve(101));
        req.on('error', () => resolve(-1));
        req.end();
      });
    assert.equal(await status({ origin: 'https://evil.example' }), 403);
    assert.equal(await status({}, '/other'), 403);
    // a request that is not a WebSocket upgrade
    assert.equal(await status({ upgrade: 'nope' }), 400);
    assert.equal(await status({ 'sec-websocket-version': '8' }), 400);
    const plain = await new Promise<number>((resolve) =>
      http.get({ host: '127.0.0.1', port, path: '/' }, (res) => resolve(res.statusCode ?? 0)),
    );
    assert.equal(plain, 404);
    // a client that never says hello is dropped
    const raw = new WebSocket(w.url());
    const code = await new Promise((resolve) => raw.addEventListener('close', (e: any) => resolve(e.code)));
    assert.equal(code, 4408);
  } finally {
    await w.close();
  }
});

test('listening: other computers only when allowed, another port when the usual one is taken, and off while opening', async () => {
  const servers: any[] = [];
  const fakeHttp = (fail: (port: number, host: string) => any) => ({
    createServer: (handler: Function) => {
      const s: any = new EventEmitter();
      s.handler = handler;
      s.listen = (port: number, host: string, cb: Function) => {
        const err = fail(port, host);
        if (err) return setImmediate(() => s.emit('error', err));
        s.port = port || 50000;
        s.host = host;
        setImmediate(() => cb());
      };
      s.address = () => ({ port: s.port });
      s.close = (cb?: Function) => {
        s.closed = true;
        cb?.();
      };
      servers.push(s);
      return s;
    },
  });
  const w = await world({ enabled: false });
  try {
    let refusal: any = null;
    w.host.o.http = fakeHttp((port) => (port === 47616 ? Object.assign(new Error('busy'), { code: 'EADDRINUSE' }) : refusal));
    w.host.o.port = undefined;
    w.host.o.lanAddress = () => '192.168.1.20';
    await w.host.setEnabled(true);
    assert.deepEqual(w.host.listening, { address: '127.0.0.1', port: 50000 });
    await w.host.setLan(true);
    assert.deepEqual(w.host.listening, { address: '192.168.1.20', port: 50000 });
    assert.equal(servers.at(-1).host, '0.0.0.0');
    w.host.o.lanAddress = undefined;
    await w.host.setLan(false);
    await w.host.setLan(true);
    assert.equal(w.host.listening.address, '0.0.0.0');
    // a listen error other than a taken port fails the start
    await w.host.stop('test');
    refusal = Object.assign(new Error('denied'), { code: 'EACCES' });
    w.host.o.http = fakeHttp(() => refusal);
    const before = servers.length;
    await assert.rejects(w.host.sync(), /denied/);
    assert.equal(w.host.server, null);
    // the server that failed to listen is closed, not left behind
    assert.equal(servers[before].closed, true);
    // the network choice changing while a start is under way: the start that wins is for the choice made last
    refusal = null;
    w.host.o.lanAddress = () => '10.0.0.5';
    const first = w.host.sync();
    w.store.setLan(true);
    const second = w.host.sync();
    await Promise.all([first, second]);
    assert.equal(servers.at(-1).host, '0.0.0.0');
    assert.equal(w.host.listening.address, '10.0.0.5');
    w.store.setLan(false);
    await w.host.stop('test');
    // turned off while it was opening: it doesn't stay open
    refusal = null;
    let on = true;
    w.host.o.flagOn = () => on;
    const opening = w.host.sync();
    on = false;
    await opening;
    assert.equal(w.host.listening, null);
    // the listener's own errors after it opened are noted, not thrown; the 404 page answers plain requests
    on = true;
    await w.host.sync();
    servers.at(-1).emit('error', new Error('later'));
    const res: any = { writeHead: () => ({ end: () => 'ended' }) };
    assert.equal(servers.at(-1).handler({}, res), undefined);
    // an upgrade the WebSocket helper refuses leaves nothing behind
    w.host.o.accept = () => null;
    servers.at(-1).emit('upgrade', { url: '/mopilot-access', headers: {} }, { end: () => {} }, Buffer.alloc(0));
    assert.equal(w.host.conns.size, 0);
  } finally {
    await w.close();
  }
});

test('state: what Settings shows, with nothing secret in it', async () => {
  const w = await world();
  try {
    const { c, device } = await w.pair();
    await c.call({ chat: 'c', turn: 't', harness: 'acp:opencode', tool: 'browser_navigate' });
    w.host.startPairing();
    const st = w.host.state();
    assert.equal(st.available, true);
    assert.equal(st.problem, null);
    assert.equal(st.enabled, true);
    assert.equal(st.blocked, false);
    assert.equal(st.lan, false);
    assert.ok(st.pairing.expiresAt > Date.now());
    assert.equal(st.request, null);
    assert.deepEqual(st.active, [
      { id: RemoteOwners.idOf(device.id, 'c'), device: device.id, deviceName: 'Laptop', chat: 'c', harness: 'acp:opencode' },
    ]);
    assert.equal(JSON.stringify(st).includes(w.store.identity().d), false);
    let changes = 0;
    w.host.on('change', () => changes++);
    w.host.cancelPairing();
    assert.ok(changes > 0);
  } finally {
    await w.close();
  }
});

test('before the handshake: small messages only, few handshakes at once, and a source that keeps trying is turned away', async () => {
  const w = await world();
  try {
    // a hello the size of a frame is refused before it is read
    const big = new WebSocket(w.url());
    await new Promise((r) => big.addEventListener('open', r));
    big.send('x'.repeat(HANDSHAKE_BYTES + 10));
    assert.equal(await new Promise((r) => big.addEventListener('close', (e: any) => r(e.code))), 1009);
    // many sockets that never say hello: those past the limit are turned away at once
    const sockets: WebSocket[] = [];
    const codes: number[] = [];
    for (let i = 0; i < HANDSHAKES_MAX + 2; i++) {
      const s = new WebSocket(w.url());
      s.addEventListener('error', () => {});
      s.addEventListener('close', (e: any) => codes.push(e.code));
      sockets.push(s);
      await until(() => s.readyState !== WebSocket.CONNECTING);
    }
    assert.ok(sockets.filter((s) => s.readyState === WebSocket.OPEN).length <= HANDSHAKES_MAX);
    for (const s of sockets) s.close();
    await until(() => [...w.host.conns].length === 0);
    // one source past its attempts this minute
    w.host.attempts.set(
      '127.0.0.1',
      Array.from({ length: ATTEMPTS_PER_MINUTE }, () => Date.now()),
    );
    w.host.attempts.set(
      '::ffff:127.0.0.1',
      Array.from({ length: ATTEMPTS_PER_MINUTE }, () => Date.now()),
    );
    const late = new ClientConnection({ url: w.url(), identity: newKeyPair(), hostKey: newKeyPair().x });
    await assert.rejects(late.connect());
    // a minute later it may try again
    w.host.attempts.clear();
    const { c } = await w.pair();
    assert.equal(c.open, true);
  } finally {
    await w.close();
  }
});

test('one device with two connections: the old one closing leaves the owners the new one serves', async () => {
  const w = await world();
  try {
    const a = await w.pair();
    await a.c.call({ chat: 'c', turn: 't', tool: 'browser_navigate' });
    const b = await w.connect(a.identity, a.hostKey);
    await b.call({ chat: 'c', turn: 't', tool: 'browser_navigate' });
    const id = RemoteOwners.idOf(a.device.id, 'c');
    a.c.close();
    await until(() => [...w.host.conns].length === 1);
    assert.ok(w.owners.get(id));
    b.close();
    await until(() => !w.owners.get(id));
  } finally {
    await w.close();
  }
});
