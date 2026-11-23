// The Host's side of a continue (host/src/continue.mjs, owners.mjs): prepare touches nothing about the owner, the commit is one CAS on the source's epoch (A1, A3, A4), a lost reply is answered again (B2, B7), a moved chat refuses writes, a returning old owner poisons itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createOwnerStore, OwnerStoreError } from '../host/src/owners.mjs';
// @ts-ignore
import { StaleEpochError } from '../host/src/epochs.mjs';
import { CHAT, makeHost, quiet, tmpDir } from './support/hostContinueKit.ts';

const prep = (over: Record<string, unknown> = {}) => ({
  chatId: CHAT,
  epoch: 1,
  key: 'prep-key-0001',
  harness: 'claude',
  cwd: '/work/b',
  handoff: 'history',
  ...over,
});
const commit = (over: Record<string, unknown> = {}) => ({
  chatId: CHAT,
  expectedEpoch: 0,
  targetHostId: 'B',
  preparedId: 'prep-B-0001',
  ...over,
});
const code = (c: string) => (e: any) => e?.code === c;
const later = () => new Promise<void>((r) => setImmediate(r));

test('prepare opens a native session with the handoff and changes nothing about who owns the chat', async () => {
  const B = makeHost('B');
  const got = await B.host.prepare(prep());
  assert.deepEqual(got, { preparedId: 'prep-B-0001', epoch: 1, cwd: '/work/b', replayed: false });
  assert.deepEqual(B.log.opened, [{ chatId: CHAT, harness: 'claude', cwd: '/work/b', handoff: 'history' }]);
  assert.equal(B.epochs.current(CHAT), 0, 'the target holds no epoch until it is told');
  assert.equal(B.owners.get(CHAT)?.state, 'prepared');
  // the same request again (its reply was lost) is the same answer, and no second session
  const again = await B.host.prepare(prep());
  assert.deepEqual({ ...again, replayed: false }, { ...got, replayed: false });
  assert.equal(again.replayed, true);
  assert.equal(B.log.opened.length, 1);
});

test('prepare refuses with the reason when the folder or the harness is not there, and leaves no record (B4)', async () => {
  const B = makeHost('B');
  await assert.rejects(B.host.prepare(prep({ cwd: '/missing' })), code('directory_missing'));
  B.state.notConfigured = true;
  await assert.rejects(B.host.prepare(prep({ key: 'prep-key-0002' })), code('harness_not_configured'));
  assert.equal(B.owners.get(CHAT), null);
  assert.equal(B.log.opened.length, 0);
  // the refusal is the answer to that key; a retry after fixing it uses a new key
  B.state.notConfigured = false;
  await assert.rejects(B.host.prepare(prep({ cwd: '/missing' })), code('directory_missing'));
  assert.ok(await B.host.prepare(prep({ key: 'prep-key-0003' })));
});

test('prepare refuses an epoch this Host is already at or past, and a chat it runs itself', async () => {
  const B = makeHost('B');
  B.epochs.admit(CHAT, 2);
  await assert.rejects(B.host.prepare(prep({ epoch: 2 })), (e: any) => e instanceof StaleEpochError && e.current === 2);
  assert.equal(B.log.checks.length, 0);
  B.state.running.add(CHAT);
  await assert.rejects(B.host.prepare(prep({ epoch: 3, key: 'prep-key-0002' })), code('same_host'));
  // a chat this Host handed away is no longer one it runs, whatever its runtime still holds
  B.owners.put(CHAT, { state: 'released', epoch: 2, preparedId: 'old-prepared-1', targetHostId: 'A', cleaned: false, at: 1 });
  assert.equal((await B.host.prepare(prep({ epoch: 3, key: 'prep-key-0003' }))).epoch, 3);
});

test('A3: an owner that appears while the session opens voids the preparation and closes the session', async () => {
  const B = makeHost('B');
  let release!: () => void;
  B.state.gate = new Promise<void>((r) => (release = r));
  const pending = B.host.prepare(prep());
  await later();
  // the client's hello poisons the chat at epoch 1 while the target is still opening the session
  await B.host.acceptHello([{ chatId: CHAT, epoch: 1, rev: 0, targetHostId: 'C' }]);
  release();
  await assert.rejects(pending, code('stale_epoch'));
  assert.deepEqual(B.log.discarded, ['B-native-1']);
  assert.equal(B.owners.get(CHAT)?.state, 'poisoned');
});

test('A1: a second prepare for the chat is refused while one runs; the same request joins it', async () => {
  const B = makeHost('B');
  let release!: () => void;
  B.state.gate = new Promise<void>((r) => (release = r));
  const first = B.host.prepare(prep());
  const second = B.host.prepare(prep({ key: 'prep-key-0002', epoch: 2 }));
  await assert.rejects(second, code('continue_in_flight'));
  const retry = B.host.prepare(prep());
  release();
  const [a, b] = await Promise.all([first, retry]);
  assert.equal(a.preparedId, b.preparedId);
  assert.equal(B.log.opened.length, 1);
  // A4: the finished one frees the slot; a later one is not refused by it
  assert.ok(await B.host.prepare(prep({ key: 'prep-key-0003', epoch: 2 })));
});

test('A4: a failed prepare frees the slot only for itself, and a newer preparation closes the older session', async () => {
  const B = makeHost('B');
  await B.host.prepare(prep());
  await B.host.prepare(prep({ key: 'prep-key-0002', epoch: 2 }));
  assert.deepEqual(B.log.discarded, ['B-native-1']);
  assert.equal(B.owners.get(CHAT)?.epoch, 2);
});

test('a preparation that began before a restart and never settled asks the client to try again', async () => {
  const B = makeHost('B');
  // the ledger saw the intent and the Host died before the answer
  void B.ledger.once({ chatId: CHAT, key: 'prep-key-0001', method: 'chat.prepareContinue' }, () => new Promise(() => undefined));
  const restarted = B.reopen();
  await assert.rejects(restarted.host.prepare(prep()), code('prepare_unsettled'));
  assert.ok(await restarted.host.prepare(prep({ key: 'prep-key-0002' })));
});

test('commit is one CAS: the epoch moves by one, the owner record says released, the chat is read-only here', async () => {
  const A = makeHost('A');
  A.state.running.add(CHAT);
  const got = await A.host.commit(commit());
  assert.deepEqual(got, { epoch: 1, targetHostId: 'B', preparedId: 'prep-B-0001', replayed: false });
  assert.equal(A.epochs.current(CHAT), 1);
  assert.deepEqual(A.owners.get(CHAT), {
    state: 'released',
    epoch: 1,
    preparedId: 'prep-B-0001',
    targetHostId: 'B',
    cleaned: false,
    at: 1000,
  });
  assert.throws(
    () => A.host.gate(CHAT, 1),
    (e: any) => e.code === 'chat_released' && e.details.targetHostId === 'B' && e.details.epoch === 1,
  );
  // reads are still served, and nothing changes
  A.host.touch(CHAT, 1);
});

test('B2/B7: a commit whose reply was lost is answered again with the same answer, also after a restart, and heals the epoch file', async () => {
  const A = makeHost('A');
  const first = await A.host.commit(commit());
  const again = await A.host.commit(commit());
  assert.deepEqual({ ...again, replayed: false }, first);
  assert.equal(again.replayed, true);
  const restarted = A.reopen();
  assert.equal((await restarted.host.commit(commit())).epoch, 1);
  // a crash between the owner write and the epoch write: the record is the commit point
  const crashed = makeHost('A2');
  crashed.owners.put(CHAT, { state: 'released', epoch: 1, preparedId: 'prep-B-0001', targetHostId: 'B', cleaned: false, at: 1 });
  assert.equal(crashed.epochs.current(CHAT), 0);
  assert.equal((await crashed.host.commit(commit())).epoch, 1);
  assert.equal(crashed.epochs.current(CHAT), 1);
  await assert.rejects(A.host.commit(commit({ targetHostId: 'C' })), code('target_mismatch'));
  // another preparation for a chat already handed over is refused with where it went
  await assert.rejects(
    A.host.commit(commit({ preparedId: 'prep-C-0009', expectedEpoch: 1 })),
    (e: any) => e.code === 'chat_released' && e.details.targetHostId === 'B',
  );
});

test('a running turn refuses the commit and changes nothing; a stale expected epoch is refused with the current one', async () => {
  const A = makeHost('A');
  A.state.busy = true;
  await assert.rejects(A.host.commit(commit()), code('turn_running'));
  assert.equal(A.owners.get(CHAT), null);
  assert.equal(A.epochs.current(CHAT), 0);
  A.state.busy = false;
  A.epochs.admit(CHAT, 3);
  await assert.rejects(A.host.commit(commit()), (e: any) => e instanceof StaleEpochError && e.current === 3);
  assert.equal(A.owners.get(CHAT), null);
});

test('A1/A3: while one commit settles, another for the chat is refused, the same one joins, writes wait, and a turn that starts meanwhile still refuses it', async () => {
  const A = makeHost('A');
  let release!: () => void;
  A.state.quiesce = new Promise<void>((r) => (release = r));
  const first = A.host.commit(commit());
  const joined = A.host.commit(commit());
  await assert.rejects(A.host.commit(commit({ preparedId: 'prep-C-0009', targetHostId: 'C' })), code('continue_in_flight'));
  assert.throws(() => A.host.gate(CHAT, 0), code('continue_in_flight'));
  // a turn began while the Host was settling: the commit looks again after the await
  A.state.busy = true;
  release();
  await assert.rejects(first, code('turn_running'));
  await assert.rejects(joined, code('turn_running'));
  assert.equal(A.owners.get(CHAT), null);
  // A4: the finished one no longer holds the slot
  A.state.busy = false;
  A.state.quiesce = null;
  assert.equal((await A.host.commit(commit())).epoch, 1);
});

test('A3: a commit that finds the same preparation committed while it settled returns that answer', async () => {
  const A = makeHost('A');
  let release!: () => void;
  A.state.quiesce = new Promise<void>((r) => (release = r));
  const pending = A.host.commit(commit());
  // another process of the same Host wrote the owner record meanwhile
  A.owners.put(CHAT, { state: 'released', epoch: 1, preparedId: 'prep-B-0001', targetHostId: 'B', cleaned: false, at: 1 });
  release();
  assert.deepEqual(await pending, { epoch: 1, targetHostId: 'B', preparedId: 'prep-B-0001', replayed: true });
});

test('a poisoned copy refuses to commit and to serve; a chat prepared here is activated by a commit at its epoch', async () => {
  const A = makeHost('A');
  await A.host.acceptHello([{ chatId: CHAT, epoch: 2, rev: 0, targetHostId: 'B' }]);
  await assert.rejects(A.host.commit(commit({ expectedEpoch: 2 })), (e: any) => e.code === 'chat_poisoned' && e.details.epoch === 2);
  assert.throws(() => A.host.gate(CHAT, 2), code('chat_poisoned'));
  // a target that becomes a source before anything else reached it
  const B = makeHost('B');
  await B.host.prepare(prep());
  const moved = await B.host.commit(commit({ expectedEpoch: 1, targetHostId: 'A', preparedId: 'prep-A-0001' }));
  assert.equal(moved.epoch, 2);
  assert.equal(B.log.served.length, 1);
});

test('a request that carries the prepared epoch makes the target the owner; an older one is not served', async () => {
  const B = makeHost('B');
  await B.host.prepare(prep());
  assert.throws(
    () => B.host.gate(CHAT, 0),
    (e: any) => e.code === 'not_serving' && e.details.epoch === 1,
  );
  B.host.touch(CHAT, 0);
  assert.equal(B.owners.get(CHAT)?.state, 'prepared');
  B.host.gate(CHAT, 1);
  assert.equal(B.owners.get(CHAT), null);
  assert.equal(B.epochs.current(CHAT), 1);
  assert.deepEqual(B.log.served, [{ chatId: CHAT, nativeId: 'B-native-1', harness: 'claude', cwd: '/work/b', epoch: 1 }]);
  // a chat nobody has a record for is served
  B.host.gate('claude:other', 0);
});

test('release: the target reclaims a preparation, the source finishes a hand-over once, anything else is a no-op', async () => {
  const B = makeHost('B');
  await B.host.prepare(prep());
  assert.deepEqual(await B.host.release({ chatId: CHAT, epoch: 1, preparedId: 'prep-B-0001' }), { released: 'reclaimed' });
  assert.deepEqual(B.log.discarded, ['B-native-1']);
  assert.equal(B.owners.get(CHAT), null);
  assert.deepEqual(await B.host.release({ chatId: CHAT, epoch: 1, preparedId: 'prep-B-0001' }), { released: 'noop' });

  const A = makeHost('A');
  A.state.running.add(CHAT);
  await A.host.commit(commit());
  assert.deepEqual(await A.host.release({ chatId: CHAT, epoch: 9, preparedId: 'prep-B-0001' }), { released: 'noop' });
  assert.deepEqual(await A.host.release({ chatId: CHAT, epoch: 1, preparedId: 'other-prepared' }), { released: 'noop' });
  assert.deepEqual(await A.host.release({ chatId: CHAT, epoch: 1, preparedId: 'prep-B-0001' }), { released: 'finalized' });
  assert.deepEqual(await A.host.release({ chatId: CHAT, epoch: 1, preparedId: 'prep-B-0001' }), { released: 'finalized' });
  assert.deepEqual(A.log.retired, [CHAT], 'the cleanup runs once');
  assert.equal(A.owners.get(CHAT)?.state, 'released');
  // a poisoned chat has nothing to release
  await A.host.acceptHello([{ chatId: 'claude:p', epoch: 1, rev: 0, targetHostId: 'B' }]);
  assert.deepEqual(await A.host.release({ chatId: 'claude:p', epoch: 1, preparedId: 'prep-B-0001' }), { released: 'noop' });
});

test('the returning old owner poisons itself from the hello; an older or equal claim does not; two owners at one epoch are reported (I2)', async () => {
  const A = makeHost('A');
  A.state.running.add(CHAT);
  A.epochs.admit('claude:old', 5);
  await A.host.commit(commit({ chatId: 'claude:same', preparedId: 'prep-B-0002' }));
  await A.host.commit(commit({ chatId: 'claude:other', preparedId: 'prep-B-0003' }));
  const hello = await A.host.acceptHello([
    { chatId: CHAT, epoch: 1, rev: 4, targetHostId: 'B' },
    { chatId: 'claude:old', epoch: 5, rev: 0, targetHostId: 'B' },
    { chatId: 'claude:same', epoch: 1, rev: 0, targetHostId: 'B' },
    { chatId: 'claude:other', epoch: 1, rev: 0, targetHostId: 'C' },
  ]);
  assert.deepEqual(hello, {
    poisoned: [{ chatId: CHAT, epoch: 1 }],
    conflicts: [{ chatId: 'claude:other', epoch: 1, targetHostId: 'B' }],
    agreed: [{ chatId: 'claude:same', epoch: 1 }],
  });
  assert.equal(A.epochs.current(CHAT), 1);
  assert.equal(A.owners.get(CHAT)?.state, 'poisoned');
  assert.equal(A.owners.get('claude:same')?.state, 'released');
  // a preparation here for a chat that moved on elsewhere is closed with it
  const B = makeHost('B');
  await B.host.prepare(prep());
  await B.host.acceptHello([{ chatId: CHAT, epoch: 1, rev: 0, targetHostId: 'C' }]);
  assert.deepEqual(B.log.discarded, ['B-native-1']);
});

test('sweep reclaims preparations that never became the owner in time, and only those', async () => {
  const B = makeHost('B', undefined, { ttlMs: 100 });
  await B.host.prepare(prep());
  await B.host.prepare(prep({ chatId: 'claude:c2', key: 'prep-key-0002' }));
  B.owners.put('claude:gone', { state: 'poisoned', epoch: 1, at: 0 });
  B.state.now += 100;
  assert.equal(await B.host.sweep(), 0, 'not yet past the limit');
  B.state.now += 1;
  assert.equal(await B.host.sweep(), 2);
  assert.deepEqual(B.log.discarded.sort(), ['B-native-1', 'B-native-2']);
  assert.equal(B.owners.get('claude:gone')?.state, 'poisoned');
  // A3: a preparation that became the owner while an older one was being closed is left alone
  const C = makeHost('C', undefined, { ttlMs: 100 });
  await C.host.prepare(prep());
  await C.host.prepare(prep({ chatId: 'claude:c2', key: 'prep-key-0002' }));
  C.state.now += 101;
  const discard = C.log.discarded;
  const original = discard.push.bind(discard);
  discard.push = (n: string) => (C.host.gate('claude:c2', 1), original(n));
  assert.equal(await C.host.sweep(), 1);
  assert.equal(C.owners.get('claude:c2'), null);
});

test('W3: an unreadable owner file falls back to its last good copy and says so; with no copy nothing is let through', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'owners.json');
  const problems: string[] = [];
  const store = createOwnerStore(file, { report: (p: string) => problems.push(p) });
  assert.deepEqual(store.entries(), []);
  store.put('__proto__', { state: 'poisoned', epoch: 2, at: 1 });
  store.put(CHAT, { state: 'poisoned', epoch: 3, at: 1 });
  store.remove('missing');
  store.remove('__proto__');
  fs.writeFileSync(file, '{ truncated');
  assert.equal(store.get(CHAT)?.epoch, 3);
  assert.equal(problems.length, 1);
  for (const bad of ['[]', '{"a":{"state":"nonsense","epoch":1}}', '{"a":{"state":"poisoned","epoch":-1}}', 'null']) {
    fs.writeFileSync(file, bad);
    assert.equal(store.get(CHAT)?.epoch, 3, bad);
  }
  // a file that cannot be read at all (here a folder in its place) is no better than a corrupt one
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.equal(store.get(CHAT)?.epoch, 3);
  fs.rmdirSync(file);
  fs.writeFileSync(file, '{ truncated');
  fs.writeFileSync(`${file}.bak`, 'nope');
  assert.throws(
    () => store.get(CHAT),
    (e: any) => e instanceof OwnerStoreError && e.code === 'owner_store_unreadable',
  );
  fs.rmSync(`${file}.bak`);
  assert.throws(() => store.get(CHAT), OwnerStoreError);
  // a store that was never written reads as empty
  assert.equal(createOwnerStore(path.join(dir, 'new', 'o.json'), quiet).get(CHAT), null);
  fs.rmSync(file, { force: true });
  assert.equal(createOwnerStore(file, quiet).get(CHAT), null);
});

test('a newer preparation is not replaced by an older one from a stale client', async () => {
  const B = makeHost('B');
  await B.host.prepare(prep({ epoch: 3 }));
  await assert.rejects(
    B.host.prepare(prep({ epoch: 2, key: 'prep-key-0002' })),
    (e: any) => e instanceof StaleEpochError && e.current === 3,
  );
  assert.equal(B.owners.get(CHAT)?.epoch, 3);
  assert.deepEqual(B.log.discarded, []);
  // the same epoch from another client is the same intended continue and replaces it
  assert.ok(await B.host.prepare(prep({ epoch: 3, key: 'prep-key-0003' })));
  assert.equal(B.log.discarded.length, 1);
});

test('a replaced preparation whose session will not close is reported, not fatal to the new one', async () => {
  const B = makeHost('B');
  await B.host.prepare(prep());
  B.state.failDiscard = true;
  const got = await B.host.prepare(prep({ key: 'prep-key-0002', epoch: 2 }));
  assert.equal(got.epoch, 2);
  assert.ok(B.problems.some((p) => /replaced preparation did not close/.test(p)));
});

test('the source cleanup is marked done only after it ran, and only for the same hand-over', async () => {
  const A = makeHost('A');
  A.state.running.add(CHAT);
  await A.host.commit(commit());
  const release = { chatId: CHAT, epoch: 1, preparedId: 'prep-B-0001' };
  A.state.failRetire = true;
  await assert.rejects(A.host.release(release), /would not close/);
  assert.equal((A.owners.get(CHAT) as any).cleaned, false, 'the next release runs it again');
  A.state.failRetire = false;
  assert.deepEqual(await A.host.release(release), { released: 'finalized' });
  assert.equal((A.owners.get(CHAT) as any).cleaned, true);
  // a hand-over replaced while the cleanup ran is not marked
  const C = makeHost('C');
  await C.host.commit(commit());
  const original = C.host;
  C.state.failRetire = false;
  const swapped = original.release(release);
  C.owners.put(CHAT, { state: 'poisoned', epoch: 5, at: 1 });
  await swapped;
  assert.equal(C.owners.get(CHAT)?.state, 'poisoned');
});

test('a session that will not close keeps its record: release reclaim fails loudly, sweep reports and tries again', async () => {
  const B = makeHost('B', undefined, { ttlMs: 100 });
  await B.host.prepare(prep());
  B.state.failDiscard = true;
  await assert.rejects(B.host.release({ chatId: CHAT, epoch: 1, preparedId: 'prep-B-0001' }), /would not close/);
  assert.equal(B.owners.get(CHAT)?.state, 'prepared');
  B.state.now += 101;
  assert.equal(await B.host.sweep(), 0);
  assert.ok(B.problems.some((p) => /expired preparation did not close/.test(p)));
  assert.equal(B.owners.get(CHAT)?.state, 'prepared');
  B.state.failDiscard = false;
  assert.equal(await B.host.sweep(), 1);
  // a record replaced while the discard failed is not put back over it
  const C = makeHost('C');
  await C.host.prepare(prep());
  C.state.failDiscard = true;
  const failing = C.host.release({ chatId: CHAT, epoch: 1, preparedId: 'prep-C-0001' });
  C.owners.put(CHAT, { state: 'poisoned', epoch: 7, at: 1 });
  await assert.rejects(failing, /would not close/);
  assert.equal(C.owners.get(CHAT)?.state, 'poisoned');
});

test('a poisoned chat is retired (its turn and subscribers stop); a failure to do so is reported and the hello goes on', async () => {
  const A = makeHost('A');
  A.state.running.add(CHAT);
  A.state.running.add('claude:c2');
  await A.host.acceptHello([{ chatId: CHAT, epoch: 1, rev: 0, targetHostId: 'B' }]);
  assert.deepEqual(A.log.retired, [CHAT]);
  A.state.failRetire = true;
  const reply = await A.host.acceptHello([{ chatId: 'claude:c2', epoch: 1, rev: 0, targetHostId: 'B' }]);
  assert.deepEqual(reply.poisoned, [{ chatId: 'claude:c2', epoch: 1 }]);
  assert.ok(A.problems.some((p) => /poisoned chat was not retired/.test(p)));
  // a voided preparation whose session will not close is reported too
  const B = makeHost('B');
  await B.host.prepare(prep());
  B.state.failDiscard = true;
  await B.host.acceptHello([{ chatId: CHAT, epoch: 1, rev: 0, targetHostId: 'C' }]);
  assert.ok(B.problems.some((p) => /voided preparation did not close/.test(p)));
});
