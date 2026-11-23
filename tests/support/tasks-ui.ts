// Shared task UI store, transport boundaries and rendering fixture for cards and output ownership.
import { beforeEach, afterEach } from 'node:test';
import { window } from './dom.ts';
import { fakeStore, iconStubs, mockSource, taggedIcon, stubStore, stubSlice } from './stubs.ts';
import { createElement as h, act } from 'react';
import { installNativeStub } from './ports/native.ts';

const app = fakeStore<any>({ paneTabs: [], paneActive: '', diffPanel: { open: false }, paneFull: false, runtime: {} });
const sessions = fakeStore<any>({});
const EMPTY = { tasks: [], approvals: [] };
const calls: any[][] = [];
const rec =
  (name: string) =>
  (...a: any[]) => {
    calls.push([name, ...a]);
  };
stubStore({
  useStore: app.useStore,
  setState: app.setState,
  closePaneTab: rec('closePaneTab'),
  stopAllTasks: rec('stopAllTasks'),
});
stubSlice('src/store/panes.ts', {
  popPaneView: rec('popPaneView'),
  openAgentPage: rec('openAgentPage'),
  toggleTasksPane: rec('toggleTasksPane'),
});
mockSource('src/store/session/useSession.ts', {
  useSession: (id: string) => sessions.useStore((s: any) => (id && s[id]) || EMPTY),
  useSessionField: (id: any, pick: any) =>
    pick((((id: string) => sessions.useStore((s: any) => (id && s[id]) || EMPTY)) as (id: any) => any)(id)),
});
mockSource('src/components/markdown/Markdown.tsx', { CodeBlock: (p: any) => h('pre', { 'data-code': p.code, 'data-lang': p.lang }) });
mockSource('src/components/agents/AgentPage.tsx', {
  AgentPage: (p: any) => h('div', { 'data-agent': p.agentKey, 'data-chat': p.chatId, 'data-cwd': p.cwd }),
});
// the real Collapse animates for 200 ms and unmounts later; here an open card or section shows its content at once
mockSource('src/components/ui/Presence.tsx', { Collapse: ({ open, children }: any) => (open ? children : null) });
installNativeStub({
  win: { open: (hash: string) => calls.push(['winOpen', hash]) },
  // no linked sessions: the list reads them to place the chat's sessions section
  orchestration: {
    snapshot: async () => ({ children: {}, deliveries: {}, proposals: {}, queue: [], plans: {}, wrapUps: {} }),
    onChanged: () => () => {},
  },
});
mockSource('src/components/ui/icons.tsx', iconStubs(taggedIcon));
// the chat's sessions section (its own test: tests/taskSessions.test.ts); here a marker and the chats each chat started
const startedChats: Record<string, string[]> = {};
mockSource('src/components/tasks/TaskSessions.tsx', {
  useStartedBy: (chatId: string) => startedChats[chatId] ?? [],
  TaskSessions: (p: any) => h('div', { 'data-sessions': p.chatId }),
});
const scrolling = await import('../../src/lib/streamScroll.ts');
const outputObservers: { scroll: HTMLElement; follows: () => boolean }[] = [];
mockSource('src/lib/streamScroll.ts', {
  ...scrolling,
  observeBottom: (scroll: HTMLElement, content: Element, follows: () => boolean, followed?: () => void) => {
    outputObservers.push({ scroll, follows });
    return scrolling.observeBottom(scroll, content, follows, followed);
  },
});

const { createRoot } = await import('react-dom/client');
const mounted = new Map<ReturnType<typeof createRoot>, { remove(): void }>();
const B = await import('../../src/store/backgroundTasks.ts');
const { TaskList } = await import('../../src/components/tasks/TaskList.tsx');
const { TasksTab } = await import('../../src/components/tasks/TasksTab.tsx');
const { TaskEventCard } = await import('../../src/components/tasks/TaskEventCard.tsx');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const task = (id: string, o: object = {}): any => ({
  id,
  type: 'local_bash',
  description: id,
  status: 'running',
  summary: null,
  toolUseId: null,
  subagentType: null,
  workflowName: null,
  parentTaskId: null,
  ambient: false,
  ...o,
});

async function mount(el: any) {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  mounted.set(root, host);
  await act(() => root.render(el));
  return {
    host,
    $: (s: string) => host.querySelector(s) as any,
    $$: (s: string) => [...host.querySelectorAll(s)] as any[],
    rerender: (e: any) => act(() => root.render(e)),
    unmount: async () => {
      mounted.delete(root);
      await act(() => root.unmount());
      host.remove();
    },
  };
}
const click = (el: any) => act(() => el.click());
const setTasks = (chat: string, tasks: any[], approvals: any[] = []) => act(() => sessions.set({ [chat]: { tasks, approvals } }));
const text = (el: any) => el?.textContent ?? '';
const byText = (host: any, sel: string, t: string) => [...host.querySelectorAll(sel)].find((e: any) => e.textContent === t) as any;

beforeEach(() => {
  calls.length = 0;
  outputObservers.length = 0;
  app.reset({ paneTabs: [], paneActive: '', diffPanel: { open: false }, paneFull: false, runtime: {} });
  B.setTaskStopperResolver(() => null);
  B.setTaskOutputReaderResolver(() => null);
});

afterEach(async () => {
  for (const [root, host] of mounted) {
    await act(() => root.unmount());
    host.remove();
  }
  mounted.clear();
});

export {
  startedChats,
  window,
  h,
  act,
  app,
  sessions,
  EMPTY,
  calls,
  B,
  TaskList,
  TasksTab,
  TaskEventCard,
  sleep,
  task,
  mount,
  click,
  setTasks,
  text,
  byText,
  outputObservers,
};
