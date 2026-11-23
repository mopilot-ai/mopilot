// Store, module and presentation stand-ins for the real control narration and title-tab badge UI tests.
import * as react from 'react';
import { iconStubs, mockSource, popoverStubs, taggedIcon, withStoreSlices } from './stubs.ts';
import { installNativeStub } from './ports/native.ts';

export async function controlNarrationFixture({ realImages = false } = {}) {
  const fixture: any = {
    state: {},
    listeners: new Set<Function>(),
    calls: [] as any[],
    subscribe(fn: Function) {
      fixture.listeners.add(fn);
      return () => fixture.listeners.delete(fn);
    },
    update(patch: any) {
      fixture.state = { ...fixture.state, ...patch };
      for (const fn of fixture.listeners) fn();
    },
  };

  const f = fixture;
  const h = react.createElement;
  const noop = (names: string) =>
    Object.fromEntries(
      names.split(',').map((n) => [
        n.trim(),
        (...a: any[]) => {
          f.calls.push([n.trim(), ...a]);
        },
      ]),
    );
  const useStore = Object.assign((s: any) => s(react.useSyncExternalStore(f.subscribe, () => f.state)), { getState: () => f.state });
  const id = (p: any) => p;
  const nul = () => null;
  // acpHarnessOf: a linked session's card reads its tokens through src/store/contextUsage.ts
  const acpTypes = { isAcpThread: (x: string) => x.startsWith('acp:'), acpHarnessOf: nul };
  /** Stubs for what Items.tsx and TitleBar.tsx import; anything not here is the real file. */
  // the real keyboard activation of the title bar's tabs, loaded before its module is stubbed
  const { onActivate, cancelOnEscape } = await import('../../src/lib/focus.ts');
  const stubs: Record<string, Record<string, unknown>> = {
    'lib/paths.ts': { absPath: id, fileName: id, relPath: id, basename: (p: any) => String(p).split('/').pop() },
    'lib/platform.ts': { platform: 'darwin', isWin: false, shellScript: () => '' },
    'session/open.ts': noop('openMessageLink,showInFinder,openInApp,openLink,revealPath'),
    'components/ui/Presence.tsx': {
      Collapse: ({ open, children }: any) => (open ? children : null),
      // no exits here: every tab shown as it is (the strip's motion is tests/titleBarUI.test.ts's)
      usePresentList: (items: any[], keyOf: (i: any) => string) => items.map((item) => ({ item, key: keyOf(item), leaving: false })),
    },
    'components/markdown/Markdown.tsx': {
      Markdown: ({ text }: any) => h('div', null, text),
      CodeBlock: ({ code }: any) => h('pre', null, code),
    },
    'session/clipboard.ts': { copyText: () => {} },
    // the title bar's account warning (tests/titleBarUI.test.ts covers it)
    'session/profileAttention.ts': { useProfileAttention: () => false },
    'components/thread/arrival.tsx': { useSmoothText: (t: any) => t },
    'components/thread/PlanCard.tsx': { PlanCard: nul },
    // Native control narration does not render linked cards; their actual states have dedicated UI tests.
    'components/thread/TaskProposalCard.tsx': { TaskProposalCard: nul, TurnSuggestions: nul },
    'components/tasks/TaskEventCard.tsx': { TaskEventCard: nul },
    // the status line's counts read linked sessions and PRs (tests/sessionsCount.test.ts covers them)
    'components/tasks/SessionsCount.tsx': { InlineCounts: nul, StatusCounts: nul },
    'components/thread/ReviewCard.tsx': { ReviewCard: nul },
    'components/thread/RunningCommand.tsx': {
      RunningCommand: ({ label, children }: any) => h('div', { className: 'running' }, label, children),
    },
    'components/thread/ClaudeActivity.tsx': {
      // the row's words only: what it opens to is tested in tests/liveReasoningUI.test.ts
      ClaudeActivity: ({ label }: any) => h('div', { className: 'claude-activity' }, label),
    },
    'components/ui/ImageLightbox.tsx': { ZoomableImage: (p: any) => h('img', { className: p.className, src: p.src, alt: p.alt }) },
    'components/diff/DiffView.tsx': { fileChangeToDiff: (c: any) => ({ added: 1, removed: 0, path: c.path }), InlineDiff: nul },
    store: {
      useStore,
      setState: (p: any) => f.update(p),
      ...noop(
        'openSubThread,nativeOf,navigate,goBack,goForward,archiveThread,forkThread,openSideChat,compactThread,toast,toastFailure,sendOrDraft,openChanges,openPaneTab,closePaneTab,closeOtherPaneTabs,openBrowserTabAfter,renamePaneTab,toggleTasksPane,sendMessage,connect',
      ),
      threadTitle: (t: any) => t?.title || t?.name || 'New chat',
      projectForThread: nul,
      chatOf: (id: string) => f.state.alias?.[id] ?? id,
      limitNoteAction: () => ({ label: 'Continue', run: () => {} }),
    },
    'store/panes.ts': noop('openAgentPage'),
    'store/browserDuplicate.ts': { browserDuplication: { duplicate: noop('duplicate').duplicate } },
    'harness/codexTranslate.ts': { compactionLabel: () => '', spawnedThreads: () => [] },
    'components/ui/icons.tsx': iconStubs(taggedIcon),
    'lib/environments.ts': { resolveEnvironment: async () => ({ actions: [] }) },
    'lib/deepLink.ts': { threadHash: (id: string) => '#' + id },
    'components/ui/Popover.tsx': popoverStubs(),
    'session/transcript.ts': { labelAt: nul, transcriptMarkdown: () => '' },
    'harness/types.ts': { cliSessionId: id, HARNESS_IDS: ['codex', 'claude'], ...acpTypes },
    'harness/registry.ts': { resumeCommandFor: nul },
    'components/sidebar/Sidebar.tsx': { ThreadMenu: nul },
    'components/titleBar/SideChatTitle.tsx': { SideChatTitle: () => h('span', null, 'Side chat') },
    'lib/focus.ts': { isEnter: (e: any) => e.key === 'Enter', onActivate, cancelOnEscape },
  };
  // the bridge, installed in the port the components read (src/lib/native.ts)
  installNativeStub({
    fs: { readImageDataUrl: async () => null },
    win: { toggleMaximize() {} },
    shell: {
      openPath() {},
      openExternal: (u: string) => {
        f.calls.push(['openExternal', u]);
      },
    },
  });
  for (const [rel, exports] of Object.entries(withStoreSlices(stubs))) {
    if (realImages && rel === 'components/ui/ImageLightbox.tsx') continue;
    mockSource(`src/${rel}`, exports);
  }
  return fixture;
}
