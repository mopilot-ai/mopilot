// Historical folder discovery preserves the user's custom project placement before and after persistence, on every harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fx, getState, label, prefsCalls, probe, project, reset, thread, update } from './support/shell-sidebar-kit.ts';

const knownOrder = ['second', 'first', 'retired'];
const keys = (get: Awaited<ReturnType<typeof probe>>['get']) => get().groups.map(label);

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
