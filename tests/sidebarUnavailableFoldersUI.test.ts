// Unavailable sidebar groups disappear without losing their chats, saved identities or recovery metadata.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { fx, reset, getState, mountSidebar, project, thread, update, flush, probe, named } from './support/shell-sidebar-kit.ts';
import { useChatStarts } from '../src/lib/chatStarts.ts';
import { mapsFromSnapshot } from '../src/lib/chatMeta.ts';
import { FOLDER_RECHECK_MS } from '../src/components/sidebar/useFolderAvailability.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { canonicalPaths, folderAvailability } = require('../electron/platform/projectPaths.cjs');

test('private MoMo chats, switched sessions and worktrees never supply local folders, and ownership updates reconcile them', async (t) => {
  reset({
    ...mapsFromSnapshot({
      chats: {
        private: {
          meta: { momo: 'main' },
          segments: [
            { kind: 'codex', nativeId: 'private', start: 0, count: 1 },
            { kind: 'claude', nativeId: 'claude:s9', start: 1, count: null },
          ],
        },
        previous: { meta: { momo: 'previous' }, segments: null },
      },
      newer: [],
    } as any),
    threads: {
      user: thread('user', { cwd: '/public' }),
      private: thread('private', { cwd: '/private/momo' }),
      previous: thread('previous', { cwd: '/private/previous' }),
      'claude:s9': thread('claude:s9', { cwd: '/private/switched', projectId: null, parentThreadId: null, ephemeral: false }),
    },
    threadOrder: ['user', 'private', 'previous', 'claude:s9'],
    worktreeOf: { private: '/private/source', previous: '/private/previous-source', 'claude:s9': '/private/switched-source' },
  });
  const canonical: string[][] = [];
  fx.canonicalPaths = async (paths) => {
    canonical.push(paths);
    return Object.fromEntries(paths.map((p) => [p, p]));
  };
  const p = await probe();
  t.after(() => p.view.unmount());
  const privatePaths = ['/private/momo', '/private/source', '/private/previous-source', '/private/previous'];
  const switchedPaths = ['/private/switched', '/private/switched-source'];
  assert.deepEqual(
    canonical.flat().filter((path) => [...privatePaths, ...switchedPaths].includes(path)),
    [],
  );
  assert.deepEqual(named('folderAvailability'), [[['/public']]]);
  assert.deepEqual(
    p
      .get()
      .recents.map((chat: any) => chat.id)
      .sort(),
    ['user'],
  );
  await update({ ...getState(), segments: {} });
  assert.ok(
    switchedPaths.every((path) => canonical.flat().includes(path)),
    'segment ownership changes restore local candidates',
  );
  assert.ok(named('folderAvailability').at(-1)![0].includes('/private/switched-source'));
  assert.deepEqual(
    canonical.flat().filter((path) => privatePaths.includes(path)),
    [],
  );
  await update({ ...getState(), momoChats: {} });
  assert.ok(
    privatePaths.every((path) => canonical.flat().includes(path)),
    'new ordinary owners restore their folder candidates',
  );
});

test('a missing selected and pinned folder is hidden while its older selected chat remains reachable in Recents', async () => {
  const stale = '/private/tmp/ccprobe/work';
  const chats = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`c${i}`, thread(`c${i}`, { cwd: stale, updatedAt: 10 - i })]));
  reset({
    savedProjects: [project('saved', stale, 'work')],
    threads: chats,
    threadOrder: Object.keys(chats),
    route: { name: 'thread', id: 'c8' },
    prefs: { pinnedProjects: ['saved'], sidebarFolders: [stale], sidebarProjectOrder: ['saved', stale] },
  });
  fx.exists = false;
  const view = await mountSidebar();
  try {
    assert.equal(view.$$('.project-row').length, 0);
    assert.equal(view.$('[data-shortcut-recents] .thread-row.selected')?.textContent?.includes('Chat c8'), true);
    assert.equal(Object.keys(getState().threads).length, 9);
    assert.equal(getState().savedProjects[0].id, 'saved');
    assert.deepEqual(getState().prefs.pinnedProjects, ['saved']);
  } finally {
    await view.unmount();
  }
});

test('saved aliases, discovered and remembered folders hide on recheck and return with pins, order and names intact', async () => {
  reset({
    savedProjects: [project('alias', '/link/repo', 'Repo'), project('real', '/real/repo', 'Repo')],
    threads: { a: thread('a', { projectId: 'real' }), 'claude:b': thread('claude:b', { cwd: '/other/repo' }) },
    threadOrder: ['a', 'claude:b'],
    route: { name: 'home' },
    newChatProjectId: 'real',
    prefs: {
      pinnedProjects: ['real', '/remembered'],
      sidebarFolders: ['/remembered'],
      sidebarProjectOrder: ['alias', 'real', '/remembered', '/other/repo'],
    },
  });
  fx.canonicalPaths = async (paths) => Object.fromEntries(paths.map((p) => [p, p === '/link/repo' ? '/real/repo' : p]));
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const p = await probe();
  try {
    const before = p.get();
    assert.deepEqual(before.groups.find((g: any) => g.id === 'alias').projectIds, ['alias', 'real']);
    const prefs = structuredClone(getState().prefs);
    fx.exists = false;
    await act(async () => mock.timers.tick(FOLDER_RECHECK_MS));
    assert.deepEqual(p.get().listed, []);
    assert.equal(p.get().homeKey, null);
    assert.deepEqual(
      p.get().recents.map((t: any) => t.id),
      before.recents.map((t: any) => t.id),
    );
    assert.deepEqual(getState().prefs, prefs);
    fx.exists = true;
    await act(async () => mock.timers.tick(FOLDER_RECHECK_MS));
    assert.deepEqual(p.get().listed, before.listed);
    assert.equal(p.get().homeKey, 'alias');
  } finally {
    await p.view.unmount();
    mock.timers.reset();
  }
});

test('a missing starting folder keeps its pending chat in Recents, and deleted managed worktrees retain their accessible parent group', async () => {
  const wt = '/home/.mopilot/worktrees/id/repo';
  reset({
    savedProjects: [project('repo', '/repo', 'Repo')],
    threads: { a: thread('a', { cwd: wt }) },
    threadOrder: ['a'],
    worktreeOf: { a: '/repo' },
    route: { name: 'thread', id: 'a' },
  });
  fx.folderAvailability = async (paths) => Object.fromEntries(paths.map((p) => [p, p === '/repo']));
  useChatStarts.setState([{ id: 'starting', name: 'Starting missing chat', cwd: '/gone', projectId: null, updatedAt: 1 }], true);
  const view = await mountSidebar();
  try {
    assert.deepEqual(
      view.$$('.project-row').map((r) => r.getAttribute('aria-label')),
      ['Repo'],
    );
    assert.match(view.$('[data-shortcut-recents]').textContent!, /Starting missing chat/);
    assert.deepEqual(getState().worktreeOf, { a: '/repo' });
    // A new displayed path is unknown while its own check is pending, never hidden by the old path's false answer.
    await update({ ...getState(), savedProjects: [project('repo', '/gone', 'Repo')], worktreeOf: { a: '/gone' } });
    await flush();
    assert.equal(view.$$('.project-row').length, 0);
    let resolve!: (v: Record<string, boolean | null>) => void;
    fx.folderAvailability = () =>
      new Promise((r) => {
        resolve = r;
      });
    await update({ ...getState(), savedProjects: [project('repo', '/new', 'Repo')], worktreeOf: { a: '/new' } });
    assert.equal(view.$$('.project-row').length, 1);
    await act(async () => resolve({ '/new': true, '/gone': false }));
  } finally {
    await act(async () => useChatStarts.setState([], true));
    await view.unmount();
  }
});

test('restoring a real symlink reconciles saved aliases back into one project without changing their IDs', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-alias-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = path.join(dir, 'real');
  const alias = path.join(dir, 'alias');
  fs.mkdirSync(real);
  reset({
    savedProjects: [project('alias', alias, 'Repo'), project('real', real, 'Repo')],
    prefs: { pinnedProjects: ['alias', 'real'] },
  });
  const pending: Promise<unknown>[] = [];
  fx.canonicalPaths = (paths) => {
    const p = canonicalPaths(paths);
    pending.push(p);
    return p;
  };
  fx.folderAvailability = (paths) => {
    const p = folderAvailability(paths);
    pending.push(p);
    return p;
  };
  const settle = async () => {
    let count = -1;
    while (count !== pending.length) {
      count = pending.length;
      await act(async () => {
        await Promise.all(pending);
      });
    }
  };
  const p = await probe();
  try {
    await settle();
    assert.equal(p.get().listed.length, 1);
    fs.symlinkSync(real, alias, 'junction');
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle();
    assert.equal(p.get().listed.length, 1);
    assert.deepEqual(p.get().listed[0].projectIds, ['alias', 'real']);
    assert.deepEqual(
      getState().savedProjects.map((p: any) => p.id),
      ['alias', 'real'],
    );
  } finally {
    await p.view.unmount();
  }
});
