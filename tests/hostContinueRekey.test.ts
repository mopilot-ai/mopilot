// A move begun before the Host named chats by one spelling (#5160) is not stranded by the upgrade: its owner record, epoch and waiting handoff, kept under the app's spelling of the chat's id, are the chat's under the Host's (host/src/continueRekey.mjs), checked over the real stores and the continue wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createOwnerStore } from '../host/src/owners.mjs';
// @ts-ignore
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore
import { createContinueTarget } from '../host/src/continueTarget.mjs';
// @ts-ignore
import { rekeyContinueState } from '../host/src/continueRekey.mjs';
// @ts-ignore
import { createContinueWiring } from '../host/src/continueWiring.mjs';

const APP = 'acp:host-codex:u1';
const HOST = 'u1';
const quiet = { report: () => undefined };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rekey-'));
const hostFs = { existingDirectory: async (p: string) => p } as any;

test('an owner record, its epoch and a waiting handoff under the app spelling move to the Host spelling; one already under the Host spelling stays', async () => {
  const dir = tmp();
  const owners = createOwnerStore(path.join(dir, 'owners.json'), quiet);
  const epochs = createEpochStore(path.join(dir, 'epochs.json'), quiet);
  const target = createContinueTarget({ dir: path.join(dir, 'continue'), hostFs, accepts: () => true });
  owners.put(APP, { state: 'released', epoch: 3, preparedId: 'p', targetHostId: 'C', cleaned: false, at: 1 });
  // the old Host admitted the epoch under the same id when it committed
  epochs.admit(APP, 3);
  owners.put('acp:host-claude:u2', { state: 'prepared', epoch: 2, preparedId: 'p2', harness: 'claude', cwd: '/w', nativeId: 'n2', at: 1 });
  owners.put('claude:u2', { state: 'poisoned', epoch: 9, at: 1 });
  owners.put('acp:fake:x', { state: 'poisoned', epoch: 1, at: 1 });
  const { nativeId } = await target.open({ chatId: APP, harness: 'codex', cwd: '/w', handoff: 'HANDOFF' });
  target.serve({ chatId: APP, nativeId });
  // an active chat has no owner record: only its epoch, under the app spelling
  epochs.admit('acp:host-codex:live', 4);
  rekeyContinueState({ owners, epochs, target, report: () => assert.fail('nothing to report') });
  assert.equal(epochs.current('live'), 4, 'an active chat keeps its epoch under the Host id');
  assert.equal(owners.get(APP), null);
  assert.equal(owners.get(HOST)?.state, 'released');
  assert.equal(epochs.current(HOST), 3, 'a released chat refuses an older epoch under its own id');
  assert.equal(owners.get('acp:host-claude:u2'), null);
  assert.equal(owners.get('claude:u2')?.state, 'poisoned', 'the record already under the Host id is the newer one');
  assert.equal(owners.get('acp:fake:x')?.state, 'poisoned', 'an id with one spelling stays');
  assert.equal(target.take(APP), null);
  assert.deepEqual(target.take(HOST), { text: 'HANDOFF', cwd: '/w', harness: 'codex', chatId: HOST, id: nativeId });
  // a second start finds nothing to move
  rekeyContinueState({ owners, epochs, target, report: () => assert.fail('nothing to report') });
});

test('a record kept under both spellings keeps the higher epoch, drops the other with its handoff, and never regresses the epoch; a repeat after a crash discards nothing', async () => {
  const dir = tmp();
  const owners = createOwnerStore(path.join(dir, 'owners.json'), quiet);
  const epochs = createEpochStore(path.join(dir, 'epochs.json'), quiet);
  const target = createContinueTarget({ dir: path.join(dir, 'continue'), hostFs, accepts: () => true });
  const stash = async (chatId: string) => (await target.open({ chatId, harness: 'codex', cwd: '/w', handoff: chatId })).nativeId;
  const a = await stash('a');
  const b = await stash('b');
  const c = await stash('c');
  const prepared = (nativeId: string, epoch: number, at: number) => ({
    state: 'prepared' as const,
    epoch,
    preparedId: 'p',
    harness: 'codex',
    cwd: '/w',
    nativeId,
    at,
  });
  // the app's record is newer (epoch 5 over 2): it wins and the Host's older preparation is discarded
  owners.put('acp:host-codex:one', prepared(a, 5, 1));
  owners.put('one', prepared(b, 2, 1));
  // the Host's is newer: the app's is dropped with its stash
  owners.put('acp:host-codex:two', prepared(c, 1, 1));
  owners.put('two', { state: 'poisoned', epoch: 3, at: 1 });
  // same epoch, the later one wins
  owners.put('acp:host-codex:three', { state: 'poisoned', epoch: 3, at: 5 });
  owners.put('three', { state: 'poisoned', epoch: 3, at: 2 });
  epochs.admit('acp:host-codex:one', 5);
  epochs.admit('one', 2);
  rekeyContinueState({ owners, epochs, target, report: (p: string) => assert.fail(p) });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(owners.get('one')?.epoch, 5);
  assert.equal(epochs.current('one'), 5);
  assert.equal(fs.existsSync(path.join(dir, 'continue', 'stash', `${b}.json`)), false, 'the replaced preparation was discarded');
  assert.equal(fs.existsSync(path.join(dir, 'continue', 'stash', `${a}.json`)), true);
  assert.equal(owners.get('two')?.state, 'poisoned');
  assert.equal(fs.existsSync(path.join(dir, 'continue', 'stash', `${c}.json`)), false, 'the dropped record kept no handoff behind');
  assert.equal(owners.get('three')?.at, 5);
  // a crash between the copy and the removal: the same preparation under both spellings keeps its handoff
  owners.put('acp:host-codex:one', prepared(a, 5, 1));
  rekeyContinueState({ owners, epochs, target, report: (p: string) => assert.fail(p) });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.existsSync(path.join(dir, 'continue', 'stash', `${a}.json`)), true);
  assert.equal(owners.get('acp:host-codex:one'), null);
});

test('an epoch the chat passed under the Host id is no problem; a record written before its epoch (a crash) gets the epoch; an unreadable epoch file is reported', () => {
  const dir = tmp();
  const owners = createOwnerStore(path.join(dir, 'owners.json'), quiet);
  const epochs = createEpochStore(path.join(dir, 'epochs.json'), quiet);
  const target = { pending: () => [], rekey: () => undefined, discard: async () => undefined };
  epochs.admit(APP, 3);
  epochs.admit(HOST, 5);
  // the owner record reached the disk and its epoch did not
  owners.put('acp:host-codex:crash', { state: 'poisoned', epoch: 4, at: 1 });
  rekeyContinueState({ owners, epochs, target, report: (p: string) => assert.fail(p) });
  assert.equal(epochs.current(HOST), 5);
  assert.equal(epochs.current('crash'), 4);
  const reported: string[] = [];
  const broken = {
    all: (): [string, number][] => {
      throw new Error('unreadable');
    },
    current: () => 0,
    admit: () => undefined,
  };
  rekeyContinueState({ owners, epochs: broken, target, report: (p: string) => reported.push(p) });
  assert.match(reported[0], /The epochs was not moved to its Host id/);
});

test('a handoff already kept under the Host id is not overwritten by the older one under the app id', async () => {
  const dir = tmp();
  const target = createContinueTarget({ dir: path.join(dir, 'continue'), hostFs, accepts: () => true });
  for (const [id, text] of [
    [APP, 'OLD'],
    [HOST, 'NEW'],
  ]) {
    const { nativeId } = await target.open({ chatId: id, harness: 'codex', cwd: '/w', handoff: text });
    target.serve({ chatId: id, nativeId });
  }
  target.rekey(APP, HOST);
  assert.equal(target.take(HOST)?.text, 'NEW');
  assert.equal(target.take(APP), null);
});

test('a store that cannot be read, or an epoch that cannot be written, is reported and the Host still starts', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'owners.json'), '{nonsense');
  fs.writeFileSync(path.join(dir, 'owners.json.bak'), '{nonsense');
  const owners = createOwnerStore(path.join(dir, 'owners.json'), quiet);
  const reported: string[] = [];
  const target = { pending: () => [], rekey: () => undefined, discard: async () => undefined };
  const failing = {
    all: (): [string, number][] => [[APP, 1]],
    current: () => 0,
    admit: () => {
      throw new Error('disk full');
    },
  };
  rekeyContinueState({ owners, epochs: failing, target, report: (p: string) => reported.push(p) });
  assert.equal(reported.length, 2);
  assert.match(reported[0], /The epoch of acp:host-codex:u1 was not moved to its Host id: disk full/);
  assert.match(reported[1], /The owner records was not moved/);
  // a preparation that will not close is reported
  const ok = createOwnerStore(path.join(tmp(), 'owners.json'), quiet);
  const prepared = (nativeId: string) => ({
    state: 'prepared' as const,
    epoch: 1,
    preparedId: 'p',
    harness: 'codex',
    cwd: '/w',
    nativeId,
    at: 1,
  });
  ok.put(APP, prepared('n1'));
  ok.put(HOST, prepared('n2'));
  const stuck = { ...target, discard: async () => Promise.reject(new Error('locked')) };
  rekeyContinueState({
    owners: ok,
    epochs: { all: () => [], current: () => 0, admit: () => undefined },
    target: stuck,
    report: (p: string) => reported.push(p),
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(reported.some((p) => /A replaced preparation did not close: locked/.test(p)));
});

test('a waiting handoff that cannot be moved is reported, not thrown', () => {
  const dir = tmp();
  const owners = createOwnerStore(path.join(dir, 'owners.json'), quiet);
  const reported: string[] = [];
  const target = {
    pending: () => [{ chatId: APP }, { chatId: undefined }, { chatId: HOST }],
    rekey: () => {
      throw new Error('gone');
    },
  };
  rekeyContinueState({
    owners,
    epochs: { admit: () => undefined, current: () => 0, all: () => [] },
    target: { ...target, discard: async () => undefined },
    report: (p: string) => reported.push(p),
  });
  assert.equal(reported.length, 1);
  assert.match(reported[0], /The waiting handoff of acp:host-codex:u1 was not moved to its Host id: gone/);
});

test('a Host restarted after an older one prepared a move under the app spelling activates it on the next request and carries the handoff', async () => {
  const dir = tmp();
  const old = createOwnerStore(path.join(dir, 'owners.json'), quiet);
  const target = createContinueTarget({ dir: path.join(dir, 'continue'), hostFs, accepts: () => true });
  const { nativeId } = await target.open({ chatId: APP, harness: 'codex', cwd: '/w', handoff: 'HANDOFF' });
  old.put(APP, { state: 'prepared', epoch: 1, preparedId: 'p', harness: 'codex', cwd: '/w', nativeId, at: Date.now() });
  const wiring = createContinueWiring({
    dataDir: dir,
    runtime: { host: { ids: [], chats: new Map(), starting: new Map(), close: () => undefined } } as any,
    hostFs,
    families: {
      chats: { continueServes: () => false, continueBusy: () => false, continueRetire: async () => undefined } as any,
      harnesses: async () => [],
    },
    epochs: createEpochStore(path.join(dir, 'epochs.json'), quiet),
    ledger: createLedger(path.join(dir, 'ledger'), quiet),
    report: () => undefined,
  });
  try {
    wiring.continueHost.gate(HOST, 1);
    assert.equal(wiring.target.take(HOST)?.text, 'HANDOFF');
  } finally {
    wiring.close();
  }
});
