// What managed worktrees cost and which may go (electron/platform/worktreeStorage.cjs): sizes by walking, a worktree in use
// by a chat that is not archived, uncommitted changes, and the checks made again right before a removal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createWorktreeStorage, dirSize, mapLimit } = require('../electron/platform/worktreeStorage.cjs');

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-storage-')));
const wtDir = (name: string) => {
  const p = path.join(base, name, 'repo');
  fs.mkdirSync(p, { recursive: true });
  return p;
};

test('mapLimit keeps the order of the results and runs no more than the limit at once', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([30, 5, 20, 1, 10], 2, async (ms: number) => {
    peak = Math.max(peak, ++running);
    await new Promise((resolve) => setTimeout(resolve, ms));
    running--;
    return ms * 2;
  });
  assert.deepEqual(out, [60, 10, 40, 2, 20]);
  assert.equal(peak, 2);
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});

test('dirSize adds up the files below a folder, counts a link as itself, skips what cannot be read and stops at the entry cap', async () => {
  const dir = wtDir('size');
  fs.mkdirSync(path.join(dir, 'sub', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x'.repeat(100));
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'x'.repeat(50));
  fs.writeFileSync(path.join(dir, 'sub', 'deep', 'c.txt'), 'x'.repeat(25));
  fs.symlinkSync(path.join(dir, 'a.txt'), path.join(dir, 'link'));
  const total = (await dirSize(dir)).bytes;
  assert.equal((await dirSize(dir)).truncated, false);
  assert.ok(total >= 175 && total < 175 + 4096, `175 bytes of files plus the link itself: ${total}`);
  assert.deepEqual(await dirSize(path.join(dir, 'missing')), { bytes: 0, truncated: false });
  assert.equal((await dirSize(dir, 2)).truncated, true);
  // a file that disappears between listing and measuring counts for nothing
  const ghost = wtDir('ghost');
  fs.symlinkSync(path.join(ghost, 'nowhere'), path.join(ghost, 'dangling'));
  assert.equal((await dirSize(ghost)).truncated, false);
});

function setup(
  over: { chats?: any[]; dirty?: Set<string>; removeOk?: boolean; list?: any[]; root?: string | null; free?: number | Error | null } = {},
) {
  const list = over.list ?? [];
  const removed: string[] = [];
  let gitCalls = 0;
  let now = 1_000_000;
  const s = createWorktreeStorage({
    root: () => (over.root === undefined ? base : over.root),
    list: () => list,
    remove: async (wt: any) => (removed.push(wt.path), over.removeOk !== false),
    git: async (_args: string[], cwd: string) => (
      gitCalls++, over.dirty?.has('unreadable') ? { ok: false, stdout: '' } : { ok: true, stdout: over.dirty?.has(cwd) ? ' M a.ts\n' : '' }
    ),
    chatFolders: async () => over.chats ?? [],
    canonical: (p: string) => path.resolve(p),
    sizeOf: async (p: string) => ({ bytes: p.includes('big') ? 1000 : 10, truncated: false }),
    freeBytes:
      over.free === null
        ? undefined
        : async () => {
            if (over.free instanceof Error) throw over.free;
            return over.free ?? 5000;
          },
    now: () => now,
  });
  return { s, removed, gitCalls: () => gitCalls, tick: (ms: number) => (now += ms) };
}

const wt = (name: string, createdAt = 0) => ({ path: path.join(base, name, 'repo'), repo: '/r', branch: `b-${name}`, createdAt });

test('scan reports each worktree with its size, whether it has uncommitted changes and the chats working in it', async () => {
  const a = wt('a-big');
  const b = wt('b');
  const t = setup({
    list: [a, b],
    dirty: new Set([b.path]),
    chats: [
      { chatId: 'in-a', cwd: path.join(a.path, 'src'), archived: false },
      { chatId: 'archived-in-b', cwd: b.path, archived: true },
      { chatId: 'elsewhere', cwd: '/other', archived: false },
      { chatId: 'no-folder', cwd: null, archived: false },
    ],
  });
  const rows = await t.s.scan();
  assert.deepEqual(
    rows.map((r: any) => [r.path, r.bytes, r.uncommitted, r.usedBy]),
    [
      [a.path, 1000, false, ['in-a']],
      [b.path, 10, true, []],
    ],
    'an archived chat does not hold its worktree: it comes back from its branch',
  );
});

test('a git that cannot read a worktree counts it as having uncommitted changes; no root means no worktrees', async () => {
  const a = wt('a');
  assert.equal((await setup({ list: [a], dirty: new Set(['unreadable']) }).s.scan())[0].uncommitted, true);
  assert.deepEqual(await setup({ list: [a], root: null }).s.scan(), []);
  assert.equal(setup({ list: [a], root: null }).s.find(a.path), null);
});

test('usage is measured once a minute unless refreshed, and a volume that cannot be read leaves free space out', async () => {
  const a = wt('a');
  const t = setup({ list: [a] });
  const first = await t.s.usage();
  assert.equal(first.free, 5000);
  const calls = t.gitCalls();
  assert.equal(await t.s.usage(), first, 'reused');
  assert.equal(t.gitCalls(), calls);
  t.tick(59_000);
  assert.equal(await t.s.usage(), first);
  t.tick(2_000);
  assert.notEqual(await t.s.usage(), first, 'a minute old: measured again');
  assert.notEqual(await t.s.usage(true), first);
  assert.equal((await setup({ list: [a], free: new Error('no statfs') }).s.usage()).free, undefined);
  assert.equal((await setup({ list: [a], free: null }).s.usage()).free, undefined);
  assert.equal((await setup({ list: [a], root: null }).s.usage()).free, undefined);
});

test('removeIfSafe: a worktree in use, gone, with uncommitted changes (unless allowed) or that git cannot remove is not reported removed', async () => {
  const a = wt('a');
  const dirty = new Set([a.path]);
  fs.mkdirSync(a.path, { recursive: true });
  const t = setup({ list: [a], dirty });
  assert.equal(await t.s.removeIfSafe(a, { includeUncommitted: true, usedBy: ['c'] }), 'in_use');
  assert.equal(await t.s.removeIfSafe(a, { includeUncommitted: false, usedBy: [] }), 'uncommitted');
  assert.deepEqual(t.removed, []);
  assert.equal(await t.s.removeIfSafe(a, { includeUncommitted: true, usedBy: [] }), 'removed');
  assert.deepEqual(t.removed, [a.path]);
  assert.equal(await t.s.removeIfSafe(wt('never-made'), { includeUncommitted: true, usedBy: [] }), 'gone');
  const clean = setup({ list: [a], removeOk: false });
  assert.equal(await clean.s.removeIfSafe(a, { includeUncommitted: false, usedBy: [] }), 'failed');
});

test('holders read the chats again each time: a chat that started in a worktree since is found', async () => {
  const a = wt('a');
  const chats: any[] = [];
  const t = setup({ list: [a], chats });
  assert.deepEqual(await t.s.holders([a]), [[]]);
  chats.push({ chatId: 'late', cwd: a.path, archived: false });
  assert.deepEqual(await t.s.holders([a]), [['late']]);
});

test('find matches a listed worktree by its canonical path and nothing else', () => {
  const a = wt('a');
  const t = setup({ list: [a] });
  assert.equal(t.s.find(path.join(a.path, '..', 'repo')), a);
  assert.equal(t.s.find(path.join(a.path, 'src')), null);
});

test('without injected helpers the real ones measure and compare', async () => {
  const dir = wtDir('real');
  fs.writeFileSync(path.join(dir, 'f'), 'abc');
  const s = createWorktreeStorage({
    root: () => base,
    list: () => [{ path: dir, repo: '/r', branch: 'b', createdAt: 0 }],
    remove: async () => true,
    git: async () => ({ ok: true, stdout: '' }),
    chatFolders: async () => [],
    canonical: (p: string) => p,
  });
  const [row] = await s.scan();
  assert.ok(row.bytes >= 3);
  assert.equal((await s.usage()).free, undefined, 'no volume reader given');
});
