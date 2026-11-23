// Add by command says when it fails (#2709, Remote Run one-click fix 6): a Host this app could not send, or a machine that ran the command and went quiet, ends the card with its cause (`failed`); a machine allowed but whose Host never answered, or whose setup broke after pairing, is `join_failed` with its cause, and Try again (`start(true)`) repeats only the step that failed while the machine stays listed.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { waitFor } from './support/waitFor.ts';
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';
import { createCrypto } from '../shared/remote/crypto.mjs';
import { toBase64 } from '../shared/remote/envelope.mjs';
import { enrollKeys, sealEnroll } from '../shared/host/relayEnroll.mjs';

const require = createRequire(import.meta.url);
const { createRelayBoot, STALL_MS } = require('../electron/host/relayBoot.cjs');
const { createMachineBoot } = require('../electron/host/machineBoot.cjs');

const bundleFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bjf-')), 'b.tgz');
fs.writeFileSync(bundleFile, 'bundle bytes');
const sha = crypto.createHash('sha256').update('bundle bytes').digest('hex');
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

function fakeLane() {
  const lane: any = {
    notes: [] as any[],
    routes: {} as Record<string, any>,
    route: (pair: string, r: any) => ((lane.routes[pair] = r), () => undefined),
    onBoot: (fn: any) => ((lane.boot = fn), () => (lane.boot = null)),
    whenOpen: async () => undefined,
    intend: () => undefined,
    settle: () => undefined,
    register: async () => undefined,
    request: async () => undefined,
    revoke: async () => undefined,
    send: () => true,
    notify: (m: any) => (lane.notes.push(m), true),
  };
  return lane;
}
const boot = (lane: any, bundleSha = sha) =>
  createRelayBoot({
    lane,
    paths: { adopt: () => undefined },
    url: () => 'wss://r/v1/ws',
    bundle: () => ({ file: bundleFile, sha256: bundleSha, version: '1' }),
  });
const bootIdOf = (command: string) => /\/v1\/boot\/(b_[\w-]+)' -o/.exec(command)![1];

test('a Host this app cannot send ends the command with the reason; the card can ask for a new one', async () => {
  for (const [build, bundleSha, reason] of [
    ['linux-x64-gnu', '0'.repeat(64), 'The Host package does not match its checksum'],
    ['linux-sparc-gnu', sha, 'There is no Host build linux-sparc-gnu'],
  ] as const) {
    const lane = fakeLane();
    const b = boot(lane, bundleSha);
    const v = await b.start();
    lane.boot({ boot: bootIdOf(v.command), req: 'r1', what: 'bundle', ip: '', build });
    await flush();
    assert.deepEqual(lane.notes.at(-1), { t: 'boot.data', req: 'r1', failed: true });
    assert.equal(b.view.state, 'failed');
    assert.equal(b.view.command, '');
    assert.equal(b.view.error, `MoPilot could not send the Host to the machine (${reason}).`);
  }
  // an error with no message still says something
  const lane = fakeLane();
  const odd = createRelayBoot({
    lane,
    paths: { adopt: () => undefined },
    url: () => 'wss://r/v1/ws',
    bundle: async () => {
      if (lane.boot) throw null;
      return { file: bundleFile, sha256: sha, version: '1' };
    },
  });
  const v = await odd.start();
  lane.boot({ boot: bootIdOf(v.command), req: 'r1', what: 'bundle', ip: '', build: 'darwin-arm64' });
  await flush();
  assert.match(odd.view.error, /\(unknown reason\)\.$/);
});

test('a machine that fetched the command and went quiet is failed after the stall; every request starts the wait again', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const lane = fakeLane();
  const b = boot(lane);
  const v = await b.start();
  lane.boot({ boot: bootIdOf(v.command), req: 'r1', what: 'script', ip: '5.5.5.5' });
  await flush();
  mock.timers.tick(STALL_MS - 1000);
  lane.boot({ boot: bootIdOf(v.command), req: 'r2', what: 'bundle', ip: '', build: 'linux-x64-gnu' });
  await flush();
  mock.timers.tick(STALL_MS - 1000);
  assert.equal(b.view.state, 'waiting');
  mock.timers.tick(1000);
  assert.equal(b.view.state, 'failed');
  assert.equal(b.view.command, '');
  assert.match(
    b.view.error,
    /started the command but did not finish joining\. Check its terminal for the line that starts with “MoPilot:”, then try again\.$/,
  );
  // a new command is a new wait; a stall that fires after Deny does nothing
  const again = await b.start();
  assert.equal(b.view.state, 'waiting');
  lane.boot({ boot: bootIdOf(again.command), req: 'r3', what: 'script', ip: '' });
  await flush();
  b.deny();
  mock.timers.tick(STALL_MS);
  assert.equal(b.view.state, 'denied');
});

function join(opts: { pair: (id: string, code: string) => Promise<void>; openPaired?: any }) {
  const views: any[] = [];
  const rows: any[] = [];
  const bootStub: any = {
    view: { state: 'asking', machine: { name: 'far-box' } },
    start: async () => ({ state: 'waiting' }),
    allow: () => ({ destination: 'relay:h_1', name: 'far-box', socketPath: '', hostKey: '', pairingCode: 'ABCD', hostId: 'h_1' }),
    deny: () => undefined,
    dispose: () => undefined,
  };
  let made: any;
  const m = createMachineBoot({
    relay: { lane: {}, url: () => 'u', adopt: () => undefined, enroll: async () => undefined } as any,
    registry: { add: (r: any) => rows.push(r), list: () => rows },
    bundle: () => ({ file: '/x', sha256: '0', version: '1' }),
    updateKey: () => crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    pair: opts.pair,
    openPaired: opts.openPaired ?? (async () => ({ call: async () => null, close: () => undefined })),
    sleep: async () => undefined,
    onView: (v: any) => views.push(v),
    makeBoot: (o: any) => ((made = o), bootStub),
  });
  return { m, views, rows, change: (v: any) => made.onChange(v) };
}

test('the join says joining, then ready; Try again after a Host that never answered pairs again and the machine stays listed', async (t) => {
  const { useFakeClock } = await import('./support/ports/clock.ts');
  const clock: any = useFakeClock(t, 0);
  let up = false;
  let pairs = 0;
  const views: any[] = [];
  const rows: any[] = [];
  const m = createMachineBoot({
    relay: { lane: {}, url: () => 'u', adopt: () => undefined, enroll: async () => undefined } as any,
    registry: { add: (r: any) => rows.push(r), list: () => rows },
    bundle: () => ({ file: '/x', sha256: '0', version: '1' }),
    updateKey: () => crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    pair: async () => {
      pairs++;
      if (!up) throw new Error('never up');
    },
    openPaired: async () => ({ call: async () => null, close: () => undefined }),
    sleep: async (ms: number) => clock.advance(ms),
    onView: (v: any) => views.push(v),
    makeBoot: () =>
      ({
        view: { state: 'asking', machine: { name: 'far-box' } },
        start: async () => ({ state: 'waiting' }),
        allow: () => ({ destination: 'relay:h_1', name: 'far-box', socketPath: '', hostKey: '', pairingCode: 'ABCD', hostId: 'h_1' }),
      }) as any,
  });
  assert.deepEqual(m.allow(), { id: 'relay:h_1' });
  assert.equal(m.view().state, 'joining');
  await waitFor(() => m.view().state === 'join_failed', 'the join to give up');
  assert.equal(m.view().error, 'far-box was added, but its Host did not start answering within 2 minutes.');
  assert.equal(rows.length, 1, 'the machine stays listed');
  up = true;
  const view = await m.start(true);
  assert.equal(view.state, 'joining');
  await waitFor(() => m.view().state === 'ready', 'the retry to finish');
  assert.equal(views.at(-1).state, 'ready');
  // nothing failed any more: a retry asks for a new command instead
  const before = pairs;
  assert.equal((await m.start(true)).state, 'waiting');
  assert.equal(pairs, before);
});

test('a setup that broke after pairing says so, and Try again does not pair a second time; a new command ends what the join said', async () => {
  let pairs = 0;
  let opens = 0;
  const w = join({
    pair: async () => void pairs++,
    openPaired: async () => {
      if (++opens === 1) throw new Error('relay dropped');
      return { call: async () => null, close: () => undefined };
    },
  });
  await w.m.start();
  w.change({ state: 'joined' });
  w.m.allow({ name: 'renamed' });
  await waitFor(() => w.m.view().state === 'join_failed', 'the setup to fail');
  assert.equal(w.m.view().error, 'renamed was added, but finishing its setup over the relay failed.');
  await w.m.start(true);
  await waitFor(() => w.m.view().state === 'ready', 'the retry to finish');
  assert.equal(pairs, 1, 'a pairing that took is not repeated');
  assert.equal(opens, 2);
  w.change({ state: 'waiting' });
  assert.equal(w.m.view().state, 'asking');
});

test('a request that arrives after the machine said hello does not fail the card that is asking', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const prim = createNodePrimitives();
  const lane = fakeLane();
  const b = boot(lane);
  const v = await b.start();
  const pair = Object.keys(lane.routes)[0];
  const code = /sh "\$f" ([\w-]+);/.exec(v.command)![1];
  lane.boot({ boot: bootIdOf(v.command), req: 'r1', what: 'script', ip: '' });
  const pub = toBase64(prim.x25519Base(prim.randomBytes(32)));
  lane.routes[pair].onFrame(
    sealEnroll(prim, enrollKeys(createCrypto(prim), code, pair).p2m, pair, 'p2m', { hostPub: pub, hostEphPub: pub, name: 'n' }),
  );
  assert.equal(b.view.state, 'asking');
  // another run of the same command asks for the bundle: its silence is not this card's failure
  lane.boot({ boot: bootIdOf(v.command), req: 'r2', what: 'bundle', ip: '', build: 'linux-x64-gnu' });
  await flush();
  mock.timers.tick(STALL_MS);
  assert.equal(b.view.state, 'asking');
});
