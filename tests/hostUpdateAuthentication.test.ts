// Update authentication: refresh a paired key before upload, close the fresh session, and refuse continuations after machine/access/key changes without misclassifying transport errors as pairing loss.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { STALE_KEY_MS, checkManifest } from '../shared/host/updateSignature.mjs';
import { keySafe } from './support/hostKeySafe.ts';
const require = createRequire(import.meta.url);
const { createHostUpdater } = require('../electron/host/hostUpdate.cjs');
const { loadIdentity, pairWith, authenticate } = require('../electron/host/pairingClient.cjs');
const { createPairing } = require('../host/src/pairing.mjs');
const { createUpdateKeys } = require('../host/src/updateKeys.mjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'host-update-auth-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const HOST = 'ab'.repeat(16);
const stages = ['authenticate', 'probe', 'bundle', 'archive', 'manifest', 'apply'] as const;
type Stage = (typeof stages)[number];
function world(o: { block?: Stage; auth?: () => Promise<void> } = {}) {
  const dir = fs.mkdtempSync(path.join(base, 'app-'));
  const idn = loadIdentity(path.join(dir, 'identity.json'), keySafe);
  const archive = path.join(dir, 'archive');
  fs.writeFileSync(archive, 'archive');
  let rows = [{ id: 'm', address: 'me@box', socketPath: '/host.sock' }];
  let pin = HOST;
  let allowed = true;
  let close = 0;
  let manifest: any;
  const events: Stage[] = [];
  let release!: () => void;
  let rejectGate!: (e: Error) => void;
  let entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  const gate = new Promise<void>((r, reject) => {
    release = r;
    rejectGate = reject;
  });
  async function step(s: Stage) {
    events.push(s);
    if (o.block === s) {
      entered();
      await gate;
    }
  }
  const updater = createHostUpdater({
    registry: { list: () => rows, hostKey: () => pin },
    identity: () => idn,
    isCurrent: () => true,
    allowed: () => allowed,
    session: async () => {
      await step('authenticate');
      await o.auth?.();
      return { close: () => close++ };
    },
    bundle: async () => {
      await step('bundle');
      return { file: archive, sha256: 'c'.repeat(64), version: '1' };
    },
    channel: async (_d: string, command: string, input?: Buffer) => {
      const stage: Stage = command.includes('process.report')
        ? 'probe'
        : command.includes('update --manifest')
          ? 'apply'
          : command.includes('manifest.json')
            ? 'manifest'
            : 'archive';
      if (stage === 'manifest') manifest = JSON.parse(input!.toString());
      await step(stage);
      return { code: 0, stdout: stage === 'probe' ? 'linux-x64-gnu' : '', stderr: '' };
    },
  });
  return {
    updater,
    events,
    idn,
    ready,
    release,
    rejectGate,
    closed: () => close,
    manifest: () => manifest,
    remove: () => (rows = []),
    revokeAccess: () => (allowed = false),
    moveInPlace: () => {
      rows[0].address = 'changed@box';
    },
    move: () => (rows = [{ ...rows[0], address: 'other@box' }]),
    socket: () => (rows = [{ ...rows[0], socketPath: '/other.sock' }]),
    repin: () => (pin = 'cd'.repeat(16)),
    rotate: () => {
      idn.startRotation();
      idn.promote([]);
    },
  };
}

test('authentication precedes every upload and its session is closed', async () => {
  const w = world();
  await w.updater.update('m');
  assert.deepEqual(w.events, stages);
  assert.equal(w.closed(), 1);
});

test('failed authentication sends nothing and preserves pairing versus transport refusal codes', async () => {
  for (const code of ['unknown_client', 'timed_out']) {
    const w = world({
      auth: async () => {
        throw Object.assign(new Error('refused'), { code });
      },
    });
    await assert.rejects(w.updater.update('m'), { code });
    assert.deepEqual(w.events, ['authenticate']);
  }
});

test('each awaited phase rechecks current machine, permission and signer before continuing', async () => {
  for (const stage of stages) {
    const w = world({ block: stage });
    const started = w.updater.update('m');
    await w.ready;
    w.remove();
    w.release();
    await assert.rejects(started, { code: 'update_invalidated' });
    assert.deepEqual(w.events, stages.slice(0, stages.indexOf(stage) + 1));
    assert.equal(w.closed(), 1);
  }
  for (const invalidate of ['revokeAccess', 'move', 'moveInPlace', 'socket', 'repin', 'rotate'] as const) {
    const w = world({ block: 'authenticate' });
    const started = w.updater.update('m');
    await w.ready;
    w[invalidate]();
    w.release();
    await assert.rejects(started, (e: any) => e.code === (invalidate === 'revokeAccess' ? 'not_allowed' : 'update_invalidated'));
    assert.deepEqual(w.events, ['authenticate']);
    assert.equal(w.closed(), 1);
  }
});

test('actual pairing proof renews a stale update key without removing the 180-day eligibility rule', async () => {
  const configDir = fs.mkdtempSync(path.join(base, 'host-'));
  let now = 1_800_000_000_000;
  const store = () => createUpdateKeys({ configDir, now: () => now, fileKey: () => null });
  const pairing = createPairing({ configDir, now: () => now, onSeen: (id: string) => store().markSeen(id) });
  const rpc = async (method: string, p: any) =>
    method === 'host.challenge'
      ? { nonce: pairing.challenge(), hostId: pairing.hostId() }
      : method === 'host.pair'
        ? pairing.claim(p)
        : pairing.verify(p);
  let w!: ReturnType<typeof world>;
  w = world({
    auth: async () => {
      await authenticate(rpc, w.idn);
    },
  });
  await pairWith(rpc, w.idn, pairing.issueCode());
  now += STALE_KEY_MS + 1;
  assert.ok(
    store()
      .entries()
      .every((k: any) => k.lastSeen < now - STALE_KEY_MS),
  );
  await w.updater.update('m');
  assert.equal(store().entries()[0].lastSeen, now);
  // A fresh check with a real signed manifest remains subject to the same eligibility gate.
  const m = w.manifest();
  const facts = { ...m, hostId: pairing.hostId(), notAfter: now + 1000 };
  const signed = { ...facts, signature: w.idn.signManifest(facts) };
  assert.equal(checkManifest(signed, { keys: store().entries(), hostId: pairing.hostId(), now, floor: null }).ok, true);
  now += STALE_KEY_MS + 1;
  const again = { ...facts, notAfter: now + 1000 };
  const stale = checkManifest(
    { ...again, signature: w.idn.signManifest(again) },
    { keys: store().entries(), hostId: pairing.hostId(), now, floor: null },
  );
  assert.equal(stale.ok, false);
  assert.match((stale as any).message, /180 days/);
});

test('late rejections after invalidation cannot turn an obsolete pairing error into current Pair again', async () => {
  for (const stage of stages) {
    const w = world({ block: stage });
    const started = w.updater.update('m');
    await w.ready;
    w.rotate();
    w.rejectGate(Object.assign(new Error('obsolete pairing rejection'), { code: 'unknown_client' }));
    await assert.rejects(started, { code: 'update_invalidated' });
  }
  for (const invalidate of ['revokeAccess', 'move', 'socket', 'repin'] as const) {
    const w = world({ block: 'authenticate' });
    const started = w.updater.update('m');
    await w.ready;
    w[invalidate]();
    w.rejectGate(Object.assign(new Error('obsolete pairing rejection'), { code: 'unknown_client' }));
    await assert.rejects(started, { code: invalidate === 'revokeAccess' ? 'not_allowed' : 'update_invalidated' });
  }
});
