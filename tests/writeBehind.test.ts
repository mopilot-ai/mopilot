// electron/platform/writeBehind.cjs: derived state files written behind a change (coalesced, debounced, in change order, off the main thread), never torn by a crash, retried with a growing wait when they fail (and the owner told once), and written in full at quit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WriteBehind, REMOVE, IDLE_MS, MAX_MS, RETRY_CAP_MS, FAILURES_BEFORE_NOTICE } = require('../electron/platform/writeBehind.cjs');
const { writeAtomic, writeAtomicAsync } = require('../electron/platform/fsutil.cjs');
const { keepPrivate } = require('../electron/platform/privateFiles.cjs');
const { clearIgnored, noteIgnored, recentIgnored } = require('../electron/ignored.cjs');

function dir(t: any) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'write-behind-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A writer whose clock and timers the test turns by hand, with the real disk functions handed in. */
function manual(extra: Record<string, unknown> = {}) {
  const timers: { fn: () => void; ms: number; cleared: boolean; unref: () => void }[] = [];
  const told: [string, unknown][] = [];
  let clock = 0;
  let first = 0;
  const wb = new WriteBehind({
    writeAsync: writeAtomicAsync,
    writeSync: writeAtomic,
    remove: (file: string) => fs.rmSync(file, { force: true }),
    fs,
    note: noteIgnored,
    failed: (file: string, error: unknown) => told.push([file, error]),
    onFirstWrite: () => first++,
    now: () => clock,
    setTimer: (fn: () => void, ms: number) => {
      const timer = { fn, ms, cleared: false, unref: () => {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer: { cleared: boolean }) => {
      timer.cleared = true;
    },
    ...extra,
  });
  const fire = () => {
    const last = timers.filter((x) => !x.cleared).at(-1)!;
    last.cleared = true;
    last.fn();
  };
  return { wb, timers, told, fire, at: (ms: number) => (clock = ms), firstWrites: () => first };
}
const settle = () => new Promise((r) => setTimeout(r, 30));

test('changes to one file become one write of the latest content, about a second after the last change and no later than three seconds after the first', async (t) => {
  const f = path.join(dir(t), 'a.json');
  const { wb, timers, fire, at, firstWrites } = manual();
  let made = 0;
  at(0);
  wb.set(f, () => (made++, 'one'));
  at(900);
  wb.set(f, () => (made++, 'two'));
  at(2500);
  wb.set(f, () => (made++, 'three'));
  assert.deepEqual(
    timers.map((x) => x.ms),
    [IDLE_MS, IDLE_MS, MAX_MS - 2500],
  );
  assert.equal(firstWrites(), 1);
  assert.equal(fs.existsSync(f), false);
  assert.equal(wb.pending(f), true);
  fire();
  await settle();
  assert.equal(made, 1);
  assert.equal(fs.readFileSync(f, 'utf8'), 'three');
  assert.equal(wb.pending(f), false);
});

test('a change made while its file is being written is written after the usual wait', async (t) => {
  const f = path.join(dir(t), 'a.json');
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { wb, timers, fire } = manual({ writeAsync: (...a: unknown[]) => gate.then(() => (writeAtomicAsync as any)(...a)) });
  wb.set(f, () => 'first');
  fire();
  wb.set(f, () => 'second');
  const armed = timers.length;
  fire();
  assert.equal(timers.length, armed);
  release();
  await settle();
  assert.equal(fs.readFileSync(f, 'utf8'), 'first');
  fire();
  await wb.flush();
  assert.equal(fs.readFileSync(f, 'utf8'), 'second');
});

test('a write that stops before its rename leaves the last complete file and no temporary file', async (t) => {
  const d = dir(t);
  const f = path.join(d, 'a.json');
  fs.writeFileSync(f, '"old"');
  assert.equal(await writeAtomicAsync(f, '"new"', () => false), false);
  assert.equal(fs.readFileSync(f, 'utf8'), '"old"');
  assert.deepEqual(fs.readdirSync(d), ['a.json']);
});

test('a write that keeps failing is tried again after a growing wait up to a cap, the owner is told once, and a good write starts over', async (t) => {
  const f = path.join(dir(t), 'a.json');
  clearIgnored();
  let failing = true;
  const { wb, timers, told, fire } = manual({
    writeAsync: async (...a: unknown[]) => {
      if (failing) throw new Error('disk full');
      return (writeAtomicAsync as any)(...a);
    },
  });
  wb.set(f, () => '"x"');
  for (let i = 1; i <= FAILURES_BEFORE_NOTICE + 6; i++) {
    fire();
    await settle();
    assert.equal(timers.at(-1)!.ms, Math.min(MAX_MS * 2 ** (i - 1), RETRY_CAP_MS));
  }
  assert.equal(fs.existsSync(f), false);
  assert.ok(recentIgnored().some((e: any) => /save/.test(JSON.stringify(e))));
  // told once, when the fifth in a row failed
  assert.equal(told.length, 1);
  assert.equal(wb.pending(f), true);
  failing = false;
  fire();
  await settle();
  assert.equal(fs.readFileSync(f, 'utf8'), '"x"');
  // a later failure counts from the start, and is told again
  failing = true;
  wb.set(f, () => '"y"');
  for (let i = 0; i < FAILURES_BEFORE_NOTICE; i++) {
    fire();
    await settle();
  }
  assert.equal(told.length, 2);
  wb.cancel(f);
});

test('the quit flush writes in the order the files were changed, and a write already on its way cannot replace it with older bytes', async (t) => {
  const d = dir(t);
  const [a, b] = [path.join(d, 'a.json'), path.join(d, 'b.json')];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const order: string[] = [];
  const { wb, fire } = manual({
    writeAsync: (...a: unknown[]) => gate.then(() => (writeAtomicAsync as any)(...a)),
    writeSync: (file: string, data: string, fileFs: any, mode: number) => (
      order.push(path.basename(file)), writeAtomic(file, data, fileFs, mode)
    ),
  });
  wb.set(a, () => 'older');
  fire();
  wb.set(b, () => 'b');
  wb.set(a, () => 'newest');
  wb.set(b, () => 'b again');
  wb.flushSync();
  assert.deepEqual(order, ['a.json', 'b.json']);
  assert.equal(fs.readFileSync(a, 'utf8'), 'newest');
  release();
  await wb.flush();
  assert.equal(fs.readFileSync(a, 'utf8'), 'newest');
  // nothing pending: nothing written
  fs.rmSync(a);
  wb.flushSync();
  assert.equal(fs.existsSync(a), false);
});

test('a producer can skip a write or delete the file, and a producer that throws is told once and not tried again', (t) => {
  const d = dir(t);
  const f = path.join(d, 'a.json');
  const { wb, told, fire } = manual();
  const written: string[] = [];
  wb.set(
    f,
    () => 'x',
    () => written.push('x'),
  );
  wb.flushSync();
  wb.set(
    f,
    () => REMOVE,
    () => written.push('rm'),
  );
  fire();
  assert.equal(fs.existsSync(f), false);
  assert.deepEqual(written, ['x', 'rm']);
  wb.set(f, () => REMOVE);
  wb.flushSync();
  wb.set(
    f,
    () => null,
    () => written.push('never'),
  );
  fire();
  wb.set(
    f,
    () => null,
    () => written.push('never'),
  );
  wb.flushSync();
  assert.deepEqual(written, ['x', 'rm']);
  clearIgnored();
  const broken = () => {
    throw new Error('cannot serialize');
  };
  wb.set(f, broken);
  fire();
  assert.equal(wb.pending(f), false);
  assert.equal(told.length, 1);
  wb.set(f, broken);
  wb.flushSync();
  assert.equal(wb.pending(f), false);
  // told once for the file until a write works
  assert.equal(told.length, 1);
  assert.ok(recentIgnored().some((e: any) => /make/.test(JSON.stringify(e))));
  // an owner that fails to take the news is noted
  const thrower = manual({
    failed: () => {
      throw new Error('no window');
    },
  });
  thrower.wb.set(f, broken);
  thrower.fire();
  assert.ok(recentIgnored().some((e: any) => /tell that a file could not be saved/.test(JSON.stringify(e))));
});

test('a delete or a write that fails at quit is noted, kept pending and counted toward the notice', (t) => {
  const d = dir(t);
  const { wb, told, fire } = manual();
  const blocked = path.join(d, 'blocked');
  fs.mkdirSync(path.join(blocked, 'inner'), { recursive: true });
  clearIgnored();
  // a folder cannot be deleted as a file
  wb.set(blocked, () => REMOVE);
  fire();
  assert.equal(wb.pending(blocked), true);
  wb.set(blocked, () => 'data');
  for (let i = 0; i < FAILURES_BEFORE_NOTICE; i++) wb.flushSync();
  assert.equal(wb.pending(blocked), true);
  assert.equal(told.length, 1);
  assert.ok(recentIgnored().length >= 3);
  // a change cancelled before its write never reaches the disk, and cancelling twice is harmless
  const g = path.join(d, 'g.json');
  wb.set(g, () => 'gone');
  wb.cancel(g);
  wb.cancel(g);
  wb.flushSync();
  assert.equal(fs.existsSync(g), false);
  wb.cancel(blocked);
});

test("an async write keeps an existing file's mode, gives a new one the asked mode, and keeps the data folder owner-only", async (t) => {
  const d = dir(t);
  assert.equal(await writeAtomicAsync(path.join(d, 'deep', 'new.json'), 'a'), true);
  const asked = path.join(d, 'asked.json');
  await writeAtomicAsync(asked, 'a', () => true, 0o600);
  assert.equal(fs.statSync(asked).mode & 0o777, 0o600);
  const kept = path.join(d, 'kept.json');
  fs.writeFileSync(kept, 'old');
  fs.chmodSync(kept, 0o644);
  await writeAtomicAsync(kept, 'new', () => true, 0o600);
  assert.equal(fs.statSync(kept).mode & 0o777, 0o644);
  // under a folder kept private, a file and its folders are owner-only whatever they were
  const secret = path.join(d, 'secret');
  keepPrivate(secret);
  fs.mkdirSync(secret);
  fs.writeFileSync(path.join(secret, 'old.json'), 'old');
  fs.chmodSync(path.join(secret, 'old.json'), 0o644);
  await writeAtomicAsync(path.join(secret, 'old.json'), 'new');
  await writeAtomicAsync(path.join(secret, 'sub', 'fresh.json'), 'x');
  assert.equal(fs.statSync(path.join(secret, 'old.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(secret, 'sub', 'fresh.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(secret, 'sub')).mode & 0o777, 0o700);
});

test('an async write that cannot publish throws, and leaves no temporary file even when it cannot clean up', async (t) => {
  const d = dir(t);
  const blocked = path.join(d, 'blocked');
  fs.mkdirSync(blocked);
  await assert.rejects(writeAtomicAsync(blocked, 'x'));
  assert.deepEqual(fs.readdirSync(d), ['blocked']);
  clearIgnored();
  const rm = fs.rmSync;
  fs.rmSync = () => {
    throw new Error('locked');
  };
  try {
    await assert.rejects(writeAtomicAsync(blocked, 'x'));
  } finally {
    fs.rmSync = rm;
  }
  assert.ok(recentIgnored().some((e: any) => /temporary file/.test(JSON.stringify(e))));
});

test('a write that reaches the disk tells its owner', async (t) => {
  const f = path.join(dir(t), 'a.json');
  const { wb, fire } = manual();
  let told = 0;
  wb.set(
    f,
    () => 'x',
    () => told++,
  );
  fire();
  await settle();
  assert.equal(told, 1);
});

test('the app state it keeps: a normal exit writes what is pending, a kill leaves the last complete files, and the next start is consistent', (t) => {
  const d = dir(t);
  const chatsModule = JSON.stringify(path.resolve('electron/platform/chats.cjs'));
  const script = (end: string) =>
    `const { ChatsStore, patchPrefs } = require(${chatsModule});` +
    `const ui = ${JSON.stringify(path.join(d, 'ui-state.json'))};` +
    `const store = new ChatsStore(${JSON.stringify(path.join(d, 'threads'))}, { uiState: ui });` +
    `patchPrefs(ui, { first: true }); store.flush();` +
    `store.patchMeta('c', { pinned: true }); patchPrefs(ui, { second: true }); ${end}`;
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
  spawnSync(process.execPath, ['-e', script('')]);
  // an exit that ends the process normally writes everything
  assert.deepEqual(read('ui-state.json').prefs, { first: true, second: true });
  assert.deepEqual(read('ui-state.json').pinned, { c: true });
  fs.rmSync(path.join(d, 'ui-state.json'));
  fs.rmSync(path.join(d, 'threads'), { recursive: true });
  // a kill before the flush: the chat's record was on the disk when the change was acknowledged, the derived files are the last complete ones
  spawnSync(process.execPath, ['-e', script("process.kill(process.pid, 'SIGKILL')")]);
  assert.deepEqual(read('ui-state.json').prefs, { first: true });
  assert.equal(read('threads/c.v2').meta.pinned, true);
  const { ChatsStore, readUiState, flushPendingWrites } = require('../electron/platform/chats.cjs');
  // the next start sees the record; its first change makes the derived state again
  const store = new ChatsStore(path.join(d, 'threads'), { uiState: path.join(d, 'ui-state.json') });
  assert.equal(store.get('c').meta.pinned, true);
  store.patchMeta('c', { unread: true });
  flushPendingWrites();
  assert.deepEqual(readUiState(path.join(d, 'ui-state.json')).pinned, { c: true });
  assert.deepEqual(read('ui-state.json').pinned, { c: true });
});
