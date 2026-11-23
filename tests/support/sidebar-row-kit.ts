// Fake read, navigation and activity boundaries for tests of production sidebar rows.
import { mock } from 'node:test';
import type { Thread } from '../../src/store/types.ts';
import type { ThreadPullRequest } from '../../src/lib/threadPullRequest.ts';
import { installNativeStub } from './ports/native.ts';
import { stubStore } from './stubs.ts';

export async function sidebarRowKit() {
  const kit = {
    result: null as ThreadPullRequest | null,
    working: false,
    speaking: false,
    machineLine: null as { id: string; name: string; word: string | null } | null,
  };
  const opened: string[] = [];
  const navigated: string[] = [];
  const reads: unknown[][] = [];

  const state = { pinned: {}, prefs: {}, threadOrder: [], conn: 'ready', runtime: {} };
  stubStore({
    useStore: (select: (s: typeof state) => unknown) => select(state),
    nativeOf: (id: string) => id,
    threadTitle: (thread: Thread) => thread.name,
    ELSEWHERE_LABEL: {},
    archiveThread: async () => {},
    deleteThread: async () => {},
    renameThread: async () => {},
    forkThread: async () => {},
    setState: () => {},
    toast: () => {},
    toastFailure: () => () => {},
  });
  installNativeStub({});
  mock.module('../../src/session/pullRequestReader.ts', {
    namedExports: {
      readPullRequest: Object.assign(async (...args: unknown[]) => (reads.push(args), kit.result), { known: () => undefined }),
    },
  });
  mock.module('../../src/session/open.ts', {
    namedExports: { openLink: (url: string) => opened.push(url), revealPath: () => {}, openInApp: () => {}, showInFinder: () => {} },
  });
  mock.module('../../src/session/openChat.ts', {
    namedExports: { OPEN_IN: {}, openChat: (id: string) => navigated.push(id), openChatWhere: () => 'here' },
  });
  mock.module('../../src/harness/registry.ts', { namedExports: { resumeCommandFor: () => null } });
  mock.module('../../src/components/harnessPicker/HarnessPicker.tsx', { namedExports: { ThreadHarnessBadge: () => null } });
  const { ThreadMachineLine } = await import('../../src/components/sidebar/ThreadMachineLine.tsx');
  mock.module('../../src/components/sidebar/ThreadMachineLine.tsx', {
    namedExports: {
      useRowMachineLine: () => kit.machineLine,
      ThreadMachineLine,
    },
  });
  mock.module('../../src/components/thread/GoalBar.tsx', { namedExports: { GoalMark: () => null } });
  mock.module('../../src/lib/sideSessions.ts', {
    namedExports: { useOrchestration: () => ({ queue: [], children: {} }), linkedChildren: () => [] },
  });
  mock.module('../../src/session/sidebarShortcuts.tsx', { namedExports: { SidebarChatShortcut: () => null } });
  mock.module('../../src/session/voice.ts', { namedExports: { useVoice: () => kit.speaking } });
  mock.module('../../src/session/useChatRowState.ts', {
    namedExports: { useChatRowState: () => ({ state: kit.working ? 'working' : 'idle' }) },
  });
  const { ThreadRow } = await import('../../src/components/sidebar/ThreadRow.tsx');
  return Object.assign(kit, { opened, navigated, reads, state, ThreadRow });
}
