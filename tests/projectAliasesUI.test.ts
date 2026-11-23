// Project navigation joins filesystem aliases across harnesses without changing the chats' own working directories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import {
  fx,
  reset,
  thread,
  project,
  probe,
  getState,
  update,
  prefsCalls,
  mountSidebar,
  mouse,
  click,
  named,
} from './support/shell-sidebar-kit.ts';
import { controlledReads } from './support/async-scenarios.ts';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { drag } from './support/shell-sidebar-kit.ts';

const projectsStore = createRequire(import.meta.url)('../electron/platform/projects.cjs');
const { canonicalPaths } = createRequire(import.meta.url)('../electron/platform/projectPaths.cjs');

const alias = '/home/Documents/ChatGPT/Sage';
const real = '/home/Projects/Sage';
const identities = (paths: string[]) => Object.fromEntries(paths.map((p) => [p, p === alias ? real : p]));

test('deleted worktrees through a real symlink reuse saved groups on every harness without rewriting chat folders', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-deleted-worktrees-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'Projects', 'Sage');
  const link = path.join(dir, 'ChatGPT', 'Sage');
  const ownerLink = path.join(dir, 'OwnerAlias');
  const other = path.join(dir, 'Other', 'Sage');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  fs.symlinkSync(root, link, 'junction');
  fs.symlinkSync(root, ownerLink, 'junction');
  const deleted = path.join(link, '.claude', 'worktrees', 'removed');
  const deletedOwner = path.join(ownerLink, '.claude', 'worktrees', 'removed');
  const ids = ['codex', 'claude:deleted', 'acp:test:switched'];
  for (const savedPath of [link, root]) {
    reset({
      savedProjects: [project('saved', savedPath, 'Sage'), project('distinct', other, 'Sage')],
      threadOrder: [...ids, 'elsewhere'],
      threads: {
        codex: thread('codex', { cwd: root, projectId: 'saved' }),
        'claude:deleted': thread('claude:deleted', { cwd: deleted }),
        'acp:test:switched': thread('acp:test:switched', { cwd: '/different-current-folder' }),
        elsewhere: thread('elsewhere', { cwd: other, projectId: 'distinct' }),
      },
      worktreeOf: { 'acp:test:switched': deletedOwner },
      prefs: {
        sidebarFolders: [link, root],
        sidebarProjectOrder: ['saved', 'distinct'],
        pinnedProjects: ['saved'],
        chatSort: 'manual',
        chatOrder: { saved: [...ids].reverse() },
      },
    });
    const reads: Promise<Record<string, string>>[] = [];
    fx.canonicalPaths = (paths) => {
      const read = canonicalPaths(paths);
      reads.push(read);
      return read;
    };
    const { get, view } = await probe();
    try {
      await act(async () => void (await Promise.all(reads)));
      assert.deepEqual(
        get().groups.map((g: any) => [g.id, g.threads.map((chat: any) => chat.id)]),
        [
          ['saved', [...ids].reverse()],
          ['distinct', ['elsewhere']],
        ],
      );
      assert.equal(get().groups[0].path, savedPath);
      assert.equal(getState().threads['claude:deleted'].cwd, deleted);
      assert.equal(getState().threads['acp:test:switched'].cwd, '/different-current-folder');
      assert.equal(getState().worktreeOf['acp:test:switched'], deletedOwner);
      assert.deepEqual(prefsCalls(), [], 'saved groups do not persist another inferred folder or order key');
    } finally {
      await view.unmount();
    }
  }
});

test('symlink aliases and their worktree parents share one group; same-named distinct folders stay separate', async () => {
  reset({
    home: '/home',
    threadOrder: ['codex', 'claude-one', 'acp-one', 'elsewhere'],
    threads: {
      codex: thread('codex', { cwd: alias, updatedAt: 4 }),
      'claude-one': thread('claude-one', { cwd: `${alias}/.claude/worktrees/branch`, updatedAt: 3 }),
      'acp-one': thread('acp-one', { cwd: '/worktrees/task', updatedAt: 2 }),
      elsewhere: thread('elsewhere', { cwd: '/other/Sage', updatedAt: 1 }),
    },
    worktreeOf: { 'acp-one': real },
    prefs: { sidebarFolders: [alias, real] },
  });
  fx.canonicalPaths = async (paths) => identities(paths);
  const { get, view } = await probe();
  try {
    assert.deepEqual(
      get().groups.map((g: any) => [g.path, g.threads.map((t: any) => t.id)]),
      [
        [alias, ['codex', 'claude-one', 'acp-one']],
        ['/other/Sage', ['elsewhere']],
      ],
    );
    assert.equal(getState().threads.codex.cwd, alias);
    assert.equal(getState().threads['acp-one'].cwd, '/worktrees/task');
    assert.ok(getState().prefs.sidebarFolders.includes(real), 'existing alias preferences remain intact');
  } finally {
    await view.unmount();
  }
});

test('saved aliases keep every project assignment in the representative group', async () => {
  reset({
    savedProjects: [
      project('old', alias),
      project('new', real),
      project('third', '/third-alias'),
      { id: 'empty', name: 'Empty', roots: [] },
    ],
    threadOrder: ['codex', 'claude', 'acp'],
    threads: {
      codex: thread('codex', { projectId: 'old', updatedAt: 3 }),
      claude: thread('claude', { projectId: 'new', updatedAt: 2 }),
      acp: thread('acp', { cwd: '/worktree', updatedAt: 1 }),
    },
    worktreeOf: { acp: real },
    prefs: { sidebarFolders: [real, alias] },
  });
  fx.canonicalPaths = async (paths) => ({ ...identities(paths), '/third-alias': real });
  const { get, view } = await probe();
  try {
    assert.deepEqual(
      get().groups.map((g: any) => [g.id, g.threads.map((t: any) => t.id)]),
      [
        ['old', ['codex', 'claude', 'acp']],
        ['empty', []],
      ],
    );
    assert.deepEqual(
      getState().savedProjects.map((p: any) => p.id),
      ['old', 'new', 'third', 'empty'],
    );
    assert.deepEqual(get().groups[0].projectIds, ['old', 'new', 'third']);
  } finally {
    await view.unmount();
  }
});

test('the sidebar removal action retires every saved alias of the combined row', async () => {
  reset({
    savedProjects: [project('old', alias, 'Sage'), project('new', real, 'Sage')],
    threadOrder: ['chat'],
    threads: { chat: thread('chat', { projectId: 'old' }) },
  });
  fx.canonicalPaths = async (paths) => identities(paths);
  const previous = globalThis.confirm;
  globalThis.confirm = () => true;
  const view = await mountSidebar();
  try {
    assert.equal(view.$$('.project-row').length, 1);
    await mouse(view.$('.project-row'), 'contextmenu');
    await click(view.$$('[data-menu] button').find((b) => b.textContent?.includes('Remove from sidebar'))!);
    assert.deepEqual(named('deleteProject'), [['old'], ['new']]);
  } finally {
    globalThis.confirm = previous;
    await view.unmount();
  }
});

test('dragging a combined group preserves its identity, collapse and order through main refresh and restart', async () => {
  const local = projectsStore.normalize({
    projects: [
      { id: 'old', name: 'Original', path: alias },
      { id: 'new', name: 'Alias', path: real },
      { id: 'other', name: 'Other', path: '/other' },
    ],
  });
  const saved = (state: any) => state.projects.map((p: any) => project(p.id, p.path, p.name));
  reset({
    savedProjects: saved(local),
    threadOrder: ['inOld', 'inOther'],
    threads: { inOld: thread('inOld', { projectId: 'old' }), inOther: thread('inOther', { projectId: 'other' }) },
    collapsedProjects: { old: true },
    prefs: { projectSort: 'custom', sidebarProjectOrder: ['old', 'other'] },
  });
  fx.canonicalPaths = async (paths) => identities(paths);
  const view = await mountSidebar();
  const rows = () => view.$$('.project-row');
  await drag(rows()[1], 'drop', { data: { 'text/x-codex-project': 'old' }, clientY: 3 });
  assert.deepEqual(named('moveProject'), [['old', null]]);
  const moved = projectsStore.moveProject(local, 'old', null);
  await update({ ...getState(), savedProjects: saved(moved) });
  assert.deepEqual(
    rows().map((row) => row.querySelector('.side-row-label')?.textContent),
    ['Other', 'Original'],
  );
  assert.equal(rows()[1].getAttribute('aria-expanded'), 'false');
  assert.deepEqual(getState().prefs.sidebarProjectOrder, ['other', 'old']);
  const persisted = getState();
  await view.unmount();
  reset(persisted);
  fx.canonicalPaths = async (paths) => identities(paths);
  const restarted = await probe();
  assert.deepEqual(
    restarted.get().groups.map((g: any) => g.id),
    ['other', 'old'],
  );
  await restarted.view.unmount();
});

test('the representative keeps its pin and manual chat order when saved aliases refresh in reverse order', async () => {
  reset({
    savedProjects: [project('old', alias), project('new', real)],
    threadOrder: ['first', 'second'],
    threads: { first: thread('first', { projectId: 'old' }), second: thread('second', { projectId: 'new' }) },
    prefs: {
      sidebarProjectOrder: ['old', 'new'],
      pinnedProjects: ['old'],
      chatSort: 'manual',
      chatOrder: { old: ['second', 'first'], new: ['first', 'second'] },
    },
  });
  fx.canonicalPaths = async (paths) => identities(paths);
  const { get, view } = await probe();
  await update({ ...getState(), savedProjects: [...getState().savedProjects].reverse() });
  assert.equal(get().groups[0].id, 'old');
  assert.deepEqual(
    get().groups[0].threads.map((t: any) => t.id),
    ['second', 'first'],
  );
  assert.deepEqual(getState().prefs.pinnedProjects, ['old']);
  await view.unmount();
});

test('hiding either alias hides both; aliases of home and projectless folders stay in Recents', async () => {
  reset({
    home: '/home',
    threadOrder: ['alias', 'real', 'home', 'projectless'],
    threads: {
      alias: thread('alias', { cwd: alias }),
      real: thread('real', { cwd: real }),
      home: thread('home', { cwd: '/home-alias' }),
      projectless: thread('projectless', { cwd: '/task-alias' }),
    },
    prefs: { sidebarFolders: [real], hiddenFolders: [alias], projectlessFolder: '/tasks' },
  });
  fx.canonicalPaths = async (paths) => ({ ...identities(paths), '/home-alias': '/home', '/task-alias': '/tasks/day/task' });
  const { get, view } = await probe();
  try {
    assert.deepEqual(get().groups, []);
    assert.equal(get().recents.length, 4);
  } finally {
    await view.unmount();
  }
});

test('retired path reads cannot publish success or rejection into a replacement read', async () => {
  reset({ threadOrder: ['chat'], threads: { chat: thread('chat', { cwd: alias }) } });
  const reads = controlledReads<Record<string, string>>();
  const requested: string[][] = [];
  fx.canonicalPaths = (paths) => (requested.push(paths), reads.read());
  const { get, view } = await probe();
  assert.deepEqual(prefsCalls(), [], 'pending aliases are not persisted');
  await update({ ...getState(), threads: { chat: thread('chat', { cwd: real }) } });
  await act(async () => reads.requests[0].resolve(identities(requested[0])));
  assert.deepEqual(prefsCalls(), [], 'retired success cannot mark the replacement ready');
  await update({ ...getState(), threads: { chat: thread('chat', { cwd: '/replacement' }) } });
  await act(async () => reads.requests[1].reject(new Error('retired rejection')));
  assert.deepEqual(prefsCalls(), [], 'retired rejection cannot mark the replacement ready');
  await act(async () => reads.requests[2].resolve(identities(requested[2])));
  assert.deepEqual(
    get().groups.map((g: any) => g.path),
    ['/replacement'],
  );
  await view.unmount();
  for (const reject of [false, true]) {
    reset({ threadOrder: ['chat'], threads: { chat: thread('chat', { cwd: alias }) } });
    fx.canonicalPaths = (paths) => (requested.push(paths), reads.read());
    const retired = await probe();
    await retired.view.unmount();
    const pending = reads.requests.at(-1)!;
    await act(async () => (reject ? pending.reject(new Error('unmounted')) : pending.resolve(identities(requested.at(-1)!))));
    assert.deepEqual(prefsCalls(), [], 'disposed navigation cannot publish');
  }
});

test('a newer resolution survives older completion and current IPC failures keep folders retryable', async () => {
  reset({ threadOrder: ['chat'], threads: { chat: thread('chat', { cwd: alias }) } });
  const reads = controlledReads<Record<string, string>>();
  const requested: string[][] = [];
  fx.canonicalPaths = (paths) => (requested.push(paths), reads.read());
  const { get, view } = await probe();
  await update({ ...getState(), threads: { chat: thread('chat', { cwd: real }) } });
  await act(async () => reads.requests[1].resolve(identities(requested[1])));
  await act(async () => reads.requests[0].resolve({ [alias]: '/incorrect' }));
  assert.deepEqual(
    get().groups.map((g: any) => g.path),
    [real],
  );
  await view.unmount();
  reset({ threadOrder: ['chat'], threads: { chat: thread('chat', { cwd: alias }) } });
  fx.canonicalPaths = async () => {
    throw new Error('IPC failed');
  };
  const retry = await probe();
  assert.deepEqual(
    retry.get().groups.map((g: any) => g.path),
    [alias],
  );
  fx.canonicalPaths = async (paths) => identities(paths);
  await update({ ...getState(), threads: { ...getState().threads, next: thread('next', { cwd: real }) }, threadOrder: ['chat', 'next'] });
  assert.equal(retry.get().groups.length, 1);
  assert.equal(retry.get().groups[0].threads.length, 2);
  await retry.view.unmount();
});

test('malformed identity replies fall back to lexical grouping without discarding chats', async () => {
  for (const response of [null, [], {}, { [alias]: 1 }, { [alias]: '' }, { [alias]: 'relative' }]) {
    reset({ threadOrder: ['chat'], threads: { chat: thread('chat', { cwd: alias }) } });
    fx.canonicalPaths = async () => response as any;
    const { get, view } = await probe();
    assert.deepEqual(
      get().groups.map((g: any) => g.path),
      [alias],
    );
    assert.equal(get().recents.length, 1);
    await view.unmount();
  }
});

test('failed or malformed alias resolutions never persist inferred folder or order keys', async () => {
  for (const response of ['reject', null, {}, { [alias]: 7 }]) {
    reset({ threadOrder: ['one', 'two'], threads: { one: thread('one', { cwd: alias }), two: thread('two', { cwd: real }) } });
    fx.canonicalPaths = async () => {
      if (response === 'reject') throw new Error('unavailable');
      return response as any;
    };
    const { get, view } = await probe();
    assert.equal(get().groups.length, 2, 'lexical fallback remains visible');
    assert.deepEqual(prefsCalls(), [], 'unresolved aliases cannot become persisted groups');
    await view.unmount();
  }
});

test('a new folder identity read keeps the last resolved aliases, so a saved project never shows a second row meanwhile', async () => {
  reset({
    savedProjects: [project('saved', alias, 'Sage')],
    threadOrder: ['codex'],
    threads: { codex: thread('codex', { cwd: real }) },
    prefs: {},
  });
  fx.canonicalPaths = async (paths) => identities(paths);
  const { get, view } = await probe();
  try {
    assert.deepEqual(
      get().groups.map((g: any) => g.id),
      ['saved'],
    );
    const remembered = prefsCalls().length;
    const next = controlledReads<Record<string, string>>();
    const requested: string[][] = [];
    fx.canonicalPaths = (paths) => (requested.push(paths), next.read());
    await update({
      ...getState(),
      threadOrder: ['codex', 'late'],
      threads: { ...getState().threads, late: thread('late', { cwd: '/elsewhere/late' }) },
    });
    assert.equal(next.requests.length, 1, 'the changed folder set is read again');
    assert.deepEqual(
      get().groups.map((g: any) => [g.id, g.threads.map((t: any) => t.id)]),
      [
        ['saved', ['codex']],
        [null, ['late']],
      ],
      'while the read is pending, the earlier answer still joins the alias to the saved project',
    );
    assert.equal(prefsCalls().length, remembered, 'nothing more is remembered before the read lands');
    await act(async () => next.requests[0].resolve(identities(requested[0])));
  } finally {
    await view.unmount();
  }
});

test('a failed folder identity read keeps the last resolved aliases and remembers nothing', async () => {
  reset({
    savedProjects: [project('saved', alias, 'Sage')],
    threadOrder: ['codex'],
    threads: { codex: thread('codex', { cwd: real }) },
    prefs: {},
  });
  fx.canonicalPaths = async (paths) => identities(paths);
  const { get, view } = await probe();
  try {
    const remembered = prefsCalls().length;
    fx.canonicalPaths = async () => {
      throw new Error('denied');
    };
    await update({
      ...getState(),
      threadOrder: ['codex', 'late'],
      threads: { ...getState().threads, late: thread('late', { cwd: '/x' }) },
    });
    assert.deepEqual(
      get().groups.map((g: any) => g.id),
      ['saved', null],
    );
    assert.equal(prefsCalls().length, remembered);
  } finally {
    await view.unmount();
  }
});
