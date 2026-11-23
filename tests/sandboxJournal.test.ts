// Lifecycle journal tests preserve operation/principal ownership, durable replay and stale-effect fencing without starting a VM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
// @ts-ignore: plain ESM without declarations
import { createSandboxJournal } from '../host/src/sandboxJournal.mjs';
const request = {
  operationId: 'op1',
  managerId: 'manager',
  principal: 'app-key',
  chatId: 'stable-chat',
  expectedEpoch: 4,
  imageDigest: 'sha256:image',
};
function rig(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-journal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'journal.json');
  const journal = createSandboxJournal({ file });
  const step = (r: any, state: string, extra = {}) =>
    journal.advance(request.principal, r.request.operationId, r.revision, r.fence, { state, ...extra });
  return { dir, file, journal, step };
}

test('reserve is durable, detached from callers and independent of request property order', (t) => {
  const r = rig(t);
  const first = r.journal.reserve(request);
  first.state = 'destroyed';
  const replay = createSandboxJournal({ file: r.file }).reserve({ ...request });
  assert.equal(replay.state, 'requested');
  assert.equal(r.journal.reserve(Object.fromEntries(Object.entries(request).reverse()) as typeof request).vmName, replay.vmName);
  const other = r.journal.reserve({ ...request, operationId: 'op2', chatId: 'other' });
  assert.notEqual(other.vmName, replay.vmName);
  assert.equal(r.journal.read(request.principal, 'op1').vmName, replay.vmName);
  assert.throws(() => r.journal.read('another-app', 'op1'), /principal/);
  assert.throws(() => r.journal.read(request.principal, 'missing'), /principal/);
  assert.throws(() => r.journal.reserve({ ...request, imageDigest: 'other-image' }), /conflicts/);
  assert.throws(() => r.journal.reserve({ ...request, operationId: 'op3' }), /pending/);
});

test('intent transitions and identity survive suspend/resume, recovery and terminal replay', (t) => {
  const r = rig(t);
  let record = r.journal.reserve(request);
  for (const state of ['cloning', 'booting', 'pairing']) record = r.step(record, state);
  assert.throws(() => r.step(record, 'prepared'), /identity/);
  record = r.step(record, 'prepared', { identity: { hostId: 'guest', publicKey: 'guest-public' } });
  assert.throws(() => r.step(record, 'ready', { identity: { hostId: 'other', publicKey: 'guest-public' } }), /identity changed/);
  assert.throws(() => r.step(record, 'ready', { identity: { hostId: 'guest', publicKey: 'changed-key' } }), /identity changed/);
  record = r.step(record, 'ready', { identity: { hostId: 'guest', publicKey: 'guest-public' } });
  for (const state of ['suspending', 'suspended', 'resuming', 'prepared', 'ready', 'recovering']) record = r.step(record, state);
  assert.throws(() => r.step(record, 'recovered'), /recovery/);
  record = r.step(record, 'recovered', {
    recovery: { kind: 'exported', transcript: 'archive:1', work: 'export:1', downloads: 'export:2' },
  });
  for (const state of ['destroying', 'destroyed']) record = r.step(record, state);
  assert.equal(r.journal.reserve(request).state, 'destroyed');
  assert.throws(() => r.step(record, 'ready'), /transition/);
  assert.equal(r.journal.reserve({ ...request, operationId: 'replacement' }).state, 'requested');
});

test('cancellation fences late completion and cannot affect a replacement operation', (t) => {
  const r = rig(t);
  const old = r.journal.reserve(request);
  const cancelled = r.step(old, 'cancelled');
  assert.throws(() => r.step(old, 'cloning'), /retired/);
  assert.throws(() => r.journal.advance('another-app', 'op1', cancelled.revision, cancelled.fence, { state: 'recovering' }), /principal/);
  const replacement = r.journal.reserve({ ...request, operationId: 'op2' });
  let cleanup = r.step(cancelled, 'recovering');
  assert.throws(
    () => r.step(cleanup, 'recovered', { recovery: { kind: 'discarded', approvedBy: 'another-app', decisionId: 'yes' } }),
    /recovery/,
  );
  cleanup = r.step(cleanup, 'recovered', {
    recovery: { kind: 'discarded', approvedBy: request.principal, decisionId: 'explicit-decision' },
  });
  cleanup = r.step(cleanup, 'destroying');
  cleanup = r.step(cleanup, 'destroyed');
  assert.equal(r.journal.read(request.principal, 'op2').fence, replacement.fence);
  assert.equal(r.journal.reserve(request).state, 'destroyed');
});

test('failed create remains its outcome and can record offline discard without a live guest', (t) => {
  const r = rig(t);
  let record = r.step(r.journal.reserve(request), 'cloning');
  record = r.step(record, 'failed');
  assert.equal(r.journal.reserve(request).state, 'failed');
  record = r.step(record, 'recovering');
  record = r.step(record, 'recovered', { recovery: { kind: 'discarded', approvedBy: request.principal, decisionId: 'offline-approved' } });
  record = r.step(record, 'destroying');
  assert.equal(r.step(record, 'destroyed').state, 'destroyed');
});

for (const malformed of [null, {}, [], { ...request, expectedEpoch: -1 }, { ...request, chatId: '' }])
  test(`invalid request ${JSON.stringify(malformed)} fails closed`, (t) => {
    const r = rig(t);
    assert.throws(() => r.journal.reserve(malformed as any), /request/);
    assert.equal(fs.existsSync(r.file), false);
  });

for (const corrupt of ['{', '{}', '[null]'])
  test(`corrupt journal ${corrupt} is retained`, (t) => {
    const r = rig(t);
    fs.writeFileSync(r.file, corrupt);
    assert.throws(() => r.journal.reserve(request));
    assert.equal(fs.readFileSync(r.file, 'utf8'), corrupt);
    assert.equal(fs.existsSync(r.file + '.lock'), false);
  });

test('tampered identity, allocation, duplicate records and revision are refused', (t) => {
  const r = rig(t);
  const record = r.journal.reserve(request);
  for (const invalid of [
    { ...record, vmName: 'foreign' },
    { ...record, revision: -1 },
    { ...record, fence: '' },
    { ...record, state: 'unknown' },
    { ...record, identity: { hostId: '', publicKey: 'key' } },
    { ...record, state: 'ready' },
  ]) {
    fs.writeFileSync(r.file, JSON.stringify([invalid]));
    assert.throws(() => r.journal.read(request.principal, 'op1'));
  }
  fs.writeFileSync(r.file, JSON.stringify([record, record]));
  assert.throws(() => r.journal.read(request.principal, 'op1'), /ownership/);
});

test('shared lock excludes another process and never steals a crash-left lock', (t) => {
  const r = rig(t);
  r.journal.reserve(request);
  fs.writeFileSync(r.file + '.lock', 'held');
  const script = `import {createSandboxJournal} from './host/src/sandboxJournal.mjs'; try {createSandboxJournal({file:process.argv[1]}).read('app-key','op1'); process.exit(2)} catch(e) {if(e.code!=='EEXIST')throw e}`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, r.file], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(fs.readFileSync(r.file + '.lock', 'utf8'), 'held');
  fs.unlinkSync(r.file + '.lock');
  assert.equal(createSandboxJournal({ file: r.file }).read(request.principal, 'op1').state, 'requested');
});

test('persistence failure preserves prior record and releases the participating lock', (t) => {
  const r = rig(t);
  const record = r.journal.reserve(request);
  const original = fs.readFileSync(r.file, 'utf8');
  t.mock.method(fs, 'renameSync', () => {
    throw new Error('disk failed');
  });
  assert.throws(() => r.step(record, 'cloning'), /disk failed/);
  assert.equal(fs.readFileSync(r.file, 'utf8'), original);
  assert.equal(fs.existsSync(r.file + '.lock'), false);
  t.mock.restoreAll();
  assert.equal(r.step(record, 'cloning').state, 'cloning');
});

for (const state of ['recovered', 'destroying', 'destroyed']) {
  for (const recovery of [
    undefined,
    [],
    {},
    { kind: 'exported', transcript: 'ok', work: '', downloads: 'ok' },
    { kind: 'discarded', approvedBy: 'foreign', decisionId: 'yes' },
  ]) {
    test(`${state}: corrupted durable recovery ${JSON.stringify(recovery)} blocks read and replay`, (t) => {
      const r = rig(t);
      const record = r.journal.reserve(request);
      fs.writeFileSync(r.file, JSON.stringify([{ ...record, state, recovery }]));
      assert.throws(() => r.journal.read(request.principal, 'op1'), /recovery/);
      assert.throws(() => r.journal.reserve(request), /recovery/);
    });
  }
}

test('recorded export cannot be replaced by another export or discard during deletion', (t) => {
  const r = rig(t);
  let record = r.journal.reserve(request);
  record = r.step(record, 'cancelled');
  record = r.step(record, 'recovering');
  const evidence = { kind: 'exported', transcript: 'archive:A', work: 'work:A', downloads: 'downloads:A' };
  record = r.step(record, 'recovered', { recovery: evidence });
  for (const replacement of [
    { ...evidence, work: 'work:B' },
    { kind: 'discarded', approvedBy: request.principal, decisionId: 'later' },
  ]) {
    assert.throws(() => r.step(record, 'destroying', { recovery: replacement }), /recovery.*changed/);
  }
  record = r.step(record, 'destroying', {
    recovery: { downloads: 'downloads:A', work: 'work:A', transcript: 'archive:A', kind: 'exported' },
  });
  assert.throws(() => r.step(record, 'destroyed', { recovery: { ...evidence, transcript: 'archive:B' } }), /recovery.*changed/);
  assert.deepEqual(r.step(record, 'destroyed').recovery, evidence);
});
