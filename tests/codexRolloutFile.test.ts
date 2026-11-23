// electron/harness/codexRollout.cjs: main finds a Codex thread's rollout file under CODEX_HOME (by the path the
// app-server last gave, its date folder, the archive, or a walk), has the core read it plain or zstd-compressed, and pages
// its turns. What a line reads as is the core's: core/crates/rollout, whose tests hold it to the JS parser it replaced.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCodexRollouts, codexRollouts, setThreadHomes } = require('../electron/harness/codexRollout.cjs');

// a UUIDv7 thread id: its first 48 bits are when it was made
const at = new Date(2026, 9, 21, 12, 0, 0);
const idAt = (d: Date, tail = '7000-8000-000000000001') => {
  const hex = d.getTime().toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${tail}`;
};
const ID = idAt(at);
const pad = (n: number) => String(n).padStart(2, '0');
const dayDir = (home: string, d: Date) => path.join(home, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));

/** A rollout with `n` turns, each a user message, in the folder `cwd`. */
function rolloutText(n: number, cwd = '/work') {
  const out = [{ type: 'session_meta', payload: { id: ID, cwd } }];
  for (let i = 0; i < n; i++) {
    const turn = `t${i}`;
    out.push({ type: 'event_msg', payload: { type: 'task_started', turn_id: turn, started_at: i } } as any);
    out.push({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        turn_id: turn,
        item: { type: 'UserMessage', id: `u${i}`, content: [{ type: 'text', text: `m${i}` }] },
      },
    } as any);
    out.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, completed_at: i + 1, duration_ms: 1000 } } as any);
  }
  return `${out.map((r) => JSON.stringify(r)).join('\r\n')}\n`;
}

let home: string;
let reader: ReturnType<typeof createCodexRollouts>;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rollouts-'));
  reader = createCodexRollouts({ codexHome: () => home });
});
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};

test('a thread names its rollout file, inode, size and time: an append and a rewrite change it, and no rollout or no home has none (#5379)', async () => {
  const file = write(path.join(dayDir(home, at), `rollout-2026-10-21T12-00-00-${ID}.jsonl`), rolloutText(3));
  const first = await reader.stamp(ID);
  assert.match(first as string, new RegExp(`${ID}\\.jsonl:\\d+:\\d+:[\\d.]+$`));
  assert.equal(await reader.stamp(ID), first, 'nothing changed: the same stamp');
  fs.appendFileSync(file, `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'x', started_at: 9 } })}\n`);
  const appended = await reader.stamp(ID);
  assert.notEqual(appended, first, 'an append: a turn, a compaction, a rollback');
  fs.writeFileSync(file, rolloutText(1));
  assert.notEqual(await reader.stamp(ID), appended, 'a file written shorter');
  assert.equal(await reader.stamp(idAt(new Date(2026, 9, 22), '7000-8000-000000000002')), null, 'a thread with no rollout');
  assert.equal(await reader.stamp(''), null);
  assert.equal(await createCodexRollouts({ codexHome: () => '' }).stamp(ID), null, 'no CODEX_HOME is known yet');
  // a file found and gone for the stat
  const realStat = fs.promises.stat;
  (fs.promises as any).stat = async () => {
    throw Object.assign(new Error('gone'), { code: 'ENOENT' });
  };
  try {
    assert.equal(await reader.stamp(ID), null);
  } finally {
    (fs.promises as any).stat = realStat;
  }
});

/** Once `done` holds: for what the core answers on its own threads, with the clock mocked. */
async function until(done: () => boolean) {
  while (!done()) await new Promise((resolve) => setImmediate(resolve));
}

/** The real core's calls, listed; `shortPages` answers a page with one turn, as a reply of large turns stops short. */
function recording({ shortPages = false, failClose = false, beforePage = async () => undefined as void } = {}) {
  const { core } = require('../electron/platform/core.cjs');
  const made: [string, string][] = [];
  const open = new Set<number>();
  return {
    routes: (route: string) => made.filter(([r]) => r === route).map(([, payload]) => payload),
    opened: () => [...open],
    live: () => open.size,
    async call(route: string, payload: string) {
      made.push([route, payload]);
      if (route === 'rollout.close' && failClose) throw new Error('closing failed');
      if (route === 'rollout.page') await beforePage();
      const ask = shortPages && route === 'rollout.page' ? payload.replace(/ (\d+) \d+$/, (_m, at) => ` ${at} ${Number(at) + 1}`) : payload;
      const reply = JSON.parse(String(await core().dispatch(route, Buffer.from(ask))));
      if (route === 'rollout.open') open.add(reply.id);
      if (route === 'rollout.close') open.delete(Number(payload));
      return reply;
    },
  };
}

test("a thread's rollout in its date folder: its latest turns, oldest first, then the page before them", async () => {
  const file = write(path.join(dayDir(home, at), `rollout-2026-10-21T12-00-00-${ID}.jsonl`), rolloutText(5));
  // another thread's rollout in the same folder is never it
  write(path.join(dayDir(home, at), `rollout-2026-10-21T12-00-00-${idAt(at, '7000-8000-000000000002')}.jsonl`), rolloutText(1, '/other'));
  const page = await reader.history(ID, { limit: 2 });
  assert.equal(page.path, file);
  assert.equal(page.cwd, '/work');
  assert.deepEqual(
    page.turns.map((t: { id: string }) => t.id),
    ['t3', 't4'],
  );
  assert.equal(page.nextCursor, 'rollout:3');
  const older = await reader.history(ID, { limit: 2, cursor: page.nextCursor });
  assert.deepEqual(
    older.turns.map((t: { id: string }) => t.id),
    ['t1', 't2'],
  );
  const oldest = await reader.history(ID, { limit: 2, cursor: older.nextCursor });
  assert.deepEqual(
    oldest.turns.map((t: { id: string }) => t.id),
    ['t0'],
  );
  assert.equal(oldest.nextCursor, null);
  // without a limit, every turn; a cursor that isn't one reads from the end
  assert.equal((await reader.history(ID)).turns.length, 5);
  assert.equal((await reader.history(ID, { cursor: 'nonsense', limit: 1 })).turns[0].id, 't4');
  assert.equal((await reader.history(ID, { cursor: 'rollout:99', limit: 1 })).turns[0].id, 't4');
});

test('the date folder either side of the id (a session made near midnight), and the file kept for the next read', async () => {
  const next = new Date(at.getTime() + 86_400_000);
  const file = write(path.join(dayDir(home, next), `rollout-x-${ID}.jsonl`), rolloutText(1));
  assert.equal((await reader.history(ID)).path, file);
  // found once: the next read goes straight to it, even when the folders are gone from where it was found
  const moved = write(path.join(home, 'elsewhere', 'sessions', `rollout-x-${ID}.jsonl`), rolloutText(2));
  fs.rmSync(path.join(home, 'sessions'), { recursive: true });
  assert.equal(await reader.history(ID), null);
  // where the app-server last said it is
  assert.equal((await reader.history(ID, { hint: moved })).turns.length, 2);
});

test("the app-server's path for it, or that path compressed since; never a file of another name", async () => {
  const plain = path.join(home, 'custom', `rollout-a-${ID}.jsonl`);
  const zst = write(`${plain}.zst`, zlib.zstdCompressSync(Buffer.from(rolloutText(3))) as any);
  const page = await reader.history(ID, { hint: plain });
  assert.equal(page.path, zst);
  assert.equal(page.turns.length, 3);
  const fresh = createCodexRollouts({ codexHome: () => home });
  const other = write(path.join(home, 'custom', 'notes.jsonl'), rolloutText(1));
  assert.equal(await fresh.history(ID, { hint: other }), null);
  assert.equal(await fresh.history(ID, { hint: path.join(home, 'custom', `rollout-a-${ID}.jsonl.missing`) }), null);
});

test('an archived rollout, then any folder under sessions (newest first), compressed or not', async () => {
  const archived = write(
    path.join(home, 'archived_sessions', `rollout-b-${ID}.jsonl.zst`),
    zlib.zstdCompressSync(Buffer.from(rolloutText(1))) as any,
  );
  assert.equal((await reader.history(ID)).path, archived);
  fs.rmSync(archived);
  const odd = createCodexRollouts({ codexHome: () => home });
  write(path.join(home, 'sessions', '2025', '01', '01', 'unrelated.txt'), 'x');
  const deep = write(path.join(home, 'sessions', '2025', '02', '03', `rollout-c-${ID}.jsonl`), rolloutText(2));
  assert.equal((await odd.history(ID)).path, deep);
});

test('no rollout, no id, or an id that is not a UUIDv7: nothing to read', async () => {
  assert.equal(await reader.history(ID), null);
  // folders to walk, none of them holding it
  write(path.join(home, 'sessions', '2024', '05', '06', `rollout-z-${idAt(at, '7000-8000-00000000000f')}.jsonl`), rolloutText(1));
  assert.equal(await reader.history(ID), null);
  assert.equal(await reader.history(''), null);
  assert.equal(await reader.history(undefined as any), null);
  write(path.join(home, 'sessions', '2026', '01', '01', 'rollout-d-not-a-uuid.jsonl'), rolloutText(1));
  assert.equal((await reader.history('not-a-uuid')).turns.length, 1);
});

test('a file read once is parsed once until it changes', async () => {
  const file = write(path.join(dayDir(home, at), `rollout-e-${ID}.jsonl`), rolloutText(1, '/work'));
  const when = new Date(2026, 0, 1);
  fs.utimesSync(file, when, when);
  assert.equal((await reader.history(ID)).cwd, '/work');
  // the same size and time: the parse already made stands
  fs.writeFileSync(file, rolloutText(1, '/wrk2'));
  fs.utimesSync(file, when, when);
  assert.equal((await reader.history(ID)).cwd, '/work');
  fs.writeFileSync(file, rolloutText(4));
  assert.equal((await reader.history(ID)).turns.length, 4);
});

test('a parse is let go a minute after it was made, and a thread with no file is looked for again a minute later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timed = createCodexRollouts({ codexHome: () => home });
  assert.equal(await timed.history(ID), null);
  const file = write(path.join(dayDir(home, at), `rollout-i-${ID}.jsonl`), rolloutText(1, '/work'));
  // not looked for again yet, unless the app-server says where it is
  assert.equal(await timed.history(ID), null);
  assert.equal((await timed.history(ID, { hint: file })).cwd, '/work');
  const other = idAt(at, '7000-8000-0000000000bb');
  assert.equal(await timed.history(other), null);
  // looked for again with no hint before the minute is out: still not walked for
  assert.equal(await timed.history(other), null);
  t.mock.timers.tick(60_000);
  write(path.join(dayDir(home, at), `rollout-j-${other}.jsonl`), rolloutText(1));
  assert.equal((await timed.history(other)).turns.length, 1);
  // the same size and time: the kept parse stands until it is let go
  const when = new Date(2026, 0, 1);
  fs.utimesSync(file, when, when);
  await timed.history(ID);
  fs.writeFileSync(file, rolloutText(1, '/wrk2'));
  fs.utimesSync(file, when, when);
  assert.equal((await timed.history(ID)).cwd, '/work');
  t.mock.timers.tick(60_000);
  assert.equal((await timed.history(ID)).cwd, '/wrk2');
});

test('a compressed file that is not zstd fails the read', async () => {
  write(path.join(dayDir(home, at), `rollout-f-${ID}.jsonl.zst`), 'not zstd');
  await assert.rejects(reader.history(ID));
});

test('a read that fails partway, or of a file gone since it was found, rejects', async () => {
  const file = write(path.join(dayDir(home, at), `rollout-k-${ID}.jsonl.zst`), zlib.zstdCompressSync(Buffer.from(rolloutText(50))) as any);
  const good = fs.readFileSync(file);
  good[good.length >> 1] ^= 0xff;
  fs.writeFileSync(file, good);
  await assert.rejects(reader.history(ID));
  const calls = recording();
  const gone = createCodexRollouts({
    codexHome: () => home,
    call: (route: string, payload: string) => (fs.rmSync(file, { force: true }), calls.call(route, payload)),
  });
  await assert.rejects(gone.history(ID, { hint: file }));
});

test('without the core a rollout is not read', async () => {
  write(path.join(dayDir(home, at), `rollout-m-${ID}.jsonl`), rolloutText(1));
  const script = `
    const { createCodexRollouts } = require(${JSON.stringify(path.resolve('electron/harness/codexRollout.cjs'))});
    createCodexRollouts({ codexHome: () => ${JSON.stringify(home)} }).history(${JSON.stringify(ID)}).then(
      () => process.exit(1),
      (error) => process.exit(/Rust core/.test(error.message) ? 0 : 2),
    );`;
  const missing = path.join(home, 'no-core.node');
  assert.equal(spawnSync(process.execPath, ['-e', script], { env: { ...process.env, MOPILOT_CORE: missing } }).status, 0);
});

test('the turns come from the core a page at a time, and the JS asks on when a reply stops short', async () => {
  write(path.join(dayDir(home, at), `rollout-l-${ID}.jsonl`), rolloutText(5));
  const calls = recording({ shortPages: true });
  const shorted = createCodexRollouts({ codexHome: () => home, call: calls.call });
  assert.deepEqual(
    (await shorted.history(ID)).turns.map((t: { id: string }) => t.id),
    ['t0', 't1', 't2', 't3', 't4'],
  );
  assert.equal(calls.routes('rollout.page').length, 5);
  // a limit past the turns, one that isn't whole, and a cursor at the start: pages the JS would have sliced the same
  assert.deepEqual(
    (await shorted.history(ID, { limit: 2.5 })).turns.map((t: { id: string }) => t.id),
    ['t2', 't3', 't4'],
  );
  assert.equal((await shorted.history(ID, { limit: 2.5 })).nextCursor, 'rollout:2.5');
  assert.deepEqual((await shorted.history(ID, { limit: -1 })).turns, []);
  assert.deepEqual((await shorted.history(ID, { cursor: 'rollout:0', limit: 3 })).turns, []);
  assert.equal(calls.routes('rollout.open').length, 1, 'parsed once');
});

test('what the core holds goes when a parse is replaced or let go, never under a read that is paging it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  write(path.join(dayDir(home, at), `rollout-n-${ID}.jsonl`), rolloutText(2));
  const otherId = idAt(at, '7000-8000-0000000000cc');
  write(path.join(dayDir(home, at), `rollout-n-${otherId}.jsonl`), rolloutText(3));
  const calls = recording();
  const timed = createCodexRollouts({ codexHome: () => home, call: calls.call });
  await timed.history(ID);
  assert.deepEqual(calls.routes('rollout.close'), []);
  // the other thread's parse takes its place, and this one's goes
  const opened = calls.opened();
  await timed.history(otherId);
  await Promise.resolve();
  assert.deepEqual(calls.routes('rollout.close'), [String(opened[0])]);
  t.mock.timers.tick(60_000);
  await until(() => calls.live() === 0);

  // two reads at once of two files: each page is read before its parse goes
  const pages = await Promise.all([timed.history(ID), timed.history(otherId), timed.history(ID)]);
  assert.deepEqual(
    pages.map((page) => page.turns.length),
    [2, 3, 2],
  );
  t.mock.timers.tick(60_000);
  await until(() => calls.live() === 0);
});

test('a parse let go while a page is on its way stays until the page is out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  write(path.join(dayDir(home, at), `rollout-p-${ID}.jsonl`), rolloutText(2));
  let letPageOut = () => undefined as void;
  const held = new Promise<void>((resolve) => (letPageOut = resolve));
  const calls = recording({ beforePage: () => held });
  const timed = createCodexRollouts({ codexHome: () => home, call: calls.call });
  const reading = timed.history(ID);
  await until(() => calls.routes('rollout.page').length === 1);
  t.mock.timers.tick(60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.routes('rollout.close'), []);
  letPageOut();
  assert.equal((await reading).turns.length, 2);
  await until(() => calls.live() === 0);
});

test('a parse that cannot be closed is only noted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  write(path.join(dayDir(home, at), `rollout-o-${ID}.jsonl`), rolloutText(1));
  const calls = recording({ failClose: true });
  const timed = createCodexRollouts({ codexHome: () => home, call: calls.call });
  assert.equal((await timed.history(ID)).turns.length, 1);
  t.mock.timers.tick(60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.routes('rollout.close').length, 1);
  // nothing kept: read again, parsed again
  assert.equal((await timed.history(ID)).turns.length, 1);
  assert.equal(calls.routes('rollout.open').length, 2);
});

test('the reader main shares uses the CODEX_HOME Codex runs with, else ~/.codex, read on each call', async () => {
  setThreadHomes(() => null);
  const shared = codexRollouts();
  assert.equal(codexRollouts(), shared);
  const was = { CODEX_HOME: process.env.CODEX_HOME, HOME: process.env.HOME };
  try {
    process.env.CODEX_HOME = home;
    const file = write(path.join(dayDir(home, at), `rollout-g-${ID}.jsonl`), rolloutText(2));
    assert.equal((await shared.history(ID)).path, file);
    // no CODEX_HOME: the home folder's .codex
    delete process.env.CODEX_HOME;
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rollouts-home-'));
    process.env.HOME = other;
    const id = idAt(at, '7000-8000-0000000000aa');
    const there = write(path.join(dayDir(path.join(other, '.codex'), at), `rollout-h-${id}.jsonl`), rolloutText(1));
    assert.equal((await shared.history(id)).path, there);
  } finally {
    setThreadHomes(null);
    for (const [k, v] of Object.entries(was))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});

test('#2139 fail closed: before the thread-home lookup is wired no home is known, so nothing is read, not even from the user’s', async () => {
  setThreadHomes(null);
  const was = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = home;
    write(path.join(dayDir(home, at), `rollout-u-${ID}.jsonl`), rolloutText(1));
    assert.equal(await codexRollouts().history(ID), null);
    // once it is wired, the same thread reads
    setThreadHomes(() => null);
    assert.equal((await codexRollouts().history(ID)).cwd, '/work');
  } finally {
    setThreadHomes(null);
    if (was === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = was;
  }
});
