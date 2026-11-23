// Worktree removal from different chats (electron/capabilities/tools/worktreeTools.cjs): runs take turns, so no worktree is
// removed twice at once, and a run that fails does not hold the next one up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { registerWorktreeTools } = require('../electron/capabilities/tools/worktreeTools.cjs');

const DAY = 86_400_000;
const NOW = 100 * DAY;
const rows = ['a', 'b'].map((name) => ({
  path: `/w/${name}/repo`,
  repo: '/r',
  branch: name,
  createdAt: 0,
  bytes: 1024,
  uncommitted: false,
  usedBy: [] as string[],
}));

function setup(removeIfSafe: (w: any, o: any) => Promise<string>) {
  const r = new Registry();
  r.setApprover(async () => true);
  registerWorktreeTools(r, {
    owner: (ctx: any) => ctx.chatId,
    storage: {
      scan: async () => rows,
      holders: async (list: unknown[]) => list.map(() => []),
      removeIfSafe,
      find: (p: string) => rows.find((w) => w.path === p) ?? null,
      uncommitted: async () => false,
    } as any,
    sessionFolders: { resolve: async () => ({ path: '/w', isDirectory: true }) },
    ask: async () => ({ decision: 'allow' }),
    git: async () => ({ ok: true, stdout: '', stderr: '' }),
    worktreeInfo: () => null,
    now: () => NOW,
  });
  return r;
}

test('two clean-ups from different chats never remove at the same time, and a removal that throws costs only that worktree', async () => {
  let running = 0;
  let peak = 0;
  let calls = 0;
  const r = setup(async () => {
    peak = Math.max(peak, ++running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
    // the first removal of the first run blows up
    if (calls++ === 0) throw new Error('disk gone');
    return 'removed';
  });
  const [first, second] = await Promise.all([
    r.invoke('one', 'seg', 'clean_up_worktrees', {}),
    r.invoke('two', 'seg', 'clean_up_worktrees', {}),
  ]);
  assert.equal(peak, 1);
  assert.equal(first.ok, true, 'the other worktree of that run was still removed');
  assert.match(first.content[0].text, /^Removed 1 worktree \(about 1 KB freed\)\. 1 could not be removed/);
  assert.equal(second.ok, true, "the other chat's run went on");
  assert.match(second.content[0].text, /^Removed 2 worktrees/);
});

test('a clean-up stopped while it waits for another run removes nothing when its turn comes', async () => {
  const removed: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const r = setup(async (w) => {
    removed.push(w.path);
    await gate;
    return 'removed';
  });
  const stop = new AbortController();
  const slow = r.invoke('one', 'seg', 'clean_up_worktrees', {});
  const waiting = r.invoke('two', 'seg', 'clean_up_worktrees', {}, { signal: stop.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  stop.abort();
  assert.equal((await waiting).ok, false, 'the registry answers a stopped call at once');
  release();
  assert.equal((await slow).ok, true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(removed, [rows[0].path, rows[1].path], 'only the first run removed anything');
});

test('a discard waits for a clean-up that is removing, and finds the worktree already gone', async () => {
  const removed = new Set<string>();
  const order: string[] = [];
  const r = setup(async (w) => {
    order.push(`start ${w.path}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(`end ${w.path}`);
    if (removed.has(w.path)) return 'gone';
    removed.add(w.path);
    return 'removed';
  });
  const [cleanup, discard] = await Promise.all([
    r.invoke('one', 'seg', 'clean_up_worktrees', {}),
    r.invoke('two', 'seg', 'discard_kept_worktree', { path: rows[0].path }),
  ]);
  assert.equal(cleanup.ok, true);
  assert.equal(discard.ok, false);
  assert.match(discard.error.message, /already gone/);
  assert.deepEqual(order, [
    `start ${rows[0].path}`,
    `end ${rows[0].path}`,
    `start ${rows[1].path}`,
    `end ${rows[1].path}`,
    `start ${rows[0].path}`,
    `end ${rows[0].path}`,
  ]);
});
