// Saved turn diffs, one file per chat: lazy reads, coalesced async writes, caps, eviction and the one-time migration (#2544).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, utimes, stat, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { TurnDiffStore, trimTurns, MAX_TURNS_PER_CHAT, MAX_BYTES_PER_CHAT, MAX_AGE_MS } = require('../electron/platform/turnDiffStore.cjs');
const { TurnChanges } = require('../electron/session/turnChanges.cjs');
const { savedTurnChanges } = require('../electron/session/turnSnapshots.cjs');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function scratch(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'turn-diff-store-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('writes coalesce into one async file per chat and read back, including before they land', async () => {
  await scratch(async (dir) => {
    const store = new TurnDiffStore(join(dir, 'd'));
    await store.ready;
    assert.equal(store.read('a'), null);
    const turns: Record<string, string> = { t1: 'one' };
    store.write('a', turns);
    turns.t2 = 'two';
    store.write('a', turns);
    store.write('b', { x: '' });
    assert.deepEqual(store.read('a'), { t1: 'one', t2: 'two' });
    await sleep(900);
    assert.equal((await readdir(join(dir, 'd'))).length, 2);
    const fresh = new TurnDiffStore(join(dir, 'd'));
    assert.deepEqual(fresh.read('a'), { t1: 'one', t2: 'two' });
    assert.deepEqual(fresh.read('b'), { x: '' });
    assert.equal(fresh.read('c'), null);
  });
});

test('a write during a write is picked up after it, and a failed write is ignored', async () => {
  await scratch(async (dir) => {
    const store = new TurnDiffStore(join(dir, 'd'));
    const turns: Record<string, string> = { t1: 'one' };
    store.write('a', turns);
    await sleep(320);
    turns.t2 = 'two';
    store.write('a', turns);
    await sleep(900);
    assert.deepEqual(new TurnDiffStore(join(dir, 'd')).read('a'), { t1: 'one', t2: 'two' });
    await writeFile(join(dir, 'file'), 'not a folder');
    const blocked = new TurnDiffStore(join(dir, 'file'));
    blocked.write('a', { t: 'x' });
    await sleep(500);
    assert.equal(blocked.read('a'), null);
    assert.equal(blocked.pending.size, 0);
  });
});

test('a file for another chat id or with bad content reads as nothing', async () => {
  await scratch(async (dir) => {
    const store = new TurnDiffStore(join(dir, 'd'));
    await mkdir(join(dir, 'd'), { recursive: true });
    await writeFile(store.fileOf('a'), JSON.stringify({ threadId: 'other', turns: { t: 'x' } }));
    assert.equal(store.read('a'), null);
    await writeFile(store.fileOf('a'), '{ torn');
    assert.equal(store.read('a'), null);
  });
});

test('flushSync writes what is waiting, and merges under a not yet migrated chat', async () => {
  await scratch(async (dir) => {
    const store = new TurnDiffStore(join(dir, 'd'));
    store.write('a', { t: 'x' });
    store.flushSync();
    assert.equal(store.pending.size, 0);
    assert.deepEqual(store.read('a'), { t: 'x' });
    const old = new TurnDiffStore(join(dir, 'e'), join(dir, 'missing.json'));
    await old.ready;
    old.migrated = false;
    await mkdir(join(dir, 'e'), { recursive: true });
    await writeFile(old.fileOf('a'), JSON.stringify({ threadId: 'a', turns: { old: 'o' } }));
    old.write('a', { fresh: 'f' });
    old.write('b', { fresh: 'f' });
    old.flushSync();
    assert.deepEqual(old.read('a'), { old: 'o', fresh: 'f' });
    assert.deepEqual(old.read('b'), { fresh: 'f' });
    await writeFile(join(dir, 'file'), 'x');
    const bad = new TurnDiffStore(join(dir, 'file'));
    bad.write('a', { t: 'x' });
    bad.flushSync();
    assert.equal(bad.read('a'), null);
  });
});

test('the oldest turns go past the turn and byte caps, the newest always stays', () => {
  const many: Record<string, string> = {};
  for (let i = 0; i < MAX_TURNS_PER_CHAT + 5; i++) many[`t${i}`] = 'x';
  const kept = trimTurns(many);
  assert.equal(Object.keys(kept).length, MAX_TURNS_PER_CHAT);
  assert.equal(kept.t4, undefined);
  assert.equal(kept.t5, 'x');
  const big = 'y'.repeat(MAX_BYTES_PER_CHAT / 2 + 1);
  assert.deepEqual(Object.keys(trimTurns({ a: big, b: big, c: big })), ['c']);
  assert.deepEqual(Object.keys(trimTurns({ a: 'z', b: big, c: 'z' })), ['a', 'b', 'c']);
  const huge = 'y'.repeat(MAX_BYTES_PER_CHAT + 1);
  assert.deepEqual(Object.keys(trimTurns({ a: 'z', b: huge })), ['b']);
  const small = { a: 'z' };
  assert.equal(trimTurns(small), small);
});

test('eviction drops chats untouched for months and the least recent past the folder size', async () => {
  await scratch(async (dir) => {
    const store = new TurnDiffStore(join(dir, 'd'));
    await store.ready;
    await mkdir(join(dir, 'd', 'sub'), { recursive: true });
    for (const id of ['old', 'new', 'mid']) await store.putFile(store.fileOf(id), JSON.stringify({ threadId: id, turns: {} }));
    const longAgo = new Date(Date.now() - MAX_AGE_MS - 60_000);
    await utimes(store.fileOf('old'), longAgo, longAgo);
    await store.evict();
    assert.equal(existsSync(store.fileOf('old')), false);
    assert.equal(existsSync(store.fileOf('new')), true);
    assert.equal(existsSync(join(dir, 'd', 'sub')), true);
    // files past their age go whatever the size
    const later = Date.now() + 100 * 24 * 3600 * 1000;
    await store.evict(later);
    assert.equal(existsSync(store.fileOf('new')), false);
    await new TurnDiffStore(join(dir, 'gone')).evict();
  });
});

test('a folder over the size cap loses its least recently written files', async () => {
  await scratch(async (dir) => {
    const store = new TurnDiffStore(join(dir, 'd'));
    await store.ready;
    const { MAX_TOTAL_BYTES } = require('../electron/platform/turnDiffStore.cjs');
    for (const [id, age] of [
      ['recent', 1000],
      ['older', 9000],
    ] as const) {
      await store.putFile(store.fileOf(id), JSON.stringify({ threadId: id, turns: { t: 'q'.repeat(10) } }));
      const when = new Date(Date.now() - age);
      await utimes(store.fileOf(id), when, when);
    }
    const realStat = (await stat(store.fileOf('recent'))).size;
    assert.ok(MAX_TOTAL_BYTES > realStat * 2);
    // pad the older file past the cap using a sparse file so no real space is used
    const { truncate } = await import('node:fs/promises');
    await truncate(store.fileOf('older'), MAX_TOTAL_BYTES);
    const when = new Date(Date.now() - 9000);
    await utimes(store.fileOf('older'), when, when);
    await store.evict();
    assert.equal(existsSync(store.fileOf('recent')), true);
    assert.equal(existsSync(store.fileOf('older')), false);
  });
});

function legacy(count: number, size: number) {
  const all: Record<string, Record<string, string>> = {};
  for (let c = 0; c < count; c++) all[`chat-${c}`] = { t1: 'x'.repeat(size), t2: '', 'q"uo}te{': 'a\\"}{b' };
  return all;
}

test('the old whole-store file migrates into per-chat files without blocking, then is removed', async () => {
  await scratch(async (dir) => {
    const old = join(dir, 'codex-turn-diffs.json');
    const all: Record<string, any> = legacy(40, 200_000);
    all['we"ird\\id'] = { t: 'w' };
    all.bad = { t: 5 };
    await writeFile(old, JSON.stringify(all));
    const store = new TurnDiffStore(join(dir, 'turn-diffs'), old);
    // the event loop keeps turning while the file is scanned
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    await store.ready;
    clearInterval(timer);
    assert.ok(ticks > 0);
    assert.equal(existsSync(old), false);
    assert.deepEqual(store.read('chat-7'), all['chat-7']);
    assert.deepEqual(store.read('we"ird\\id'), { t: 'w' });
    assert.deepEqual(store.read('bad'), {});
  });
});

test('a migration cut short (a crash between writes) leaves the old file, and the next start finishes it without clobbering newer files', async () => {
  await scratch(async (dir) => {
    const old = join(dir, 'codex-turn-diffs.json');
    await writeFile(old, JSON.stringify({ a: { t: 'old a' }, b: { t: 'old b' } }));
    const first = new TurnDiffStore(join(dir, 'turn-diffs'));
    await first.ready;
    // the first run got as far as a newer file for chat a, then died before removing the old file
    await first.putFile(first.fileOf('a'), JSON.stringify({ threadId: 'a', turns: { t: 'new a' } }));
    const second = new TurnDiffStore(join(dir, 'turn-diffs'), old);
    await second.ready;
    assert.deepEqual(second.read('a'), { t: 'new a' });
    assert.deepEqual(second.read('b'), { t: 'old b' });
    assert.equal(existsSync(old), false);
  });
});

test('a truncated or foreign old file is set aside so later starts are not slowed by it', async () => {
  for (const [text, label] of [
    ['{"a":{"t":"x"},"b":{"t":', 'cut inside a value'],
    ['{"a":{"t":"x"},"b"', 'cut after a key'],
    ['{"a":{"t":"x"},"b":"s"}', 'a value that is not an object'],
    ['[1,2]', 'not an object'],
    ['', 'empty'],
    ['{"a":{"t":"x"', 'unclosed'],
    ['{"a":{"t":"x"}} trailing', 'trailing text'],
  ]) {
    await scratch(async (dir) => {
      const old = join(dir, 'codex-turn-diffs.json');
      await writeFile(old, text);
      const store = new TurnDiffStore(join(dir, 'turn-diffs'), old);
      await store.ready;
      assert.equal(existsSync(old), false, label);
      assert.equal(existsSync(`${old}.corrupt`), true, label);
    });
  }
  await scratch(async (dir) => {
    const old = join(dir, 'codex-turn-diffs.json');
    await writeFile(old, '{}');
    await new TurnDiffStore(join(dir, 'turn-diffs'), old).ready;
    assert.equal(existsSync(old), false);
  });
});

test('a chat written before the migration finished keeps both its old and its new turns', async () => {
  await scratch(async (dir) => {
    const old = join(dir, 'codex-turn-diffs.json');
    await writeFile(old, JSON.stringify({ a: { old: 'o' } }));
    const changes = savedTurnChanges(dir);
    // asked and written while the old file is still being read
    assert.equal(changes.saved('a', 'old'), undefined);
    changes.store.write('a', { fresh: 'f' });
    changes.store.write('z', { n: '1' });
    assert.equal(changes.saved('a', 'fresh'), 'f');
    await changes.store.ready;
    await sleep(900);
    // the same instance, which was asked before the migration reached the chat, sees the migrated turns
    assert.equal(changes.saved('a', 'old'), 'o');
    assert.equal(changes.saved('a', 'fresh'), 'f');
    assert.equal(changes.restore('a', [{ id: 'old' }])[0].diff, 'o');
    const after = savedTurnChanges(dir);
    assert.equal(after.saved('a', 'old'), 'o');
    assert.equal(after.saved('a', 'fresh'), 'f');
    assert.equal(after.saved('z', 'n'), '1');
    assert.ok((await stat(join(dir, 'turn-diffs'))).isDirectory());
  });
});

test('concurrent turns of one chat and of many chats all land, and only the chat that finished is written', async () => {
  await scratch(async (dir) => {
    let n = 0;
    const store = new TurnDiffStore(join(dir, 'd'));
    const changes = new TurnChanges(
      async () => 'tree',
      async () => `diff ${++n}`,
      store,
      (cwd: string) => cwd,
    );
    await Promise.all([changes.begin('chat', '/a'), changes.begin('other', '/b')]);
    await Promise.all([changes.finish('chat', 't1'), changes.finish('other', 'o1')]);
    await changes.begin('chat', '/a');
    await changes.finish('chat', 't2');
    await sleep(900);
    const fresh = new TurnChanges(undefined, undefined, new TurnDiffStore(join(dir, 'd')), (cwd: string) => cwd);
    assert.equal(fresh.saved('chat', 't1')?.startsWith('diff'), true);
    assert.equal(fresh.saved('chat', 't2')?.startsWith('diff'), true);
    assert.equal(fresh.saved('other', 'o1')?.startsWith('diff'), true);
    assert.equal(fresh.saved('nobody', 't'), undefined);
    const before = (await readFile(store.fileOf('other'), 'utf8')).length;
    await changes.begin('chat', '/a');
    await changes.finish('chat', 't3');
    await sleep(900);
    assert.equal((await readFile(store.fileOf('other'), 'utf8')).length, before);
  });
});

test('only the most recently used chats stay in memory when there is a store', async () => {
  await scratch(async (dir) => {
    const store = new TurnDiffStore(join(dir, 'd'));
    const changes = new TurnChanges(undefined, undefined, store, (cwd: string) => cwd);
    for (let i = 0; i < 12; i++) store.write(`c${i}`, { t: `v${i}` });
    store.flushSync();
    for (let i = 0; i < 12; i++) assert.equal(changes.saved(`c${i}`, 't'), `v${i}`);
    assert.equal(changes.diffs.size, 8);
    assert.equal(changes.saved('c0', 't'), 'v0');
    const unbounded = new TurnChanges(undefined, undefined, null, (cwd: string) => cwd);
    for (let i = 0; i < 12; i++) unbounded.turnsOf(`c${i}`, true);
    assert.equal(unbounded.diffs.size, 12);
  });
});

test('a write that arrives while the chat is being written is written after it', async () => {
  await scratch(async (dir) => {
    const store = new TurnDiffStore(join(dir, 'd'));
    const real = store.putFile.bind(store);
    store.putFile = async (file: string, text: string) => {
      await sleep(400);
      return real(file, text);
    };
    const turns: Record<string, string> = { t1: 'one' };
    store.write('a', turns);
    await sleep(500);
    turns.t2 = 'two';
    store.write('a', turns);
    await sleep(1500);
    assert.deepEqual(new TurnDiffStore(join(dir, 'd')).read('a'), { t1: 'one', t2: 'two' });
    assert.equal(store.pending.size, 0);
  });
});

test('a write that fails at the rename leaves no temporary file and is dropped', async () => {
  await scratch(async (dir) => {
    const store = new TurnDiffStore(join(dir, 'd'));
    await mkdir(store.fileOf('a'), { recursive: true });
    store.write('a', { t: 'x' });
    await sleep(600);
    assert.equal(store.pending.size, 0);
    assert.deepEqual(
      (await readdir(join(dir, 'd'))).filter((n) => n.endsWith('.tmp')),
      [],
    );
  });
});

test('a member of the old file that is not valid JSON is skipped, the others migrate', async () => {
  await scratch(async (dir) => {
    const old = join(dir, 'codex-turn-diffs.json');
    await writeFile(old, '{"bad":{"t":"\\q"},"ok":{"t":"y"}}');
    const store = new TurnDiffStore(join(dir, 'turn-diffs'), old);
    await store.ready;
    assert.deepEqual(store.read('ok'), { t: 'y' });
    assert.equal(store.read('bad'), null);
    assert.equal(existsSync(old), false);
  });
});

test('a chat that cannot be written keeps the old file for the next start', async () => {
  await scratch(async (dir) => {
    const old = join(dir, 'codex-turn-diffs.json');
    await writeFile(old, '{"a":{"t":"x"},"b":{"t":"y"}}');
    const store = new TurnDiffStore(join(dir, 'turn-diffs'));
    await store.ready;
    await mkdir(store.fileOf('a'), { recursive: true });
    const retry = new TurnDiffStore(join(dir, 'turn-diffs'), old);
    await retry.ready;
    assert.equal(existsSync(old), true);
    assert.deepEqual(retry.read('b'), { t: 'y' });
  });
});

test('turns saved at quit before the migration reached a chat are merged with the old ones on the next start', async () => {
  await scratch(async (dir) => {
    const old = join(dir, 'codex-turn-diffs.json');
    await writeFile(old, '{"a":{"old":"o"}}');
    const first = new TurnDiffStore(join(dir, 'turn-diffs'));
    first.migrated = false;
    first.write('a', { fresh: 'f' });
    first.flushSync();
    const second = new TurnDiffStore(join(dir, 'turn-diffs'), old);
    await second.ready;
    assert.deepEqual(second.read('a'), { old: 'o', fresh: 'f' });
  });
});

test('an old file that cannot be removed does not stop the store from starting', async () => {
  await scratch(async (dir) => {
    await mkdir(join(dir, 'ro'));
    const old = join(dir, 'ro', 'codex-turn-diffs.json');
    await writeFile(old, '{}');
    await chmod(join(dir, 'ro'), 0o555);
    try {
      const store = new TurnDiffStore(join(dir, 'turn-diffs'), old);
      await store.ready;
      assert.equal(store.migrated, true);
    } finally {
      await chmod(join(dir, 'ro'), 0o755);
    }
  });
});

test('flush writes what the store holds, and is a no-op without a store or without flushSync', async () => {
  await scratch(async (dir) => {
    const store = new TurnDiffStore(join(dir, 'd'));
    const changes = new TurnChanges(undefined, undefined, store, (cwd: string) => cwd);
    store.write('a', { t: 'x' });
    changes.flush();
    assert.equal(store.pending.size, 0);
    assert.deepEqual(new TurnDiffStore(join(dir, 'd')).read('a'), { t: 'x' });
    new TurnChanges(undefined, undefined, { read: () => null, write() {} }, (cwd: string) => cwd).flush();
    new TurnChanges(undefined, undefined, null, (cwd: string) => cwd).flush();
  });
});

test('the synchronous encoding of a save runs under the given label', async () => {
  await scratch(async (dir) => {
    const labels: string[] = [];
    const store = new TurnDiffStore(join(dir, 'd'), undefined, undefined, (label: string, fn: () => unknown) => (labels.push(label), fn()));
    store.write('a', { t: 'x' });
    await sleep(500);
    store.write('b', { t: 'y' });
    store.flushSync();
    assert.deepEqual(labels, ['turnDiffs.write', 'turnDiffs.write']);
  });
});
