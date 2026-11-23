// #3909: pruning managed worktrees never deletes anything in a holder folder beyond the clean managed worktrees
// themselves: a dirty or unmanaged sibling, or a holder a chat still works in (even from a sibling folder), stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const wt = require('../electron/platform/git.cjs');

function tempRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-wt3909-')));
  const repo = path.join(dir, 'demo');
  fs.mkdirSync(repo, { recursive: true });
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  run('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  run('add', '.');
  run('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
  return { dir, repo, root: path.join(dir, 'worktrees') };
}

/** `count` managed worktrees, oldest first. */
async function made(repo: string, root: string, count: number) {
  const out: { worktree: string; branch: string }[] = [];
  for (let i = 0; i < count; i++) {
    out.push(await wt.worktreeAdd(repo, { root }));
    await new Promise((r) => setTimeout(r, 5));
  }
  return out;
}

const holderOf = (w: { worktree: string }) => path.dirname(w.worktree);

test('an unmanaged folder beside the managed worktree survives, and so does its holder', async () => {
  const { dir, repo, root } = tempRepo();
  try {
    const [old, , newest] = await made(repo, root, 3);
    const notes = path.join(holderOf(old), 'bench-preserve-chrome');
    fs.mkdirSync(notes);
    fs.writeFileSync(path.join(notes, 'work.txt'), 'uncommitted\n');
    const removed = await wt.pruneWorktrees(root, 1, []);
    assert.equal(fs.readFileSync(path.join(notes, 'work.txt'), 'utf8'), 'uncommitted\n');
    assert.ok(!removed.includes(old.worktree), 'the holder with foreign content is not pruned');
    assert.equal(fs.existsSync(newest.worktree), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a dirty git worktree beside the managed one keeps the whole holder', async () => {
  const { dir, repo, root } = tempRepo();
  try {
    const [old] = await made(repo, root, 3);
    const sibling = path.join(holderOf(old), 'g3-combined-verify');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'sib', sibling], { cwd: repo, stdio: 'ignore' });
    fs.writeFileSync(path.join(sibling, 'dirty.txt'), 'uncommitted\n');
    await wt.pruneWorktrees(root, 1, []);
    assert.equal(fs.readFileSync(path.join(sibling, 'dirty.txt'), 'utf8'), 'uncommitted\n');
    assert.equal(fs.existsSync(old.worktree), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a chat working in a sibling folder of the managed worktree keeps the holder', async () => {
  const { dir, repo, root } = tempRepo();
  try {
    const [old] = await made(repo, root, 3);
    const sibling = path.join(holderOf(old), 'scratch');
    fs.mkdirSync(sibling);
    const removed = await wt.pruneWorktrees(root, 1, [sibling]);
    assert.ok(!removed.includes(old.worktree));
    assert.equal(fs.existsSync(sibling), true);
    assert.equal(fs.existsSync(old.worktree), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a chat whose folder is the holder itself keeps it', async () => {
  const { dir, repo, root } = tempRepo();
  try {
    const [old] = await made(repo, root, 3);
    const removed = await wt.pruneWorktrees(root, 1, [holderOf(old)]);
    assert.ok(!removed.includes(old.worktree));
    assert.equal(fs.existsSync(old.worktree), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a holder counts once toward the limit, however many folders it holds', async () => {
  const { dir, repo, root } = tempRepo();
  try {
    const [first, second] = await made(repo, root, 2);
    // two folders in the newer holder must not push the older one past the limit of 2
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'sib2', path.join(holderOf(second), 'extra')], { cwd: repo, stdio: 'ignore' });
    const removed = await wt.pruneWorktrees(root, 2, []);
    assert.deepEqual(removed, []);
    assert.equal(fs.existsSync(first.worktree), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removing one worktree leaves other files in its holder and drops the marker only with the last folder', async () => {
  const { dir, repo, root } = tempRepo();
  try {
    const [one] = await made(repo, root, 1);
    const keepFile = path.join(holderOf(one), 'notes.txt');
    fs.writeFileSync(keepFile, 'mine\n');
    assert.equal(await wt.removeWorktree({ path: one.worktree, repo }), true);
    assert.equal(fs.existsSync(one.worktree), false);
    assert.equal(fs.readFileSync(keepFile, 'utf8'), 'mine\n');
    const [two] = await made(repo, root, 1);
    assert.equal(await wt.removeWorktree({ path: two.worktree, repo }), true);
    assert.equal(fs.existsSync(holderOf(two)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('each pruned holder is logged with its reason, and so is each one kept back', async () => {
  const { dir, repo, root } = tempRepo();
  const lines: string[] = [];
  try {
    const [old, mid] = await made(repo, root, 3);
    fs.mkdirSync(path.join(holderOf(mid), 'notes'));
    const removed = await wt.pruneWorktrees(root, 1, [], (line: string) => lines.push(line));
    assert.deepEqual(removed, [old.worktree]);
    assert.ok(lines.some((l) => l.includes(holderOf(old)) && /pruned/.test(l)));
    assert.ok(lines.some((l) => l.includes(holderOf(mid)) && /kept.*(unmanaged|other)/i.test(l)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('liveChatFolders: every chat that is not archived, MoMo aside, and chats with no folder skipped', async () => {
  const { liveChatFolders } = require('../electron/app/liveChatFolders.cjs');
  const records = new Map<string, any>([
    ['a', { meta: {} }],
    ['b', { meta: { archived: 5 } }],
    ['c', { meta: {} }],
    ['momo', { meta: { momo: 'main' } }],
    ['d', {}],
  ]);
  const dirs: Record<string, string | null> = { a: '/wt/a/app', c: null, momo: '/m', d: '/wt/d' };
  assert.deepEqual(await liveChatFolders({ chats: { records } }, async (id: string) => dirs[id] ?? null), ['/wt/a/app', '/wt/d']);
});

test('git:worktreePrune adds the folders main knows chats work in, and prunes nothing when it cannot list them', async () => {
  const { dir, repo, root } = tempRepo();
  try {
    const [old, mid] = await made(repo, root, 3);
    const handlers = new Map<string, (...a: any[]) => any>();
    const ipc = { handle: (c: string, f: any) => handlers.set(c, f) };
    wt.register(ipc);
    wt.setChatFolders(async () => [path.join(holderOf(old), 'scratch')]);
    const removed = await handlers.get('git:worktreePrune')!(null, root, 1, []);
    assert.deepEqual(removed, [mid.worktree]);
    assert.equal(fs.existsSync(old.worktree), true);
    wt.setChatFolders(async () => {
      throw new Error('unreadable');
    });
    assert.deepEqual(await handlers.get('git:worktreePrune')!(null, root, 1, []), []);
    // a root that is not a full path has nothing of ours: never the default folder under the real home
    assert.deepEqual(await handlers.get('git:worktreePrune')!(null, 'relative/worktrees', 1, []), []);
  } finally {
    wt.setChatFolders(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ignored files that are not rebuildable keep the holder; an ignored node_modules alone does not', async () => {
  const { dir, repo, root } = tempRepo();
  try {
    fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), 'scratch.log\nnode_modules/\n');
    const [old, mid] = await made(repo, root, 3);
    fs.writeFileSync(path.join(old.worktree, 'scratch.log'), 'local data\n');
    fs.mkdirSync(path.join(mid.worktree, 'node_modules'));
    fs.writeFileSync(path.join(mid.worktree, 'node_modules', 'x.js'), '1\n');
    const lines: string[] = [];
    const removed = await wt.pruneWorktrees(root, 1, [], (l: string) => lines.push(l));
    assert.deepEqual(removed, [mid.worktree]);
    assert.equal(fs.readFileSync(path.join(old.worktree, 'scratch.log'), 'utf8'), 'local data\n');
    assert.ok(lines.some((l) => l.includes(holderOf(old)) && /ignored files that are not rebuildable/.test(l)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('under the test runner the real worktree root is never pruned or removed from', async () => {
  const { touchesRealRootUnderTest } = require('../electron/platform/realWorktreeRoot.cjs');
  const real = path.join(os.userInfo().homedir, '.mopilot', 'worktrees');
  assert.equal(touchesRealRootUnderTest(real, { NODE_TEST_CONTEXT: 'child-v8' }), true);
  assert.equal(touchesRealRootUnderTest(path.join(real, 'abcd', 'app'), { NODE_TEST_CONTEXT: 'child-v8' }), true);
  assert.equal(touchesRealRootUnderTest(real, {}), false, 'only under the test runner');
  assert.equal(touchesRealRootUnderTest(path.join(os.tmpdir(), 'worktrees'), { NODE_TEST_CONTEXT: 'child-v8' }), false);
  assert.equal(
    touchesRealRootUnderTest(path.join(os.userInfo().homedir, '.mopilot', 'worktrees-other'), { NODE_TEST_CONTEXT: 'child-v8' }),
    false,
  );
  // a root under the real one that has nothing in it: refused with a line, and the removal helper refuses too
  const lines: string[] = [];
  assert.deepEqual(await wt.pruneWorktrees(path.join(real, 'no-such-folder'), 1, [], (l: string) => lines.push(l)), []);
  assert.match(lines[0], /refused/);
  assert.equal(await wt.removeWorktree({ path: path.join(real, 'no-such-id', 'app'), repo: '/nowhere' }), false);
});

test('a chat folder named through a symlink or another case still keeps its holder', async () => {
  const { dir, repo, root } = tempRepo();
  try {
    const [old] = await made(repo, root, 3);
    const link = path.join(dir, 'link');
    fs.symlinkSync(root, link);
    const viaLink = path.join(link, path.basename(holderOf(old)), 'demo');
    assert.ok(!(await wt.pruneWorktrees(root, 1, [viaLink])).includes(old.worktree));
    assert.equal(fs.existsSync(old.worktree), true);
    if (process.platform === 'darwin') {
      const shouting = path.join(root, path.basename(holderOf(old)).toUpperCase(), 'DEMO');
      assert.ok(!(await wt.pruneWorktrees(root, 1, [shouting])).includes(old.worktree));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('liveChatFolders gives up (null) when a chat that has started has no readable folder', async () => {
  const { liveChatFolders } = require('../electron/app/liveChatFolders.cjs');
  const records = new Map<string, any>([
    ['new', { meta: {} }],
    ['started', { meta: {}, segments: [{ kind: 'claude' }] }],
  ]);
  assert.deepEqual(await liveChatFolders({ chats: { records } }, async (id: string) => (id === 'new' ? null : '/wt/s')), ['/wt/s']);
  assert.equal(await liveChatFolders({ chats: { records } }, async () => null), null);
});

test('no list of chat folders from main (not set, or incomplete) means nothing is pruned', async () => {
  const { dir, repo, root } = tempRepo();
  try {
    const [old] = await made(repo, root, 3);
    const handlers = new Map<string, (...a: any[]) => any>();
    wt.register({ handle: (c: string, f: any) => handlers.set(c, f) });
    wt.setChatFolders(null);
    assert.deepEqual(await handlers.get('git:worktreePrune')!(null, root, 1, []), []);
    wt.setChatFolders(async () => null);
    assert.deepEqual(await handlers.get('git:worktreePrune')!(null, root, 1, []), []);
    assert.equal(fs.existsSync(old.worktree), true);
  } finally {
    wt.setChatFolders(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a folder beside the checkout in a marked holder is not listed as a worktree', async () => {
  const { dir, repo, root } = tempRepo();
  try {
    const [one] = await made(repo, root, 1);
    fs.mkdirSync(path.join(holderOf(one), 'notes'));
    assert.deepEqual(
      wt.listWorktrees(root).map((w: any) => w.path),
      [one.worktree],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a holder whose worktree git cannot remove is logged as kept, not pruned', async () => {
  const { createPruner } = require('../electron/platform/worktreePrune.cjs');
  const { dir } = tempRepo();
  try {
    const holder = path.join(dir, 'h1');
    fs.mkdirSync(path.join(holder, 'app', '.git'), { recursive: true });
    const other = path.join(dir, 'h2');
    fs.mkdirSync(path.join(other, 'app', '.git'), { recursive: true });
    const list = [
      { path: path.join(holder, 'app'), createdAt: 1 },
      { path: path.join(other, 'app'), createdAt: 2 },
    ];
    const { pruneWorktrees } = createPruner({
      git: async () => ({ ok: true, stdout: '' }),
      listWorktrees: () => list,
      removeWorktree: async () => false,
      marker: '.m',
      canonical: (p: string) => p,
    });
    const lines: string[] = [];
    assert.deepEqual(await pruneWorktrees(dir, 1, [], (l: string) => lines.push(l)), []);
    assert.ok(lines.some((l) => l.includes(holder) && /kept: git could not remove/.test(l)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a holder that cannot be read is kept, with the reason', async () => {
  const { createPruner } = require('../electron/platform/worktreePrune.cjs');
  const { dir } = tempRepo();
  try {
    // listed, but gone by the time its folder is read
    const list = [
      { path: path.join(dir, 'gone-1', 'app'), createdAt: 1 },
      { path: path.join(dir, 'gone-2', 'app'), createdAt: 2 },
    ];
    const { pruneWorktrees } = createPruner({
      git: async () => ({ ok: true, stdout: '' }),
      listWorktrees: () => list,
      removeWorktree: async () => assert.fail('nothing unreadable is removed'),
      marker: '.m',
      canonical: (p: string) => p,
    });
    const lines: string[] = [];
    assert.deepEqual(await pruneWorktrees(dir, 1, [], (l: string) => lines.push(l)), []);
    assert.ok(lines.some((l) => l.includes('gone-1') && /kept: its folder could not be read/.test(l)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
