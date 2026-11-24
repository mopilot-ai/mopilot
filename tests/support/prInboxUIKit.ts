// The PR inbox UI tests' fakes (tests/prInboxUI.test.ts, tests/prInboxActionsUI.test.ts): the store, the session
// opener and links, each session's state, each PR as GitHub answers it, the PR monitor and the linked sessions, with
// the helpers that show a family, open the tray and find its buttons.
import { mock } from 'node:test';
import './dom.ts';
import { fakeStore, render, click } from './pages-kit.ts';
import { installNativeStub } from './ports/native.ts';
import { mockSource, stubStore } from './stubs.ts';
const { createElement: h, act } = await import('react');
const store = fakeStore<any>({ runtime: {}, segments: {}, archived: [], claudeArchived: {}, agentTabs: {}, threads: {} });
const sent: unknown[][] = [];
const monitors: Record<string, any> = {};
const snapshots: string[] = [];
const configured: unknown[][] = [];

const failures: string[] = [];
/** what the fakes answer, which a test may change: the send's result, the monitor reads and its configure */
let revision = 0;
export const kit = {
  sendAnswer: true as boolean | void,
  notify: (_v: any) => {},
  listedGate: null as Promise<unknown> | null,
  monitorChanged: (_id: string) => {},
  snapshot: async (id: string): Promise<any> => (snapshots.push(id), monitors[id] ?? null),
  configure: async (...a: unknown[]): Promise<unknown> => (configured.push(a), {}),
};
stubStore({
  useStore: store.useStore,
  navigate: () => {},
  toast: () => {},
  chatKind: () => 'claude',
  chatOf: (id: string) => id,
  nativeOf: (id: string) => id,
  sendOrDraft: async (...a: unknown[]) => (sent.push(a), kit.sendAnswer),
  toastFailure: (what: string) => () => failures.push(what),
});
const chatsOpened: string[] = [];
mock.module('../../src/session/openChat.ts', {
  namedExports: { openChatFrom: (_e: unknown, id: string) => chatsOpened.push(id), openChat: () => {} },
});
const links: string[] = [];
mock.module('../../src/session/open.ts', { namedExports: { openLink: (url: string) => links.push(url) } });
const rows: Record<string, string> = {};
mock.module('../../src/session/useChatRowState.ts', {
  namedExports: {
    useChatRowState: (id: string) => (rows[id] ? { state: rows[id] } : null),
    useChatTurn: () => 'idle',
    retryChatState: async () => {},
  },
});
// each PR's status as GitHub answers it, by link (rejecting for a link set to an Error)
const prs: Record<string, any> = {};
const statusReads: string[] = [];
// every PR each chat's history names, by chat (rejecting for a chat set to an Error)
const listed: Record<string, any> = {};
const listedReads: string[] = [];
mock.module('../../src/session/pullRequestReader.ts', {
  namedExports: {
    readPullRequest: Object.assign(async () => null, {
      status: async (url: string) => {
        statusReads.push(url);
        if (prs[url] instanceof Error) throw prs[url];
        return prs[url];
      },
      known: () => undefined,
      listed: async (id: string) => {
        listedReads.push(id);
        if (kit.listedGate) await kit.listedGate;
        if (listed[id] instanceof Error) throw listed[id];
        return listed[id] ?? [];
      },
    }),
  },
});
mockSource('src/store/session/useSession.ts', { useSession: () => ({ goal: null }), useSessions: () => null, sessionOf: () => ({}) });
mockSource('src/components/thread/GoalBar.tsx', { GoalPill: () => null, goalShown: () => false });

const empty = { children: {}, deliveries: {}, proposals: {}, queue: [], plans: {}, wrapUps: {} };
installNativeStub({
  orchestration: { snapshot: async () => empty, onChanged: (cb: any) => ((kit.notify = cb), () => {}) },
  prMonitor: {
    snapshot: (id: string) => kit.snapshot(id),
    onChanged: (cb: any) => ((kit.monitorChanged = cb), () => {}),
    configure: (...a: unknown[]) => kit.configure(...a),
  },
});
const { ComposerPills } = await import('../../src/components/thread/ComposerPills.tsx');
const { PrCount } = await import('../../src/components/thread/PrCount.tsx');
const { familyOf, familyUrls } = await import('../../src/components/thread/usePrInbox.ts');
const { markWindowReady } = await import('../../src/lib/windowReady.ts');
const { lastAnswers, lastListed } = await import('../../src/lib/prLastAnswer.ts');
markWindowReady();

/** The chat's inbox owner with its status-line count, as ThreadView and its status line mount them. */
const Inbox = ({ threadId }: { threadId: string }) =>
  h('div', null, h(ComposerPills, { threadId, showGoal: false, showInbox: true }), h(PrCount, { chatId: threadId }));

const url = (n: number) => `https://github.com/o/r/pull/${n}`;
const open = (o: any = {}) => ({
  url: '',
  number: 0,
  state: 'open',
  title: 'T',
  details: { checks: 'passing', mergeable: 'MERGEABLE', mergeState: 'CLEAN' },
  ...o,
});
const child = (o: any = {}) => ({
  parentId: 'top',
  name: 'n',
  title: 't',
  harness: null,
  useWorktree: false,
  lastReport: null,
  createdAt: 1,
  ...o,
});
const facts = (n: number) => ({ facts: { pr: { number: n, state: 'OPEN', url: url(n) } } });
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const show = async (children: any, more: any = {}) => {
  // the rows read their states outside the view, and an equal view wakes nobody (#5398): a new revision makes the components read them again
  await act(async () => kit.notify({ ...empty, children, ...more, rev: ++revision }));
  await settle();
};
const tray = () => document.querySelector('[role="dialog"][aria-label="Pull requests"]');
const text = (el: Element | null) => el?.textContent ?? null;
const button = (root: ParentNode, label: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const reset = () => {
  // the window's last answers: each test starts in a fresh window
  lastAnswers.clear();
  lastListed.clear();
  store.setState({ threads: {} });
  kit.listedGate = null;
  for (const o of [rows, prs, monitors, listed]) for (const k of Object.keys(o)) delete o[k];
  for (const a of [sent, chatsOpened, links, configured, failures, snapshots, statusReads, listedReads]) a.length = 0;
  kit.sendAnswer = true;
  kit.snapshot = async (id: string) => (snapshots.push(id), monitors[id] ?? null);
  kit.configure = async (...a: unknown[]) => (configured.push(a), {});
};

export {
  store,
  sent,
  failures,
  chatsOpened,
  links,
  rows,
  prs,
  statusReads,
  empty,
  monitors,
  snapshots,
  configured,
  listed,
  listedReads,
  ComposerPills,
  Inbox,
  PrCount,
  familyOf,
  familyUrls,
  lastAnswers,
  url,
  open,
  child,
  facts,
  settle,
  show,
  tray,
  text,
  button,
  reset,
  act,
  h,
  render,
  click,
};
