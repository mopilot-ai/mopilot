// The edges of a move on one Host (host/src/momoMove.mjs, electron/host/bundle.cjs, host/src/momoWiring.mjs): a step that lands between another step's read and write, a clock that runs out during a switch, a receipt that is gone, a target with no key folder, a build with no TypeScript stripper, and the wired home stopping its turns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createMomoHome } from '../host/src/momoHome.mjs';
// @ts-ignore
import { createMomoMove, MOVE_TTL_MS } from '../host/src/momoMove.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../host/src/secretStore.mjs';
// @ts-ignore
import { createMomoHidden, momoHomeFor } from '../host/src/momoWiring.mjs';
import { A, B, host, studio } from './support/host/momoMoveWorld.ts';

const require = createRequire(import.meta.url);
const ids = { moveId: 'move-0001' };
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: any) => String(e.code ?? e.message),
  );
async function untilCopied(a: any, b: any) {
  const offer = await b.side.call('offer', ids);
  await a.side.call('begin', ids);
  const sealed = await a.side.call('seal', { ...ids, targetKey: offer.targetKey, signKey: offer.signKey });
  await b.side.call('receive', { ...ids, sealed: sealed.sealed, bundleHash: sealed.bundleHash });
}
const commit = (b: any) => b.side.call('commit', { ...ids, leaseEpoch: 2, homeId: 'ignored', name: B.name, from: A.name });

test('a step that lands between another step’s read and its write decides: it is refused, or it finds its own work already done', async (t) => {
  const a = await studio(t);
  const real = a.home.swap.bind(a.home);
  /** What another device's step does to the record just before the next write. */
  let before: ((r: any) => void) | null = null;
  a.home.swap = async (epoch: number, change: any) => {
    if (before) {
      const fn = before;
      before = null;
      await real(epoch, (r: any) => (fn(r), false));
    }
    return real(epoch, change);
  };
  // another move got in first
  before = (r) => Object.assign(r, { state: 'moving', moveId: 'move-0002', moveDeadline: a.clock.now() + MOVE_TTL_MS });
  assert.equal(await code(a.side.call('begin', ids)), 'move_in_progress');
  await real(1, (r: any) => (Object.assign(r, { state: 'running', moveId: null, moveDeadline: null }), false));
  // the same move got in first: this one finds it done and changes nothing more
  before = (r) => Object.assign(r, { state: 'moving', moveId: 'move-0001', moveDeadline: a.clock.now() + MOVE_TTL_MS });
  assert.equal(await code(a.side.call('begin', ids)), 'ok');
  assert.equal(a.home.status().home.state, 'moving');
});

test('a switch that runs out of time while its files are being checked is refused and leaves nothing', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  await untilCopied(a, b);
  const real = b.home.canAdopt.bind(b.home);
  b.home.canAdopt = (epoch: number) => {
    real(epoch);
    b.clock.at += MOVE_TTL_MS + 1; // the offer's time is out before the record is written
  };
  assert.equal(await code(commit(b)), 'move_expired');
  assert.equal(b.home.status().home?.state ?? 'none', 'none');
});

test('a discard that finds the switch made but its receipt gone still says it switched, and signs nothing', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  await untilCopied(a, b);
  await commit(b);
  await b.home.swap(b.home.record().leaseEpoch, (r: any) => ((r.moveReceipts = {}), false));
  const said = await b.side.call('discard', ids);
  assert.deepEqual([said.committed, said.proof, said.homeId], [true, undefined, B.homeId]);
});

test('a target with no key folder still offers: nothing there is staged for a key it does not have', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-nokey-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home: any = createMomoHome({
    hostId: B.homeId,
    dataDir: path.join(dir, 'data'),
    safeStorage: createFileSafeStorage(path.join(dir, 'config')),
  });
  t.after(() => home.close());
  home.move = createMomoMove({ home });
  const offer = await home.move.offer(ids);
  assert.equal(typeof offer.targetKey, 'string');
});

test('a Host build on a Node that cannot strip TypeScript says so instead of shipping a file it cannot run', () => {
  const nodeModule = require('node:module');
  const { shipped } = require('../electron/host/bundle.cjs');
  const real = nodeModule.stripTypeScriptTypes;
  try {
    nodeModule.stripTypeScriptTypes = undefined;
    assert.throws(() => shipped('shared/x.ts', Buffer.from('export const a: number = 1;')), /cannot strip its types/);
  } finally {
    nodeModule.stripTypeScriptTypes = real;
  }
});

test('the wired home stops its MoMo chats’ turns for a move through its chats', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-wired-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = { dataDir: path.join(dir, 'data'), configDir: path.join(dir, 'config') };
  const sessions: any = { chats: { records: new Map(), patchMeta: () => undefined }, isolated: () => true, isolate: () => undefined };
  const home = momoHomeFor({
    hostId: B.homeId,
    paths,
    report: () => undefined,
    sessions,
    epochs: { current: () => 0 },
    hidden: createMomoHidden(),
  });
  t.after(() => home.close());
  assert.equal(await home.stopTurns(), undefined);
});
