// Pending project placement keeps captured local ids separate from native ids, including after project removal.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { loadStore, impl, resetAll } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, resetState } = await loadStore();
await import('./support/dom.ts');
const { useProjectGroups } = await import('../src/components/sidebar/projectGroups.ts');
const { showChatStart, useChatStarts } = await import('../src/lib/chatStarts.ts');

for (const survivingAlias of [false, true]) {
  test(`a removed pending project cannot match an unrelated native id${survivingAlias ? ', even through a canonical alias' : ''}`, async () => {
    resetState();
    resetAll();
    useChatStarts.setState([], true);
    const captured = { id: 'p', codexId: 'original-native', name: 'Original', roots: [{ path: '/link' }] };
    const unrelated = { id: 'other', codexId: 'p', name: 'Unrelated', roots: [{ path: '/unrelated' }] };
    const alias = { id: 'alias', codexId: 'alias-native', name: 'Alias', roots: [{ path: '/work/project' }] };
    const remaining = survivingAlias ? [unrelated, alias] : [unrelated];
    impl['projects.canonicalPaths'] = async (paths: string[]) =>
      Object.fromEntries(paths.map((p) => [p, p === '/link' ? '/work/project' : p]));
    store.useStore.setState({
      home: '/home',
      savedProjects: [captured, ...remaining],
      threads: { native: { id: 'native', projectId: 'p', cwd: '/unrelated', updatedAt: 1 } },
      threadOrder: ['native'],
      prefs: { sidebarProjectOrder: ['p', 'other', 'alias'] },
    });
    let groups!: ReturnType<typeof useProjectGroups>;
    function Probe() {
      groups = useProjectGroups();
      return null;
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const finish = showChatStart('Captured submission', { cwd: '/link', projectId: 'p' });
    try {
      await act(async () => root.render(createElement(Probe)));
      assert.equal(groups.groups.find((g) => g.id === 'p')!.starting!.length, 1);
      await act(async () => store.useStore.setState({ savedProjects: remaining }));
      const other = groups.groups.find((g) => g.id === 'other')!;
      assert.deepEqual(other.starting ?? [], [], 'a removed local id is never reinterpreted as a native project id');
      assert.deepEqual(
        other.threads.map((t) => t.id),
        ['native'],
        'native chats retain their native-id lookup',
      );
      const owner = groups.groups.find((g) => g.starting?.length)!;
      assert.equal(owner.id, survivingAlias ? 'alias' : null);
      assert.equal(owner.path, survivingAlias ? '/work/project' : '/link');
      assert.equal(useChatStarts.getState()[0].projectId, 'p', 'placement does not rewrite the captured submission');
      assert.equal(store.useStore.getState().prefs.sidebarFolders?.includes('/link') ?? false, false);
    } finally {
      await act(async () => {
        root.unmount();
        finish();
      });
      host.remove();
    }
  });
}
