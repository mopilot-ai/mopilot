// The relay path of the user's machines (electron/host/machineRelay.cjs, relayPaths.cjs): each row's path word and facts, a paired
// machine reached over SSH given a relay path once (and again only after the retry wait), a failed enrollment that leaves no
// credential behind, the mode a machine is pinned to, an unreadable or unsealable store, and a removed machine's path taken away.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { createMachineRelay, ENROLL_RETRY_MS } = require('../electron/host/machineRelay.cjs');
const { createRelayPaths, relayUrl } = require('../electron/host/relayPaths.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

const safe = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`x${s}`),
  decryptString: (b: Buffer) => b.toString().slice(1),
};
const scratch = (t: any) => {
  const d = fs.realpathSync(fs.mkdtempSync('/tmp/mrel-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
function fakeRegistry(rows: any[]) {
  const fns = new Set<() => void>();
  return {
    rows,
    list: () => rows,
    onChange: (fn: () => void) => (fns.add(fn), () => fns.delete(fn)),
    fire: () => [...fns].forEach((f) => f()),
  };
}
function fakeRelay() {
  const enrolled = new Set<string>();
  const rotate = new Set<string>();
  const modes: Record<string, string> = {};
  const laneFns = new Set<() => void>();
  const removed = new Set<string>();
  return {
    enrolled: (a: string) => enrolled.has(a),
    removed,
    removedByPeer: (a: string) => removed.has(a),
    needsRotation: (a: string) => rotate.has(a),
    calls: [] as any[],
    fail: null as Error | null,
    view: (a: string, t: any) => ({
      mode: modes[a] ?? 'auto',
      relay: enrolled.has(a),
      path: t?.path ?? null,
      latencyMs: t?.latencyMs ?? null,
    }),
    async enroll(this: any, a: string, call: any, wanted: () => boolean) {
      this.calls.push(['enroll', a]);
      await call('host.relayEnroll', {});
      if (this.fail) throw this.fail;
      if (wanted()) enrolled.add(a);
      rotate.delete(a);
    },
    rotate,
    async forget(this: any, a: string, call: any) {
      this.calls.push(['forget', a, !!call]);
      enrolled.delete(a);
    },
    setMode: (a: string, m: string) => (modes[a] = m),
    lane: { onChange: (fn: () => void) => (laneFns.add(fn), () => laneFns.delete(fn)) },
    disposed: false,
    dispose(this: any) {
      this.disposed = true;
    },
    laneFns,
  };
}

test('rows say Direct, Via relay with its round trip, or SSH; a paired machine is enrolled once, again only after the wait', async () => {
  mock.timers.enable({ apis: ['Date'] });
  try {
    const row = { id: 'ssh:far', address: 'far', socketPath: '/s', status: 'online', hostKey: 'k' };
    const registry = fakeRegistry([row]);
    const relay: any = fakeRelay();
    const said: string[] = [];
    let changes = 0;
    let tunnel: any = { path: null, latencyMs: null };
    let old = false;
    const m = createMachineRelay({
      relay,
      registry,
      pool: { get: () => tunnel },
      targetOf: (r: any) => r,
      allowed: () => true,
      openPaired: async () => ({
        call: async (method: string) => (said.push(method), method === 'host.hello' ? { features: old ? [] : ['relay'] } : null),
        close: () => said.push('close'),
      }),
      onChange: () => changes++,
    });
    assert.equal(m.note(row), 'SSH');
    registry.fire();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(said, ['host.hello', 'host.relayEnroll', 'close']);
    assert.equal(relay.enrolled('far'), true);
    assert.equal(m.note(row), 'Direct');
    tunnel = { path: 'relay', latencyMs: null };
    assert.equal(m.note(row), 'Via relay');
    tunnel = { path: 'relay', latencyMs: 38 };
    assert.equal(m.note(row), 'Via relay · 38 ms');
    assert.deepEqual(m.row(row), { path: { mode: 'auto', relay: true, path: 'relay', latencyMs: 38 } });
    // an enrolled machine is not enrolled again; two asks at once are one enrollment
    await m.enroll('ssh:far');
    assert.equal(relay.calls.length, 1);
    // one whose credential still is the one an install script carried is enrolled again, which replaces it
    relay.rotate.add('far');
    mock.timers.tick(ENROLL_RETRY_MS);
    await m.enroll('ssh:far');
    assert.equal(relay.calls.length, 2);
    assert.equal(relay.needsRotation('far'), false);
    const twin = { id: 'ssh:t', address: 't', socketPath: '/s', status: 'online', hostKey: 'k' };
    registry.rows.push(twin);
    await Promise.all([m.enroll('ssh:t'), m.enroll('ssh:t')]);
    assert.equal(relay.calls.filter((c: any) => c[1] === 't').length, 1);
    // an older Host (no relay feature) is asked nothing and gets no credential
    old = true;
    const older = { id: 'ssh:o', address: 'o', socketPath: '/s', status: 'online', hostKey: 'k' };
    registry.rows.push(older);
    await m.enroll('ssh:o');
    assert.equal(relay.calls.filter((c: any) => c[1] === 'o').length, 0);
    assert.equal(relay.enrolled('o'), false);
    old = false;
    // a failure is noted and tried again only after the wait
    const other = { id: 'ssh:b', address: 'b', socketPath: '/s', status: 'online', hostKey: 'k' };
    registry.rows.push(other);
    relay.fail = new Error('relay down');
    clearIgnored();
    registry.fire();
    await new Promise((r) => setImmediate(r));
    assert.match(String(recentIgnored().at(-1)?.message), /relay down/);
    registry.fire();
    await new Promise((r) => setImmediate(r));
    assert.equal(relay.calls.filter((c: any) => c[1] === 'b').length, 1, 'not again before the wait');
    relay.fail = null;
    mock.timers.tick(ENROLL_RETRY_MS);
    registry.fire();
    await new Promise((r) => setImmediate(r));
    assert.equal(relay.enrolled('b'), true);
    // a machine not in the list, offline or unpaired is left alone
    await m.enroll('ssh:none');
    registry.rows.push({ id: 'ssh:c', address: 'c', socketPath: '/s', status: 'offline' });
    registry.fire();
    assert.equal(relay.enrolled('c'), false);
    assert.ok(changes >= 2);
    // the mode is checked and kept; an unknown machine is refused
    m.setMode('ssh:far', 'relay');
    assert.equal(m.row(row).path.mode, 'relay');
    assert.throws(
      () => m.setMode('ssh:far', 'carrier pigeon'),
      (e: any) => e.code === 'bad_mode',
    );
    assert.throws(
      () => m.setMode('ssh:nope', 'ssh'),
      (e: any) => e.code === 'unknown_machine',
    );
    // removing: the path goes, through the Host while it is connected
    m.forget(row, { state: () => 'online', call: async () => undefined });
    m.forget(other, { state: () => 'offline' });
    m.forget({ address: 'c' });
    // one whose Host removed this Mac has no pair left, only its mark, which goes too (#5747)
    relay.removed.add('d');
    m.forget({ address: 'd' }, { state: () => 'offline' });
    assert.deepEqual(
      relay.calls.filter((c: any) => c[0] === 'forget'),
      [
        ['forget', 'far', true],
        ['forget', 'b', false],
        ['forget', 'd', false],
      ],
    );
    // the lane's changes reach the list; disposing stops both
    for (const fn of relay.laneFns) fn();
    m.dispose();
    assert.equal(relay.disposed, true);
    await m.enroll('ssh:b');
  } finally {
    mock.timers.reset();
  }
});

test('without a relay every row says SSH and has no path facts, and a mode cannot be set', () => {
  const registry = fakeRegistry([{ id: 'ssh:x', address: 'x', socketPath: '/s', status: 'online' }]);
  const m = createMachineRelay({
    relay: null,
    registry,
    pool: { get: () => null },
    targetOf: (r: any) => r,
    allowed: () => true,
    openPaired: async () => null,
    onChange: () => undefined,
  });
  assert.equal(m.note(registry.rows[0]), 'SSH');
  assert.deepEqual(m.row(registry.rows[0]), {});
  assert.throws(() => m.setMode('ssh:x', 'ssh'), /no relay path/);
  m.forget(registry.rows[0]);
  registry.fire();
  m.dispose();
});

test('relay paths: the default relay, a store that cannot be read or sealed, a refused enrollment and a pin all leave it consistent', async (t) => {
  const was = process.env.MOPILOT_RELAY_URL;
  delete process.env.MOPILOT_RELAY_URL;
  // MoPilot's where the build has the MoPilot service; none in one without it
  assert.equal(relayUrl(), require('../electron/platform/mopilotEndpoints.cjs').endpoints?.RELAY_URL ?? null);
  process.env.MOPILOT_RELAY_URL = 'ws://127.0.0.1:1/v1/ws';
  assert.equal(relayUrl(), 'ws://127.0.0.1:1/v1/ws');
  if (was === undefined) delete process.env.MOPILOT_RELAY_URL;
  else process.env.MOPILOT_RELAY_URL = was;

  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, 'host-relay.json'), 'not json');
  clearIgnored();
  const sent: any[] = [];
  const createSocket = () => {
    const s: any = {
      send: (text: string) => {
        const m = JSON.parse(text);
        sent.push(m);
        if (m.rid)
          setImmediate(() =>
            s.onmessage?.({
              data: JSON.stringify(m.t === 'host.register' ? { t: 'ok', op: m.t, rid: m.rid } : { t: 'ok', op: m.t, rid: m.rid }),
            }),
          );
      },
      close: () => undefined,
    };
    setImmediate(() => (s.onopen?.(), s.onmessage?.({ data: JSON.stringify({ t: 'hello', pairs: [] }) })));
    return s;
  };
  const paths = createRelayPaths({ dir, url: () => 'wss://r/v1/ws', getToken: async () => 'tok', safeStorage: safe, createSocket });
  t.after(() => paths.dispose());
  assert.equal(paths.enrolled('far'), false, 'an unreadable store is no relay path');
  assert.match(String(recentIgnored().at(-1)?.context), /relay paths/);
  assert.equal(paths.modeOf('far'), 'auto');
  assert.throws(() => paths.setMode('far', 'x'), /auto, ssh or relay/);
  paths.setMode('far', 'ssh');
  assert.equal(paths.modeOf('far'), 'ssh');
  // the Host refuses the enrollment: the credential registered for it is revoked
  await assert.rejects(
    paths.enroll('far', async () => Promise.reject(new Error('older Host'))),
    /older Host/,
  );
  assert.equal(paths.enrolled('far'), false);
  await new Promise((r) => setImmediate(r));
  assert.ok(sent.some((m) => m.t === 'host.revoke'));
  // a root this app cannot seal: both ends let go, and the error is the caller's
  const key = Buffer.alloc(32, 2).toString('base64');
  const unsealable = createRelayPaths({
    dir: scratch(t),
    url: () => 'wss://r/v1/ws',
    getToken: async () => 'tok',
    safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
    createSocket,
  });
  t.after(() => unsealable.dispose());
  const told: string[] = [];
  await assert.rejects(
    unsealable.enroll(
      'far',
      async (m: string) => (told.push(m), m === 'host.relayEnroll' ? { hostPub: key, hostEphPub: key } : Promise.reject(new Error('gone'))),
    ),
    (e: any) => e.code === 'secret_unavailable',
  );
  assert.deepEqual(told, ['host.relayEnroll', 'host.relayForget']);
  // enrolled twice: one credential stays, the first is revoked; the tunnel of a machine not enrolled is none
  // the Host refuses to forget the old id (it went away): the new path stands and the refusal is only noted
  const call = async (m: string) => (m === 'host.relayForget' ? Promise.reject(new Error('gone')) : { hostPub: key, hostEphPub: key });
  await paths.enroll('far', call);
  const before = sent.filter((m) => m.t === 'host.revoke').length;
  await paths.enroll('far', call);
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.filter((m) => m.t === 'host.revoke').length, before + 1);
  // the SSH pool gives one tunnel per machine, as sshTunnel.cjs does
  const sshTunnels = new Map<string, any>();
  const sshTunnel = (destination: string) => ({
    localSocket: `/s/${destination}`,
    state: 'offline',
    reason: '',
    onState: () => () => undefined,
    acquire: () => ({ socketPath: '/s', ready: Promise.resolve(false), release: () => undefined }),
    fail: () => undefined,
  });
  const pool = paths.pool(
    {
      get: (target: any) => {
        if (!sshTunnels.has(target.destination)) sshTunnels.set(target.destination, sshTunnel(target.destination));
        return sshTunnels.get(target.destination);
      },
    },
    dir,
  );
  const a = pool.get({ destination: 'far', remoteSocket: '/x' });
  assert.equal(pool.get({ destination: 'far', remoteSocket: '/x' }), a, 'one tunnel per machine');
  assert.equal(pool.get({ destination: 'near', remoteSocket: '/x' }).path, null);
  pool.closeAll();
  assert.deepEqual(paths.view('near'), { mode: 'auto', relay: false, path: null, latencyMs: null });
  assert.equal(await paths.forget('far'), true, 'forgotten without a Host to tell');
});

test('relay paths follow what the relay holds: a removed pair, a lost pair, another lane’s enrollment, and a machine removed mid-enrollment', async (t) => {
  const dir = scratch(t);
  const key = Buffer.alloc(32, 3).toString('base64');
  const sockets: any[] = [];
  let hello: any = { device: 'mac~h', pairs: [] };
  let refuse = false;
  const createSocket = () => {
    const s: any = {
      sent: [] as any[],
      send: (text: string) => {
        const m = JSON.parse(text);
        s.sent.push(m);
        if (m.t === 'host.register') hello.pairs.push({ pair: m.pair, peerOnline: false });
        if (m.rid)
          setImmediate(() =>
            s.onmessage?.({
              data: JSON.stringify(
                refuse && m.t === 'host.revoke' ? { t: 'error', code: 'busy', rid: m.rid } : { t: 'ok', op: m.t, rid: m.rid },
              ),
            }),
          );
      },
      close: () => undefined,
      say: (m: object) => s.onmessage?.({ data: JSON.stringify(m) }),
    };
    sockets.push(s);
    setImmediate(() => (s.onopen?.(), s.say({ t: 'hello', ...hello })));
    return s;
  };
  const paths = createRelayPaths({ dir, url: () => 'wss://r/v1/ws', getToken: async () => 'tok', safeStorage: safe, createSocket });
  t.after(() => paths.dispose());
  const call = async () => ({ hostPub: key, hostEphPub: key });
  const told: string[] = [];
  const recordingCall = async (m: string) => (told.push(m), m === 'host.relayEnroll' ? { hostPub: key, hostEphPub: key } : null);
  const until = async (fn: () => boolean) => {
    await waitFor(fn);
    assert.ok(fn());
  };
  const reopen = async () => {
    const before = sockets.length;
    sockets.at(-1).onclose?.({ code: 1006 });
    await until(() => sockets.length > before && paths.lane.state === 'open');
    await new Promise((r) => setImmediate(r));
  };

  // a machine removed while its enrollment ran: nothing is kept on either end, and the credential is revoked
  assert.equal(await paths.enroll('gone', recordingCall, () => false), null);
  assert.equal(paths.enrolled('gone'), false);
  assert.deepEqual(told, ['host.relayEnroll', 'host.relayForget']);
  await until(() => sockets.at(-1).sent.some((m: any) => m.t === 'host.revoke'));
  assert.deepEqual(paths.lane.pendingRevokes(), []);
  assert.equal(paths.lane.device, 'mac~h');

  // the relay removes a pair while the lane is up: the enrollment goes, so the machine is enrolled again later
  await paths.enroll('a', call);
  const pairA = hello.pairs.at(-1).pair;
  sockets.at(-1).say({ t: 'event', ev: 'pair.removed', pair: pairA, reason: 'revoked' });
  assert.equal(paths.enrolled('a'), false);
  sockets.at(-1).say({ t: 'event', ev: 'pair.removed', pair: 'p_unknown0001', reason: 'revoked' });

  // the relay no longer holds a pair when the lane opens again: dropped too; one it holds stays
  await paths.enroll('b', call);
  await paths.enroll('c', call);
  hello.pairs = hello.pairs.filter((p: any) => p.pair !== hello.pairs.at(-2).pair);
  await reopen();
  assert.equal(paths.enrolled('b'), false);
  assert.equal(paths.enrolled('c'), true);
  await reopen();
  assert.equal(paths.enrolled('c'), true, 'nothing changes when the relay holds every pair');

  // another account's lane: the enrollment is dropped here and its revoke waits for its own lane
  refuse = false;
  hello = { device: 'other~h', pairs: [] };
  await reopen();
  assert.equal(paths.enrolled('c'), false);
  assert.equal(paths.lane.pendingRevokes().length, 1);
  assert.ok(!sockets.at(-1).sent.some((m: any) => m.t === 'host.revoke'), 'not revoked by a lane that did not issue it');
  // a revoke the relay refuses waits; the next one still goes
  refuse = true;
  await paths.lane.revoke('h_refused0000000001');
  assert.ok(paths.lane.pendingRevokes().includes('h_refused0000000001'), 'kept after a refusal');
  refuse = false;
  // back on this install's own lane: its revoke goes; the other lane's waits for that lane
  hello = { device: 'mac~h', pairs: hello.pairs };
  await reopen();
  await until(() => paths.lane.pendingRevokes().length === 1);
  assert.deepEqual(paths.lane.pendingRevokes(), ['h_refused0000000001']);
});

test('relay paths: the default token is the MoPilot sign-in’s, a kept enrollment opens the lane at once, a saved file without fields reads empty, and closing lets every tunnel go', async (t) => {
  const dir = scratch(t);
  const key = Buffer.alloc(32, 4).toString('base64');
  const tokens: boolean[] = [];
  const headers: any[] = [];
  const createSocket = (_url: string, h: any) => {
    headers.push(h);
    const s: any = {
      send: (text: string) => {
        const m = JSON.parse(text);
        if (m.rid) setImmediate(() => s.onmessage?.({ data: JSON.stringify({ t: 'ok', op: m.t, rid: m.rid }) }));
      },
      close: () => undefined,
    };
    setImmediate(() => (s.onopen?.(), s.onmessage?.({ data: JSON.stringify({ t: 'hello', device: 'mac~h', pairs: [] }) })));
    return s;
  };
  const live = { mopilot: { relayToken: async (force?: boolean) => (tokens.push(!!force), 'acct-token') } };
  const first = createRelayPaths({ dir, url: () => 'wss://r/v1/ws', live, safeStorage: safe, createSocket });
  await first.enroll('far', async () => ({ hostPub: key, hostEphPub: key }));
  assert.equal(headers[0].authorization, 'Bearer acct-token');
  assert.deepEqual(tokens, [false]);
  // a tunnel is made only for a machine with a relay path, and closing the pool lets both kinds go (an SSH pool with no closeAll too)
  const ssh = {
    localSocket: '/s',
    state: 'offline',
    reason: 'down',
    onState: () => () => undefined,
    acquire: () => ({ socketPath: '/s', ready: Promise.resolve(false), release: () => undefined }),
    fail: () => undefined,
  };
  let sshClosed = 0;
  first.pool({ get: () => ssh, closeAll: () => sshClosed++ }, dir).closeAll();
  assert.equal(sshClosed, 1);
  const pool = first.pool({ get: () => ssh }, dir);
  const far = pool.get({ destination: 'far', remoteSocket: '/x' });
  const near = pool.get({ destination: 'near', remoteSocket: '/x' });
  far.acquire();
  near.acquire();
  assert.equal(near.reason, 'down', 'no relay path: SSH alone');
  pool.closeAll();
  first.dispose();
  // a second app run: the kept enrollment opens the lane without being asked; signed out, the default token is none
  const signedOut = createRelayPaths({ dir, url: () => 'wss://r/v1/ws', live: {}, safeStorage: safe, createSocket });
  t.after(() => signedOut.dispose());
  assert.equal(signedOut.enrolled('far'), true);
  assert.equal(signedOut.lane.state, 'connecting');
  // a saved file that names neither field is read as empty
  const bare = scratch(t);
  const { writeSecret } = require('../electron/platform/secretFile.cjs');
  writeSecret(path.join(bare, 'host-relay.json'), '{}', safe);
  const empty = createRelayPaths({ dir: bare, url: () => 'wss://r/v1/ws', safeStorage: safe, createSocket });
  t.after(() => empty.dispose());
  assert.equal(empty.enrolled('far'), false);
  assert.equal(empty.modeOf('far'), 'auto');
});

test('a relay path made elsewhere is kept to be replaced as soon as the machine answers, unless its credential never left a sealed run (pairing by code)', (t) => {
  const createSocket = () => ({ send: () => undefined, close: () => undefined, onopen: null, onmessage: null, onclose: null });
  const paths = createRelayPaths({
    dir: scratch(t),
    url: () => 'wss://r/v1/ws',
    getToken: async () => 'tok',
    safeStorage: safe,
    createSocket,
  });
  t.after(() => paths.dispose());
  const e = { hostId: 'h_a', pairId: 'p_a', relayUrl: 'wss://r/v1/ws', root: 'cm9vdA==' };
  paths.adopt('relay:h_a', e);
  assert.equal(paths.needsRotation('relay:h_a'), true, 'a command’s credential travelled in a script');
  paths.adopt('relay:h_b', { ...e, hostId: 'h_b' }, { rotate: false });
  assert.equal(paths.needsRotation('relay:h_b'), false, 'a code’s credential was sealed in the run');
  assert.equal(paths.enrolled('relay:h_b'), true);
});

test('a relay-only machine (paired by code: relay:<host id>, no socket of its own) has its path in its row and says it was paired by code; one with an SSH address and no socket has neither', () => {
  const relayOnly = {
    id: 'relay:h_abcdefghijklmnop',
    address: 'relay:h_abcdefghijklmnop',
    socketPath: '',
    status: 'online',
    pairedBy: 'code',
  };
  const bare = { id: 'ssh:bare', address: 'bare', socketPath: '', status: 'online' };
  const registry = fakeRegistry([relayOnly, bare]);
  const relay: any = fakeRelay();
  relay.setMode('relay:h_abcdefghijklmnop', 'relay');
  const m = createMachineRelay({
    relay,
    registry,
    pool: { get: () => ({ path: 'relay', latencyMs: 12 }) },
    targetOf: (r: any) => r,
    allowed: () => true,
    openPaired: async () => ({ call: async () => null, close: () => undefined }),
    onChange: () => undefined,
  });
  assert.deepEqual(m.row(relayOnly), { path: { mode: 'relay', relay: false, path: 'relay', latencyMs: 12 }, pairedBy: 'code' });
  assert.deepEqual(m.row(bare), {});
  m.dispose?.();
});
