// Real store/title selectors keep mounted sidebar and header names current when only a linked chat's metadata changes.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { loadStore } from './support/store-harness.ts';

const { store: S, resetState } = await loadStore();
await import('./support/dom.ts');
const { act, createElement: h, Fragment } = await import('react');
const { createRoot } = await import('react-dom/client');
const { applyChat } = await import('../src/lib/chatMeta.ts');
const nil = () => null;
let rowRenders = 0;
const m = (file: string, exports: Record<string, unknown>) => mock.module(new URL(file, import.meta.url).href, { namedExports: exports });
m('../src/components/sidebar/ThreadMenu.tsx', { ThreadMenu: nil });
m('../src/components/sidebar/ThreadPullRequestBadge.tsx', { ThreadPullRequestBadge: nil });
m('../src/components/sidebar/SidebarInboxCount.tsx', { SidebarInboxCount: nil });
m('../src/components/sidebar/ThreadIndicators.tsx', { ThreadActivityIndicator: nil, ThreadForkIndicator: nil, ThreadVoiceIndicator: nil });
m('../src/components/harnessPicker/HarnessPicker.tsx', { ThreadHarnessBadge: nil });
m('../src/components/thread/GoalBar.tsx', { GoalMark: nil });
m('../src/session/sidebarShortcuts.tsx', { SidebarChatShortcut: nil });
m('../src/components/sidebar/ThreadMachineLine.tsx', {
  ThreadMachineLine: nil,
  useRowMachineLine: () => {
    rowRenders++;
    return null;
  },
});
m('../src/lib/chatMachine.ts', {
  useFolderHere: (_id: string, cwd: string) => cwd,
  usePullRequestFolder: (_id: string, cwd: string) => cwd,
  useChatMachine: () => ({ machine: null }),
  movedOnMachine: () => false,
});
m('../src/session/openChat.ts', { openChat: () => {}, openChatWhere: () => 'here' });
const sideView = { queue: [], children: {} };
m('../src/lib/sideSessions.ts', {
  useOrchestration: () => sideView,
  useOrchestrationSelect: (select: any) => select(sideView),
  orchestrationNow: () => sideView,
  subscribeOrchestration: () => () => {},
});
m('../src/session/harness/claude/desktopLineage.ts', {
  useSidebarLineage: () => ({}),
  useFamilyLineage: () => ({}),
  sidebarLineageNow: () => ({ children: {} }),
  familyLineageNow: () => ({ children: {} }),
  useLineageStamp: () => '',
});
m('../src/lib/sidebarFamilyIndex.ts', { familiesOf: () => ({ descendants: new Map() }) });
m('../src/lib/nestedHidden.ts', { setNestedHidden: () => {}, useNestedHidden: () => false });
m('../src/session/useChatRowState.ts', { useChatRowState: () => ({ state: 'idle' }) });
m('../src/session/shortcutHints.ts', { useShortcutHint: () => () => undefined });
m('../src/session/profileAttention.ts', { useProfileAttention: () => false });
m('../src/components/titleBar/OpenInApps.tsx', { OpenInItems: nil });
m('../src/components/titleBar/ChatUtilityItems.tsx', { ChatUtilityItems: nil });
m('../src/components/titleBar/SideChatTitle.tsx', { SideChatTitle: nil });
m('../src/components/titleBar/PaneTabIcon.tsx', { PaneTabIcon: nil });
m('../src/components/titleBar/PaneTabMenu.tsx', { PaneTabMenu: nil, PaneTabRename: nil, browserTabTitle: () => '' });
m('../src/components/ui/Popover.tsx', {
  Tooltip: ({ children }: any) => children,
  useAnchor: () => ({ open: false, setOpen: () => {} }),
  Menu: nil,
  MenuItem: nil,
  MenuSeparator: nil,
  SubMenu: nil,
});

const { ThreadRow } = await import('../src/components/sidebar/ThreadRow.tsx');
const { TitleBar } = await import('../src/components/titleBar/TitleBar.tsx');

test('a linked session shows its supplied title before any input or generated name, and later native names win', () => {
  resetState();
  const ids = ['codex-child', 'claude:child', 'acp:kimi:child'];
  S.setState({ chatInitialTitles: Object.fromEntries(ids.map((id) => [id, 'Login timing'])) });
  for (const id of ids) {
    assert.equal(S.threadTitle({ id, name: null, preview: '' } as any), 'Login timing');
    assert.equal(S.threadTitle({ id, name: null, preview: 'Background from another session' } as any), 'Login timing');
    assert.equal(S.threadTitle({ id, name: 'Generated title', preview: '' } as any), 'Generated title');
    assert.equal(S.threadTitle({ id, name: 'User rename', preview: '' } as any), 'User rename');
  }
  assert.equal(S.threadTitle({ id: 'unrelated', preview: 'Ordinary chat' } as any), 'Ordinary chat');
  for (const id of ['__proto__', 'constructor', 'toString']) assert.equal(S.threadTitle({ id, preview: '' } as any), 'New chat');
});

for (const id of ['codex-child', 'claude:child', 'acp:kimi:child']) {
  test(`${id}: a metadata-only title update reaches the row and header, and generated/user names still win`, async () => {
    resetState();
    const thread = { id, name: null, preview: '', cwd: '/repo', updatedAt: 1 };
    S.setState({ threads: { [id]: thread }, threadOrder: [id], route: { name: 'thread', id } });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let parentRenders = 0;
    function Names() {
      const current = S.useStore((s: any) => s.threads[id]);
      parentRenders++;
      return h(Fragment, null, h(ThreadRow, { thread: current, active: true }), h(TitleBar));
    }
    const row = () => host.querySelector('[data-sidebar-chat]')?.getAttribute('aria-label');
    const header = () => host.querySelector('.tb-title-text')?.textContent;
    try {
      await act(async () => root.render(h(Names)));
      assert.equal(row(), 'New chat');
      const before = parentRenders;
      await act(async () => {
        S.setState(
          applyChat(S.useStore.getState(), id, { kind: 'codex', segments: null, meta: { initialTitle: 'Task ready now' } } as any),
        );
      });
      assert.equal(parentRenders, before, 'the native thread and its parent did not change');
      assert.deepEqual([row(), header()?.includes('Task ready now')], ['Task ready now', true]);
      const rendered = rowRenders;
      await act(async () => S.setState((s: any) => ({ chatInitialTitles: { ...s.chatInitialTitles, other: 'Another task' } })));
      assert.equal(rowRenders, rendered, 'another chat’s fallback title does not rerender this row');
      for (const name of ['Generated title', 'User rename']) {
        await act(async () => S.setState((s: any) => ({ threads: { ...s.threads, [id]: { ...s.threads[id], name } } })));
        assert.equal(row(), name);
        assert.ok(header()?.includes(name));
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
}
