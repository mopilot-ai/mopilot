// The worktree tools (electron/capabilities/tools/worktreeTools.cjs): the storage report, a clean-up and a discard that
// delete only what the user's card named and what is still safe when its answer comes (a worktree a chat started working in
// meanwhile stays), and the base-branch merge against real repositories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { registerWorktreeTools } = require('../electron/capabilities/tools/worktreeTools.cjs');
const { createSessionFolders } = require('../electron/capabilities/tools/sessionFolders.cjs');
const { git } = require('../electron/platform/gitRun.cjs');

const DAY = 86_400_000;
const NOW = 100 * DAY;
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-tools-')));

type Row = {
  path: string;
  branch: string | null;
  createdAt: number;
  bytes: number;
  truncated?: boolean;
  uncommitted: boolean;
  usedBy: string[];
  repo?: string;
};
const row = (name: string, o: Partial<Row> = {}): Row => ({
  path: path.join(root, name, 'repo'),
  repo: '/r',
  branch: `b-${name}`,
  createdAt: NOW - 10 * DAY,
  bytes: 2048,
  uncommitted: false,
  usedBy: [],
  ...o,
});

function setup(
  rows: Row[],
  over: {
    answer?: any;
    free?: number;
    outcomes?: Record<string, string>;
    holdersLater?: Record<string, string[]>;
    onAsk?: () => void;
    cwd?: string;
    info?: any;
    git?: any;
  } = {},
) {
  const r = new Registry();
  r.setApprover(async () => true);
  const cards: any[] = [];
  const removed: any[] = [];
  let asked = false;
  const storage = {
    scan: async () => rows,
    usage: async (refresh: boolean) => ({ worktrees: rows, free: over.free, refresh }),
    // the chats working in each worktree: as scanned before the card, as they are after it
    holders: async (list: Row[]) => list.map((w) => (asked ? (over.holdersLater?.[w.path] ?? w.usedBy) : w.usedBy)),
    uncommitted: async (w: Row) => w.uncommitted,
    find: (p: string) => rows.find((w) => w.path === p) ?? null,
    removeIfSafe: async (w: Row, o: any) => (
      removed.push([w.path, o]), over.outcomes?.[w.path] ?? (o.usedBy.length ? 'in_use' : 'removed')
    ),
  };
  registerWorktreeTools(r, {
    owner: (ctx: any) => (ctx.segmentId === 'seg' ? ctx.chatId : null),
    storage,
    sessionFolders: createSessionFolders({ projectOf: async () => over.cwd ?? root, extraOf: () => [], home: root }),
    ask: async (_c: string, _s: any, card: any) => {
      cards.push(card);
      asked = true;
      over.onAsk?.();
      return over.answer === undefined ? { decision: 'allow', choice: 'allow' } : over.answer;
    },
    git: over.git ?? git,
    worktreeInfo: () => over.info ?? null,
    now: () => NOW,
  });
  const call = async (tool: string, args: any, opts: any = {}) => {
    const res = await r.invoke('c', 'seg', tool, args, opts);
    return res.ok ? res.content[0].text : `ERROR ${res.error.code}: ${res.error.message}`;
  };
  return { r, call, cards, removed };
}

test('the four tools are registered under their Claude Desktop names', () => {
  assert.deepEqual(
    setup([])
      .r.list()
      .map((x: any) => x.name),
    ['get_storage_usage', 'clean_up_worktrees', 'discard_kept_worktree', 'sync_with_base_branch'],
  );
});

test('get_storage_usage reports sizes, who holds what, what is idle and clean, and the free space; refresh is passed on', async () => {
  const rows = [
    row('idle'),
    row('held', { usedBy: ['x'], bytes: 1024 }),
    row('dirty', { uncommitted: true, truncated: true, createdAt: NOW - 3 * DAY }),
  ];
  const t = setup(rows, { free: 5000 });
  const out = JSON.parse(await t.call('get_storage_usage', { refresh: true }));
  assert.deepEqual(out.worktrees, {
    count: 3,
    bytes: 5120,
    in_use_count: 1,
    uncommitted_count: 1,
    idle_clean_count: 1,
    idle_clean_bytes: 2048,
  });
  assert.equal(out.free_bytes, 5000);
  assert.match(
    out.said,
    /^3 worktrees the app made use 5 KB: 1 held by sessions, 1 with uncommitted changes and 1 idle and clean \(2 KB, removable with clean_up_worktrees\)\.$/,
  );
  assert.deepEqual(out.list[2], {
    path: rows[2].path,
    branch: 'b-dirty',
    age_days: 3,
    bytes: 2048,
    size_is_lower_bound: true,
    in_use: false,
    uncommitted: true,
  });
  assert.equal('size_is_lower_bound' in out.list[0], false);
  // none made; no free-space reading; a long list is cut with a count
  assert.equal(JSON.parse(await setup([]).call('get_storage_usage', {})).said, 'The app has made no worktrees.');
  assert.equal('free_bytes' in JSON.parse(await setup([]).call('get_storage_usage', {})), false);
  const many = JSON.parse(await setup(Array.from({ length: 53 }, (_, i) => row(`w${i}`))).call('get_storage_usage', {}));
  assert.equal(many.list.length, 50);
  assert.equal(many.list_truncated, 3);
});

test('clean_up_worktrees: the user sees what would go, then only old, idle, clean worktrees are removed and counted', async () => {
  const rows = [
    row('old-clean'),
    row('old-clean-2', { bytes: 2048 }),
    row('young', { createdAt: NOW - 2 * DAY }),
    row('held', { usedBy: ['x'] }),
    row('dirty', { uncommitted: true }),
  ];
  const t = setup(rows);
  const text = await t.call('clean_up_worktrees', {});
  assert.deepEqual(t.cards[0], {
    title: 'Remove worktrees',
    message: 'Remove 2 worktrees (about 4 KB)?',
    details: [rows[0].path, rows[1].path],
    choices: [{ id: 'allow', label: 'Remove' }],
    destructive: true,
  });
  assert.deepEqual(
    t.removed.map((x: any) => [x[0], x[1].includeUncommitted]),
    [
      [rows[0].path, false],
      [rows[1].path, false],
    ],
  );
  assert.equal(text, 'Removed 2 worktrees (about 4 KB freed). get_storage_usage with refresh=true shows the new figures.');
});

test('clean_up_worktrees: with include_uncommitted the card says what is lost and the age is the one asked for; a long list is cut', async () => {
  const rows = [
    row('dirty', { uncommitted: true }),
    ...Array.from({ length: 6 }, (_, i) => row(`w${i}`)),
    row('young', { createdAt: NOW - DAY }),
  ];
  const t = setup(rows);
  await t.call('clean_up_worktrees', { older_than_days: 0, include_uncommitted: true });
  const card = t.cards[0];
  assert.equal(card.message, 'Remove 8 worktrees (about 16 KB)?');
  assert.deepEqual(card.details, [
    `${rows[0].path} (uncommitted changes)`,
    ...rows.slice(1, 5).map((w) => w.path),
    'and 3 more',
    '1 has uncommitted changes that will be lost.',
  ]);
  // only the worktree shown with uncommitted changes may lose them; one that was clean on the card is skipped if it is not now
  assert.deepEqual(
    t.removed.map((x: any) => x[1].includeUncommitted),
    [true, ...Array(6).fill(false), false].slice(0, t.removed.length),
  );
  const two = setup([row('d1', { uncommitted: true }), row('d2', { uncommitted: true })]);
  await two.call('clean_up_worktrees', { include_uncommitted: true });
  assert.equal(two.cards[0].details.at(-1), '2 have uncommitted changes that will be lost.');
});

test('clean_up_worktrees: nothing old enough, idle and clean is not an error and asks nothing, and says why', async () => {
  const none = setup([row('held', { usedBy: ['x'] }), row('dirty', { uncommitted: true }), row('young', { createdAt: NOW - DAY })]);
  assert.equal(
    await none.call('clean_up_worktrees', {}),
    'Nothing to remove: 2 worktrees are older than 7 days, 1 held by sessions, 1 with uncommitted changes (pass include_uncommitted to remove those too, after the user agrees).',
  );
  assert.equal(await setup([]).call('clean_up_worktrees', { older_than_days: 1 }), 'Nothing to remove: 0 worktrees are older than 1 day.');
  assert.equal(
    await setup([row('one')]).call('clean_up_worktrees', { older_than_days: 30 }),
    'Nothing to remove: 0 worktrees are older than 30 days.',
  );
  assert.deepEqual(none.cards, []);
});

test('clean_up_worktrees: a decline removes nothing; bad arguments are refused before anything is read', async () => {
  const t = setup([row('a')], { answer: { decision: 'deny' } });
  assert.match(await t.call('clean_up_worktrees', {}), /^ERROR denied: The user declined, so no worktree was removed/);
  assert.deepEqual(t.removed, []);
  for (const bad of [{ older_than_days: -1 }, { older_than_days: Number.POSITIVE_INFINITY }, { include_uncommitted: 'yes' }])
    assert.match(await setup([row('a')]).call('clean_up_worktrees', bad as any), /^ERROR (invalid_args|bad_args)/, JSON.stringify(bad));
});

test('clean_up_worktrees: a worktree a chat started working in while the card waited is skipped, the others go, and the call says so', async () => {
  const rows = [row('a'), row('b'), row('c')];
  const t = setup(rows, { holdersLater: { [rows[1].path]: ['late-chat'] }, outcomes: { [rows[2].path]: 'failed' } });
  const text = await t.call('clean_up_worktrees', {});
  assert.deepEqual(
    t.removed.map((x: any) => [path.basename(path.dirname(x[0])), x[1].usedBy]),
    [
      ['a', []],
      ['b', ['late-chat']],
      ['c', []],
    ],
  );
  assert.equal(
    text,
    'Removed 1 worktree (about 2 KB freed). 1 was skipped (a session started working in it, or it changed since the card). 1 could not be removed (a folder would not delete). get_storage_usage with refresh=true shows the new figures.',
  );
  // one that is already gone counts for nothing either way
  const gone = setup([row('a'), row('b')], { outcomes: { [row('b').path]: 'gone' } });
  assert.match(await gone.call('clean_up_worktrees', {}), /^Removed 1 worktree/);
  // every one skipped: an error the model can act on
  const all = setup([row('a')], { holdersLater: { [row('a').path]: ['late'] } });
  assert.match(await all.call('clean_up_worktrees', {}), /^ERROR nothing_removed: Removed no worktrees\. 1 was skipped/);
});

test('clean_up_worktrees: stopping the call mid-way leaves the rest alone', async () => {
  const stop = new AbortController();
  const rows = [row('a'), row('b'), row('c')];
  // the call is stopped during the first removal
  const r = new Registry();
  r.setApprover(async () => true);
  const removed: string[] = [];
  registerWorktreeTools(r, {
    owner: () => 'c',
    storage: {
      scan: async () => rows,
      holders: async (l: Row[]) => l.map(() => []),
      removeIfSafe: async (w: Row) => (removed.push(w.path), stop.abort(), 'removed'),
    } as any,
    sessionFolders: { resolve: async () => ({ path: root, isDirectory: true }) },
    ask: async () => ({ decision: 'allow' }),
    git,
    worktreeInfo: () => null,
    now: () => NOW,
  });
  const res = await r.invoke('c', 'seg', 'clean_up_worktrees', {}, { signal: stop.signal });
  // the registry reports the stop; the handler stopped after one removal
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(res.ok, false);
  assert.deepEqual(removed, [rows[0].path]);
});

test('discard_kept_worktree: the user is asked about that worktree by name, uncommitted changes are said to be lost, and its branch is kept', async () => {
  const rows = [row('dirty', { uncommitted: true }), row('clean')];
  const t = setup(rows);
  const text = await t.call('discard_kept_worktree', { path: rows[0].path });
  assert.deepEqual(t.cards[0], {
    title: 'Delete worktree',
    message: 'Delete this worktree and its uncommitted changes?',
    details: [rows[0].path, 'Branch b-dirty is kept.'],
    choices: [{ id: 'allow', label: 'Delete' }],
    destructive: true,
  });
  assert.equal(t.removed[0][1].includeUncommitted, true, 'the card said the changes would be lost');
  assert.equal(
    text,
    `Deleted the worktree ${rows[0].path} and its uncommitted changes. Its branch is kept. get_storage_usage with refresh=true shows the new figures.`,
  );
  const clean = setup(rows);
  assert.match(await clean.call('discard_kept_worktree', { path: rows[1].path }), /^Deleted the worktree .*repo\. Its branch is kept\./);
  assert.equal(clean.cards[0].message, 'Delete this worktree?');
  const noBranch = setup([row('nb', { branch: null })]);
  await noBranch.call('discard_kept_worktree', { path: row('nb').path });
  assert.deepEqual(noBranch.cards[0].details, [row('nb').path]);
});

test('discard_kept_worktree: a worktree in use by another chat is refused before the card, and again if a chat starts in it while the card waits', async () => {
  const held = row('held', { usedBy: ['other-chat'] });
  const t = setup([held]);
  assert.match(
    await t.call('discard_kept_worktree', { path: held.path }),
    /^ERROR busy: Nothing was removed: .* is in use \(another session works inside it\)/,
  );
  assert.deepEqual(t.cards, []);
  assert.deepEqual(t.removed, []);
  const free = row('free');
  const late = setup([free], { holdersLater: { [free.path]: ['late-chat'] } });
  assert.match(
    await late.call('discard_kept_worktree', { path: free.path }),
    /^ERROR busy: Nothing was removed: .* \(a session started working inside it\)/,
  );
  assert.equal(late.removed[0][1].usedBy[0], 'late-chat', 'the removal itself is told who holds it');
});

test('discard_kept_worktree: an unknown path, a decline, a worktree gone meanwhile and one that would not delete are each said plainly', async () => {
  const a = row('a');
  assert.match(await setup([a]).call('discard_kept_worktree', { path: 'relative' }), /^ERROR invalid_args/);
  assert.match(
    await setup([a]).call('discard_kept_worktree', { path: '/not/listed' }),
    /^ERROR not_found: That is not a worktree this app made/,
  );
  const declined = setup([a], { answer: { decision: 'deny' } });
  assert.match(
    await declined.call('discard_kept_worktree', { path: a.path }),
    /^ERROR denied: The user declined, so the worktree was not deleted/,
  );
  assert.deepEqual(declined.removed, []);
  assert.match(
    await setup([a], { outcomes: { [a.path]: 'gone' } }).call('discard_kept_worktree', { path: a.path }),
    /^ERROR not_found: .* is already gone/,
  );
  assert.match(
    await setup([a], { outcomes: { [a.path]: 'failed' } }).call('discard_kept_worktree', { path: a.path }),
    /^ERROR failed: The worktree .* could not be deleted/,
  );
  assert.match(
    await setup([a], { outcomes: { [a.path]: 'uncommitted' } }).call('discard_kept_worktree', { path: a.path }),
    /^ERROR changed: Nothing was removed: .* has uncommitted changes that were not there when the user was asked/,
  );
});

/* --------------------------- sync_with_base_branch, against real repositories --------------------------- */

const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });

/** A repository on branch `feature` cut from `main`, with a bare origin that main moves on in. */
function repo(name: string) {
  const dir = path.join(root, `sync-${name}`);
  const origin = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  run(dir, 'init', '--bare', '-b', 'main', origin);
  run(work, 'init', '-b', 'main');
  run(work, 'config', 'user.name', 't');
  run(work, 'config', 'user.email', 't@t');
  fs.writeFileSync(path.join(work, 'f.txt'), 'one\n');
  run(work, 'add', '.');
  run(work, 'commit', '-m', 'one');
  run(work, 'remote', 'add', 'origin', origin);
  run(work, 'push', '-u', 'origin', 'main');
  run(work, 'remote', 'set-head', 'origin', 'main');
  run(work, 'switch', '-c', 'feature');
  const advance = (file: string, text: string) => {
    const other = path.join(dir, 'other');
    if (!fs.existsSync(other)) run(dir, 'clone', origin, 'other');
    run(other, 'pull', '-q', 'origin', 'main');
    fs.writeFileSync(path.join(other, file), text);
    run(other, 'add', '.');
    run(other, 'commit', '-m', `change ${file}`);
    run(other, 'push', 'origin', 'HEAD:main');
  };
  return { work, origin, advance, dir };
}
const managed = (work: string, o: any = {}) => ({ path: work, repo: work, branch: 'feature', sourceBranch: 'main', ...o });
const sync = (work: string, info: any, args: any = {}) => setup([], { cwd: work, info }).call('sync_with_base_branch', args);

test('sync_with_base_branch merges the fetched base into the branch, or says it already has everything', async () => {
  const r = repo('merge');
  assert.match(await sync(r.work, managed(r.work)), /^feature already has everything from origin\/main\.$/);
  r.advance('g.txt', 'two\n');
  assert.equal(await sync(r.work, managed(r.work)), 'Merged origin/main into feature. Push when you are ready.');
  assert.equal(fs.readFileSync(path.join(r.work, 'g.txt'), 'utf8'), 'two\n');
  // no recorded branch names are needed for the wording
  r.advance('h.txt', 'three\n');
  assert.equal(await sync(r.work, managed(r.work, { branch: null })), 'Merged origin/main into the branch. Push when you are ready.');
  r.advance('i.txt', 'x\n');
  const none = await sync(r.work, managed(r.work, { branch: null }));
  assert.match(none, /^Merged origin\/main/);
  assert.match(await sync(r.work, managed(r.work, { branch: null })), /^The branch already has everything/);
});

test("sync_with_base_branch: the base is the recorded source branch, else origin's default", async () => {
  const r = repo('base');
  r.advance('g.txt', 'two\n');
  assert.match(await sync(r.work, managed(r.work, { sourceBranch: undefined })), /^Merged origin\/main into feature/);
  const lone = repo('nobase');
  run(lone.work, 'remote', 'set-head', 'origin', '-d');
  assert.match(
    await sync(lone.work, managed(lone.work, { sourceBranch: undefined })),
    /^ERROR refused: Not merging: the app doesn't know this branch's base branch/,
  );
  assert.match(await sync(lone.work, managed(lone.work, { sourceBranch: '--evil' })), /^ERROR refused: .*base branch/);
});

test('sync_with_base_branch stops on conflicts, lists the files, and abort puts the branch back', async () => {
  const r = repo('conflict');
  fs.writeFileSync(path.join(r.work, 'f.txt'), 'mine\n');
  run(r.work, 'commit', '-am', 'mine');
  r.advance('f.txt', 'theirs\n');
  const text = await sync(r.work, managed(r.work));
  assert.match(
    text,
    /^ERROR conflicts: Merging origin\/main stopped on conflicts in f\.txt\. Resolve them, then git add, commit and push; or call sync_with_base_branch with abort: true/,
  );
  // a merge is now in progress: starting another is refused, abort undoes it
  assert.match(await sync(r.work, managed(r.work)), /^ERROR refused: Not merging: the worktree has uncommitted changes/);
  fs.writeFileSync(path.join(r.work, 'f.txt'), 'resolved\n');
  run(r.work, 'add', '.');
  assert.match(await sync(r.work, managed(r.work)), /^ERROR refused: Not merging: the worktree has uncommitted changes/);
  assert.equal(await sync(r.work, managed(r.work), { abort: true }), 'Aborted the merge; feature is as it was before.');
  assert.equal(run(r.work, 'status', '--porcelain').trim().includes('UU'), false);
  assert.match(await sync(r.work, managed(r.work), { abort: true }), /^ERROR nothing_to_abort: There was no merge to abort here/);
  // without a recorded branch the wording is general
  assert.match(await sync(r.work, managed(r.work, { branch: null }), { abort: true }), /^ERROR nothing_to_abort/);
});

test('sync_with_base_branch refuses a worktree it should not touch, and says what to deal with first', async () => {
  const r = repo('refuse');
  r.advance('g.txt', 'two\n');
  fs.writeFileSync(path.join(r.work, 'dirty.txt'), 'x');
  assert.match(
    await sync(r.work, managed(r.work)),
    /^ERROR refused: Not merging: the worktree has uncommitted changes\. Deal with that, then call again\./,
  );
  fs.rmSync(path.join(r.work, 'dirty.txt'));
  assert.match(await sync(r.work, managed(r.work, { branch: 'other' })), /does not have other checked out/);
  // a merge, a cherry-pick, a revert and a rebase under way
  for (const [file, what] of [
    ['MERGE_HEAD', 'a merge'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick'],
    ['REVERT_HEAD', 'a revert'],
  ]) {
    const head = run(r.work, 'rev-parse', 'HEAD').trim();
    const where = path.join(r.work, '.git', file);
    fs.writeFileSync(where, `${head}\n`);
    assert.match(await sync(r.work, managed(r.work)), new RegExp(`^ERROR refused: Not merging: ${what} is already in progress`), what);
    fs.rmSync(where);
  }
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    fs.mkdirSync(path.join(r.work, '.git', dir));
    assert.match(await sync(r.work, managed(r.work)), /^ERROR refused: Not merging: a rebase is in progress/, dir);
    fs.rmdirSync(path.join(r.work, '.git', dir));
  }
  run(r.work, 'switch', '--detach', 'HEAD');
  assert.match(await sync(r.work, managed(r.work)), /^ERROR refused: Not merging: the worktree is on a detached HEAD/);
});

test('sync_with_base_branch: a folder the app did not make is not merged for the model; an unreachable origin and unreadable status are said so', async () => {
  const r = repo('other');
  assert.match(await sync(r.work, null), /^ERROR not_managed: This folder is not a worktree the app made/);
  fs.rmSync(r.origin, { recursive: true });
  assert.match(await sync(r.work, managed(r.work)), /^ERROR fetch_failed: Could not fetch origin\/main/);
  const failing = setup([], { cwd: r.work, info: managed(r.work), git: async () => ({ ok: false, stdout: '', stderr: '' }) });
  assert.match(await failing.call('sync_with_base_branch', {}), /^ERROR refused: Not merging: git could not read the worktree/);
  // a merge that fails for a reason other than conflicts
  const odd = setup([], {
    cwd: r.work,
    info: managed(r.work),
    git: async (args: string[]) => {
      if (args[0] === 'merge') return { ok: false, stdout: '', stderr: 'fatal: refusing to merge unrelated histories' };
      if (args[0] === 'diff') return { ok: true, stdout: '', stderr: '' };
      if (args[0] === 'status' || args[0] === 'fetch') return { ok: true, stdout: '', stderr: '' };
      if (args[0] === 'symbolic-ref') return { ok: true, stdout: 'feature\n', stderr: '' };
      return { ok: false, stdout: '', stderr: '' };
    },
  });
  assert.match(
    await odd.call('sync_with_base_branch', {}),
    /^ERROR merge_failed: The merge of origin\/main failed: fatal: refusing to merge unrelated histories/,
  );
  // many conflicts are cut to twenty names
  const names = Array.from({ length: 23 }, (_, i) => `f${i}.txt`);
  const many = setup([], {
    cwd: r.work,
    info: managed(r.work),
    git: async (args: string[]) => {
      if (args[0] === 'merge') return { ok: false, stdout: '', stderr: '' };
      if (args[0] === 'diff') return { ok: true, stdout: names.join('\n'), stderr: '' };
      if (args[0] === 'symbolic-ref') return { ok: true, stdout: 'feature\n', stderr: '' };
      if (args[0] === 'fetch' || args[0] === 'status') return { ok: true, stdout: '', stderr: '' };
      return { ok: false, stdout: '', stderr: '' };
    },
  });
  assert.match(await many.call('sync_with_base_branch', {}), /f19\.txt and 3 more\./);
  // a folder outside the session is refused like any other path
  assert.match(
    await setup([], { cwd: r.work, info: managed(r.work) }).call('sync_with_base_branch', { folder: os.tmpdir() }),
    /^ERROR not_found/,
  );
});
