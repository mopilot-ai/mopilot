// Shared conversation-view UI mocks, state, DOM rendering and timer fixture.
// The conversation view: loading and banners, scrolling and older history, each turn's messages,
// work, cards, errors and actions, and what sits under it (composer, approvals, read-only note).
import { beforeEach, mock } from 'node:test';
import { createElement as h, useState, useCallback, Fragment, createContext, useContext } from 'react';
import {
  mockStore,
  autoMock,
  stubComponent,
  render,
  settle,
  resetStore,
  setStore,
  impl,
  callsTo,
  moduleCalls,
  native,
  window,
} from '../thread-kit.ts';
import { defined } from '../defined.ts';
import { tabToken } from '../../../shared/tabMentions.mjs';
import { EMPTY_SESSION } from '../../../src/store/session/sessionState.ts';
import { PullRequestReferenceTime } from '../../../src/components/markdown/prReferenceTime.ts';

const withChatNotes = (turns: any[], notes: any) => (notes ? [...turns, ...notes] : turns);
// ThreadView takes withChatNotes from the module that owns it: the same stand-in there, the rest of that module real
const chatMeta = await import('../../../src/lib/chatMeta.ts');
mock.module(new URL('../../../src/lib/chatMeta.ts', import.meta.url).href, { namedExports: { ...chatMeta, withChatNotes } });
mockStore({
  withChatNotes,
  // the Edited card's Undo state lives on the turn (#1939): the fake store keeps it as the real one does
  markTurnUndone: (chatId: string, turnId: string, undone: boolean) =>
    setStore((s: any) => ({
      runtime: {
        ...s.runtime,
        [chatId]: { ...s.runtime[chatId], turns: s.runtime[chatId].turns.map((t: any) => (t.id === turnId ? { ...t, undone } : t)) },
      },
    })),
});
// the failed turn's headline reads the harness's models and accounts (its own test is turnErrorHelp.test.ts)
const { friendlyError: friendly } = await import('../../../src/components/thread/view/friendlyError.ts');
autoMock('src/components/thread/view/TurnErrorHelp.tsx', 'errorHelp', {
  TurnErrorHelp: ({ message }: any) => h('div', null, friendly(message)),
});
let sageApprovals: any[] = [];
autoMock('src/components/thread/Approvals.tsx', 'approvals', {
  Approvals: stubComponent('Approvals'),
  useSageApprovals: () => sageApprovals,
});
// the notice in place of the composer while the chat's harness is down: its own test is harnessDownNoticeUI.test.ts
autoMock('src/components/thread/HarnessDownNotice.tsx', 'harnessDown', {
  HarnessDownNotice: stubComponent('HarnessDownNotice'),
  useDownHarness: () => null,
});
for (const [rel, name] of [
  ['src/components/composer/Composer.tsx', 'Composer'],
  ['src/components/thread/ElsewhereNotice.tsx', 'ElsewhereNotice'],
  ['src/components/thread/WorkingIn.tsx', 'WorkingInStack'],
  ['src/components/browser/ClaudeInChromeNote.tsx', 'ClaudeInChromeNote'],
  ['src/components/thread/SelectionToolbar.tsx', 'SelectionToolbar'],
  ['src/components/composer/SelectionChip.tsx', 'SelectionChip'],
  ['src/components/markdown/SkillLink.tsx', 'SkillLink'],
  ['src/components/thread/AsyncQuestions.tsx', 'AsyncQuestions'],
])
  autoMock(rel, name, { [name]: stubComponent(name) });
// peer messages and the turn navigation rail have their own tests
// (their stubs keep the props they were last given, so the view's callbacks can be driven)
let peerProps: any = null;
let navProps: any = null;
autoMock('src/components/thread/PeerMessages.tsx', 'peer', {
  PeerContext: createContext<any[]>([]),
  PeerMessages: (p: any) => {
    peerProps = p;
    return stubComponent('PeerMessages')(p);
  },
});
autoMock('src/components/tasks/TaskEventCard.tsx', 'taskEvent', {
  TaskEventCard: (p: any) =>
    h('div', { 'data-stub': 'TaskEventCard', 'data-events': JSON.stringify(p.events), 'data-chat': p.chatId ?? '' }),
});
autoMock('src/components/tasks/TaskPolling.tsx', 'taskPolling', { TaskPolling: stubComponent('TaskPolling') });
// a chat's PR inbox reads its PRs from GitHub and has its own tests (tests/prInboxList.test.ts)
autoMock('src/components/thread/PrInbox.tsx', 'prInbox', { PrInboxOwner: () => null });
autoMock('src/components/tasks/TasksPill.tsx', 'tasksPill', {
  InlineTasksCount: stubComponent('InlineTasksCount'),
  TasksStatusRow: stubComponent('TasksStatusRow'),
  StopAllConfirm: stubComponent('StopAllConfirm'),
  useTasksPill: () => ({ running: 0, finished: null }),
  useRunningCalls: () => runningCalls,
  pillShown: () => false,
});
autoMock('src/components/thread/TurnNavigation.tsx', 'nav', {
  TurnNavigation: (p: any) => {
    navProps = p;
    return stubComponent('TurnNavigation')(p);
  },
});
autoMock('src/components/thread/StatusStrip.tsx', 'strip', {
  StatusStrip: (p: any) =>
    h('button', {
      'data-stub': 'StatusStrip',
      'data-approval': String(p.approval),
      'data-confirm': String(p.confirm),
      onClick: () => p.setConfirm(true),
    }),
});
autoMock('src/components/thread/EditedFilesCard.tsx', 'edited', {
  EditedFilesCard: (p: any) =>
    h(
      'div',
      {
        'data-stub': 'EditedFilesCard',
        'data-undone': String(p.undone),
        'data-busy': String(p.busy),
        'data-expanded': String(p.expanded),
        'data-labels': p.files.map((f: any) => f.label).join(','),
      },
      h('button', { className: 'undo', onClick: p.onUndo }),
      h('button', { className: 'view', onClick: () => p.onView(p.files[0].path) }),
      h('button', { className: 'expand', onClick: () => p.onExpand(!p.expanded) }),
    ),
});
autoMock('src/components/markdown/Markdown.tsx', 'md', {
  Markdown: (props: any) => stubComponent('Markdown')({ ...props, referenceTime: useContext(PullRequestReferenceTime) }),
  CodeBlock: stubComponent('CodeBlock'),
});
const { fileChangeToDiff, parseUnifiedDiff } = await import('../../../src/lib/diff.ts');
autoMock('src/components/diff/DiffView.tsx', 'diff', { InlineDiff: stubComponent('InlineDiff'), fileChangeToDiff, parseUnifiedDiff });
autoMock('src/components/ui/ImageLightbox.tsx', 'img', {
  ZoomableImage: (p: any) => h('img', { className: p.className, src: p.src, 'data-stub': 'ZoomableImage', 'data-src': p.src }),
});
// Collapse is its open content or nothing; usePresence says mounted with `show`, unless a test makes it linger (a closing accordion)
autoMock('src/components/ui/Presence.tsx', 'presence', {
  Collapse: ({ open, children }: any) => (open ? children : null),
  COLLAPSE_MS: 300,
  usePresence: (show: boolean) => impl['presence:usePresence']?.(show) ?? { mounted: show, leaving: !show },
});
autoMock('src/components/ui/Popover.tsx', 'popover', {
  useCloseTooltip: () => () => {},
  // a rich label (the changes pill's file list) renders beside its anchor, so its rows can be clicked
  Tooltip: ({ label, children }: any) =>
    typeof label === 'string'
      ? h('span', { 'data-tooltip': label }, children)
      : h('span', { className: 'rich-tooltip' }, children, h('span', { className: 'rich-label' }, label)),
  Menu: ({ open, children }: any) => (open ? h('div', { className: 'menu' }, children) : null),
  MenuItem: ({ onSelect, children }: any) => h('button', { className: 'menu-item', onClick: onSelect }, children),
  useAnchor: () => {
    const [open, setOpen] = useState(false);
    return { ref: useCallback(() => {}, []), anchor: null, open, setOpen, toggle: () => setOpen((o) => !o), close: () => setOpen(false) };
  },
});
autoMock('src/session/open.ts', 'open');
// which sent messages start a skill reads the chat's command list; its own test is sentSkillUI.test.ts
autoMock('src/components/thread/view/sentSkill.ts', 'sentSkill');
autoMock('src/session/chatActions.ts', 'chat');
autoMock('src/store/session/runSemantic.ts', 'sem', { refusalText: (r: any, s: string) => `refused ${s}: ${r.reason}` });
// a chat's session (a case may give it a goal), with no background tasks of its own (the turn view reads which still run
// through useRunningCalls)
autoMock('src/store/session/useSession.ts', 'session', {
  useSession: (id: string) => impl['session:useSession']?.(id) ?? EMPTY_SESSION,
  useSessionField: (id: string, pick: (s: any) => unknown) => pick(impl['session:useSession']?.(id) ?? EMPTY_SESSION),
  // No linked sessions in this fixture; execute selectors against the authoritative empty inventory.
  useSessions: (select: (state: { sessions: Record<string, never> }) => unknown) =>
    impl['session:useSessions'] ? impl['session:useSessions'](select) : select({ sessions: {} }),
});
// Keep the real follow decisions; only the layout observer and browser anchoring marker are boundaries here.
const { ScrollFollowing, observeBottom: realObserveBottom } = await import('../../../src/lib/streamScroll.ts');
autoMock('src/lib/streamScroll.ts', 'scroll', { ScrollFollowing });
const { ThreadView, friendlyError } = await import('../../../src/components/thread/ThreadView.tsx');

const frames: FrameRequestCallback[] = [];
globalThis.requestAnimationFrame = (cb) => frames.push(cb);
globalThis.cancelAnimationFrame = () => {};
const flush = () =>
  settle(() => {
    for (const cb of frames.splice(0)) cb(0);
  });
const clipboard: string[] = [];
let clipboardFails: Error | null = null;
native.clipboard = {
  write: async (t: string) => {
    if (clipboardFails) throw clipboardFails;
    clipboard.push(t);
  },
};
native.fs = { readImageDataUrl: async (p: string) => `data:${p}` };

const T = 'thr';
beforeEach(() => {
  resetStore();
  moduleCalls.length = 0;
  for (const k of Object.keys(impl)) delete impl[k];
  sageApprovals = [];
  frames.length = 0;
  clipboard.length = 0;
});
const text = (el: Element | null | undefined) => el?.textContent ?? '';
const user = (id: string, t: string, extra: any = {}) => ({ id, type: 'userMessage', content: [{ type: 'text', text: t }], ...extra });
const reply = (id: string, t: string, extra: any = {}) => ({ id, type: 'agentMessage', text: t, ...extra });
const turn = (id: string, items: any[], extra: any = {}) => ({
  id,
  items,
  status: 'completed',
  startedAt: null,
  completedAt: null,
  itemTimes: {},
  ...extra,
});
const chat = (turns: any[], rt: any = {}, thread: any = { id: T, cwd: '/repo' }) =>
  setStore({ threads: { [T]: thread }, runtime: { [T]: { loaded: true, turns, ...rt } } });
const view = (props: any = {}) => h(ThreadView, { threadId: T, ...props });
/** Run `fn` while capturing timers of at least `min` ms, then fire them. */
async function withTimers(fn: () => unknown, min = 1000) {
  const real = globalThis.setTimeout;
  const caught: (() => void)[] = [];
  (globalThis as any).setTimeout = (cb: () => void, ms?: number, ...rest: any[]) =>
    (ms ?? 0) >= min ? (caught.push(cb), 0) : real(cb, ms, ...rest);
  try {
    await settle(fn);
  } finally {
    globalThis.setTimeout = real;
  }
  return () => settle(() => caught.splice(0).forEach((cb) => cb()));
}

let runningCalls: ReadonlySet<string> = new Set();
/** The tool calls whose background task still runs, as the turn view reads them. */
export const setRunningCalls = (ids: string[]) => {
  runningCalls = new Set(ids);
};
export const setSageApprovals = (value: any[]) => {
  sageApprovals = value;
};
export const setClipboardFailure = (value: Error | null) => {
  clipboardFails = value;
};
export {
  h,
  useState,
  useCallback,
  Fragment,
  render,
  settle,
  setStore,
  impl,
  callsTo,
  moduleCalls,
  native,
  window,
  defined,
  tabToken,
  ThreadView,
  friendlyError,
  frames,
  flush,
  clipboard,
  peerProps,
  navProps,
  T,
  text,
  user,
  reply,
  turn,
  chat,
  view,
  withTimers,
  realObserveBottom,
};
