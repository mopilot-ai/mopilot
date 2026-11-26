// Historical folder discovery preserves the user's custom project placement before and after persistence, on every harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChat, mapsFromSnapshot, type ChatView } from '../src/lib/chatMeta.ts';
import { fx, getState, label, mountSidebar, prefsCalls, probe, project, reset, thread, update } from './support/shell-sidebar-kit.ts';

const knownOrder = ['second', 'first', 'retired'];
const keys = (get: Awaited<ReturnType<typeof probe>>['get']) => get().groups.map(label);

test('unsaved folder headings stay put while a rewind reorders their chats and ranks are still unavailable', async () => {
  const older = 'claude:older';
  const updated = 'claude:updated';
  reset({
    threadOrder: [older, updated, 'other-folder'],
    threads: {
      [older]: thread(older, { cwd: '/private/tmp/b', updatedAt: 1 }),
      [updated]: thread(updated, { cwd: '/tmp/b', updatedAt: 2 }),
      'other-folder': thread('other-folder', { cwd: '/srv/a', updatedAt: 3 }),
    },
  });
  fx.applyPrefs = false;
  fx.canonicalPaths = async () => ({ '/private/tmp/b': '/tmp/b', '/tmp/b': '/tmp/b', '/srv/a': '/srv/a' });
  const map = mapsFromSnapshot(null);
  const rewind = { segments: null, meta: { rewoundAt: 4 } } as ChatView;
  const { get, view } = await probe();
  try {
    assert.deepEqual(
      get().groups.map((group) => group.name),
      ['a', 'b'],
    );
    assert.equal(get().groups[1].threads[0].id, updated);
    await update({ ...getState(), ...applyChat(map, older, rewind) });
    assert.deepEqual(
      get().groups.map((group) => group.name),
      ['a', 'b'],
    );
    assert.equal(get().groups[1].threads[0].id, older);
    await update({ ...getState(), ...mapsFromSnapshot({ chats: { [older]: rewind }, newer: [] }) });
    assert.equal(get().groups[1].threads[0].id, older);
  } finally {
    await view.unmount();
  }
});

test('explicit project sorts retain an existing folder order on ties', async () => {
  const paths = ['/work/z/folder', '/work/a/folder'];
  for (const projectSort of ['name', 'updated']) {
    reset({
      prefs: { projectSort, sidebarFolders: paths },
      threadOrder: ['first', 'second'],
      threads: {
        first: thread('first', { cwd: paths[0], updatedAt: 1 }),
        second: thread('second', { cwd: paths[1], updatedAt: 1 }),
      },
    });
    const { get, view } = await probe();
    try {
      assert.deepEqual(keys(get), paths);
    } finally {
      await view.unmount();
    }
  }
});

test('a reopened window also uses shared rewind activity in the ungrouped list', async () => {
  reset({
    prefs: { sidebarOrganize: 'list' },
    threadOrder: ['old', 'recent'],
    threads: { old: thread('old', { cwd: '/p', updatedAt: 1 }), recent: thread('recent', { cwd: '/p', updatedAt: 2 }) },
    chatRewoundAt: { old: 3 },
  });
  const view = await mountSidebar();
  try {
    assert.deepEqual(
      [
        ...view.$('[aria-label="Project sidebar options"]').closest('.sidebar-section')!.querySelectorAll('.thread-row .side-row-label'),
      ].map((row) => row.textContent),
      ['Chat old', 'Chat recent'],
    );
  } finally {
    await view.unmount();
  }
});

function initial() {
  reset({
    savedProjects: [project('first'), project('second')],
    threadOrder: ['active'],
    threads: { active: thread('active', { projectId: 'first', updatedAt: 100 }) },
    prefs: { projectSort: 'custom', sidebarProjectOrder: [...knownOrder], sidebarFolders: [] },
  });
}

for (const id of ['old-codex', 'claude:old-session', 'acp:kimi:old-session']) {
  test(`${id}: loading old history never flashes its folder above the custom order while persistence waits`, async () => {
    initial();
    const { get, view } = await probe();
    try {
      assert.deepEqual(keys(get), ['second', 'first']);
      fx.applyPrefs = false;
      await update({
        ...getState(),
        threadOrder: [...getState().threadOrder, id],
        threads: { ...getState().threads, [id]: thread(id, { cwd: '/history/old', updatedAt: 1 }) },
      });
      assert.deepEqual(keys(get), ['second', 'first', '/history/old']);
    } finally {
      await view.unmount();
    }
  });

  test(`${id}: history pages append folders once, preserve a later user reorder, and survive reload`, async () => {
    initial();
    const { get, view } = await probe();
    try {
      await update({
        ...getState(),
        threadOrder: [...getState().threadOrder, id],
        threads: { ...getState().threads, [id]: thread(id, { cwd: '/history/old', updatedAt: 1 }) },
      });
      assert.deepEqual(prefsCalls().at(-1)?.sidebarProjectOrder, [...knownOrder, '/history/old']);
      assert.deepEqual(keys(get), ['second', 'first', '/history/old']);
      // A user drag between pages remains the owner of the known positions.
      const reordered = ['/history/old', 'first', 'second', 'retired'];
      await update({ ...getState(), prefs: { ...getState().prefs, sidebarProjectOrder: reordered } });
      const later = `${id}:older`;
      await update({
        ...getState(),
        threadOrder: [...getState().threadOrder, later],
        threads: { ...getState().threads, [later]: thread(later, { cwd: '/history/older', updatedAt: 0 }) },
      });
      assert.deepEqual(getState().prefs.sidebarProjectOrder, [...reordered, '/history/older']);
      assert.deepEqual(keys(get), ['/history/old', 'first', 'second', '/history/older']);
      assert.deepEqual(getState().prefs.sidebarFolders, ['/history/old', '/history/older']);
      const writes = prefsCalls().length;
      await update({ ...getState() });
      assert.equal(prefsCalls().length, writes, 'rediscovery is idempotent');
    } finally {
      await view.unmount();
    }
    const reloaded = await probe();
    try {
      assert.deepEqual(keys(reloaded.get), ['/history/old', 'first', 'second', '/history/older']);
    } finally {
      await reloaded.view.unmount();
    }
  });
}
