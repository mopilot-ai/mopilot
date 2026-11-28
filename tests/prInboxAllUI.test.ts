// The PR inbox beyond its tray (src/components/thread/PrInboxAll.tsx, src/components/panels/SummaryPullRequests.tsx): the
// All chats scope lists every main chat's PRs, one section per chat with the ones needing the user first, and the summary
// panel's card lists a chat's PRs as the tray does, so they stay reachable with the status line scrolled away.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, render, click } from './support/pages-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { mockSource, stubStore } from './support/stubs.ts';

const { createElement: h, act } = await import('react');
const store = fakeStore<any>({ runtime: {}, segments: {}, archived: [], claudeArchived: {}, agentTabs: {}, threads: {} });
stubStore({
  useStore: store.useStore,
  navigate: () => {},
  toast: () => {},
  chatKind: () => 'claude',
  chatOf: (id: string) => id,
  nativeOf: (id: string) => id,
  sendOrDraft: async (...a: unknown[]) => (sent.push(a), true),
  toastFailure: () => () => {},
  threadTitle: (t: any) => t?.name ?? 'New chat',
});
const chatsOpened: string[] = [];
const sent: unknown[][] = [];
mock.module('../src/session/openChat.ts', {
  namedExports: { openChatFrom: (_e: unknown, id: string) => chatsOpened.push(id), openChat: () => {} },
});
const links: string[] = [];
mock.module('../src/session/open.ts', { namedExports: { openLink: (url: string) => links.push(url) } });
const rows: Record<string, string> = {};
mock.module('../src/session/useChatRowState.ts', {
  namedExports: {
    useChatRowState: (id: string) => (rows[id] ? { state: rows[id] } : null),
    useChatTurn: () => 'idle',
    retryChatState: async () => {},
  },
});
const prs: Record<string, any> = {};
const listed: Record<string, any[]> = {};
mock.module('../src/session/pullRequestReader.ts', {
  namedExports: {
    readPullRequest: Object.assign(async () => null, {
      status: async (url: string) => prs[url],
      known: () => undefined,
      listed: async (id: string) => listed[id] ?? [],
    }),
  },
});
mockSource('src/store/session/useSession.ts', { useSession: () => ({ goal: null }), useSessions: () => null, sessionOf: () => ({}) });
mockSource('src/components/thread/GoalBar.tsx', { GoalPill: () => null, goalShown: () => false });
const empty = { children: {}, deliveries: {}, proposals: {}, queue: [], plans: {}, wrapUps: {} };
let notify: (v: any) => void = () => {};
const monitors: Record<string, any> = {};
installNativeStub({
  orchestration: { snapshot: async () => empty, onChanged: (cb: any) => ((notify = cb), () => {}) },
  prMonitor: { snapshot: async (id: string) => monitors[id] ?? null, onChanged: () => () => {}, configure: async () => ({}) },
});
const { ComposerPills } = await import('../src/components/thread/ComposerPills.tsx');
const { PrCount } = await import('../src/components/thread/PrCount.tsx');
const { mainChats } = await import('../src/components/thread/PrInboxAll.tsx');
const { SummaryPullRequests } = await import('../src/components/panels/SummaryPullRequests.tsx');
const { lastAnswers } = await import('../src/lib/prLastAnswer.ts');
const { markWindowReady } = await import('../src/lib/windowReady.ts');
markWindowReady();

const Inbox = ({ threadId }: { threadId: string }) =>
  h('div', null, h(ComposerPills, { threadId, showGoal: false, showInbox: true }), h(PrCount, { chatId: threadId }));
const url = (n: number) => `https://github.com/o/r/pull/${n}`;
const open = (n: number, details: any = {}) => ({
  url: url(n),
  number: n,
  state: 'open',
  title: `PR ${n}`,
  details: { checks: 'passing', mergeable: 'MERGEABLE', mergeState: 'CLEAN', ...details },
});
const child = (parentId: string, n: number, o: any = {}) => ({
  parentId,
  name: `s${n}`,
  title: 't',
  harness: null,
  useWorktree: false,
  lastReport: null,
  createdAt: n,
  facts: { pr: { number: n, state: 'OPEN', url: url(n) } },
  ...o,
});
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const show = async (children: any, more: any = {}) => {
  await act(async () => notify({ ...empty, children, ...more }));
  await settle();
};
const tray = () => document.querySelector('[role="dialog"][aria-label="Pull requests"]')!;
const button = (root: ParentNode, label: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const pending = { checks: 'pending', mergeable: 'UNKNOWN', mergeState: 'UNKNOWN' };

test('the main chats are the parents of linked sessions that are not sessions themselves, a detached one standing alone', () => {
  const v: any = {
    ...empty,
    children: {
      a: child('top', 1),
      b: child('a', 2),
      c: child('free', 3),
      free: child('top', 4, { detached: true }),
      d: child('gone', 5, { detached: true }),
    },
  };
  assert.deepEqual(mainChats(v).sort(), ['free', 'top']);
});

test('All chats lists each main chat, the ones needing the user first; the choice holds while the tray reopens', async () => {
  store.setState({ threads: { top: { name: 'Host UX round' }, other: { name: 'Phone polish' }, quiet: { name: 'Quiet' } } });
  Object.assign(rows, { top: 'idle', a: 'working', b: 'idle', c: 'idle', q: 'idle' });
  Object.assign(prs, {
    [url(1)]: open(1, pending),
    [url(2)]: open(2, { checks: 'failing' }),
    [url(3)]: open(3, pending),
    [url(4)]: open(4, { mergeable: 'CONFLICTING' }),
    [url(5)]: { url: url(5), number: 5, state: 'closed' },
  });
  // top: one PR on its way; other: one stuck and one on its way; quiet: nothing open
  // and a second session of other's asks a question
  rows.e = 'input';
  prs[url(11)] = open(11, pending);
  const children = { a: child('top', 1), b: child('other', 2), c: child('other', 3), q: child('quiet', 5), e: child('other', 11) };
  const wrapUps = { e: { recap: 'r', ask: 'Ship it?', actions: [{ label: 'Ship', message: null }] } };
  await show(children, { wrapUps });
  const v = await render(h(Inbox, { threadId: 'top' }));
  await show(children, { wrapUps });
  const pill = v.host.querySelector('[aria-haspopup="dialog"]') as HTMLButtonElement;
  await click(pill);
  assert.equal(button(tray(), 'This chat')!.getAttribute('aria-pressed'), 'true');
  await click(button(tray(), 'All chats')!);
  await settle();
  const sections = () => [...tray().querySelectorAll('section')] as HTMLElement[];
  // quiet has nothing open: no section; the one needing the user comes first, in the DOM too (focus and reading order)
  assert.deepEqual(
    sections().map((s) => s.getAttribute('aria-label')),
    ['Phone polish', 'Host UX round'],
  );
  const phone = sections()[0];
  // only the question needs the user; the stuck PR is on its way, folded with the other
  assert.equal(phone.querySelector('[role="img"]')?.getAttribute('aria-label'), '1 needs you');
  assert.doesNotMatch(phone.textContent!, /Stuck/);
  // a question is answered from All chats too, once
  await click(button(phone, 'Ship')!);
  assert.deepEqual(sent, [['e', 'Ship', { human: true }]]);
  assert.match(phone.textContent!, /Sent/);
  assert.match(sections()[1].textContent!, /this chat/);
  // its PRs on their way fold; they open, what the user may act on first, and close
  const fold = button(phone, 'Other open PRs (2)')!;
  await click(fold);
  assert.match(phone.textContent!, /PR 2#2·s2StuckChecks failing · auto-fix is off.*PR 3/);
  await click(fold);
  assert.doesNotMatch(phone.textContent!, /PR 3/);
  assert.equal(button(sections()[1], 'Open PRs (1)') !== undefined, true);
  // a chat's title opens it
  await click(button(phone, 'Phone polish')!);
  assert.deepEqual(chatsOpened, ['other']);
  // reopened, the tray keeps All chats
  await click(pill);
  assert.equal(button(tray(), 'All chats')!.getAttribute('aria-pressed'), 'true');
  await click(button(tray(), 'This chat')!);
  assert.equal(tray().querySelectorAll('section[aria-label="Phone polish"]').length, 0);
  await v.unmount();
});

test("a main chat's own PR in All chats is named as the main chat's", async () => {
  store.setState({ threads: { solo: { name: 'Solo' } } });
  Object.assign(rows, { solo: 'idle', s: 'idle' });
  monitors.solo = { url: url(6), autoFix: false, limited: false, uncertain: false };
  Object.assign(prs, { [url(6)]: open(6, { checks: 'failing' }), [url(7)]: open(7, pending) });
  const children = { s: child('solo', 7) };
  await show(children);
  const v = await render(h(Inbox, { threadId: 'solo' }));
  await show(children);
  await click(v.host.querySelector('[aria-haspopup="dialog"]') as HTMLButtonElement);
  await click(button(tray(), 'All chats')!);
  await settle();
  const solo = tray().querySelector('section[aria-label="Solo"]')!;
  await click(button(solo, 'Open PRs (2)')!);
  assert.match(solo.textContent!, /PR 6#6·main chat/);
  await v.unmount();
  delete monitors.solo;
});

test('All chats keeps merges to today, folded, and says so when nothing is open or merged today', async () => {
  store.setState({ threads: { only: { name: 'Only', id: 'only', updatedAt: 1 }, x: { name: 'Merged today', id: 'x', updatedAt: 1 } } });
  Object.assign(rows, { only: 'idle', d: 'done', x: 'idle', y: 'done' });
  // this chat's merge is days old: it lists, All chats doesn't; the other chat merged today
  prs[url(30)] = { ...open(30), state: 'merged', title: 'Old merge', mergedAt: 1000 };
  const old = { d: child('only', 30) };
  await show(old);
  const v = await render(h(Inbox, { threadId: 'only' }));
  await show(old);
  await click(v.host.querySelector('[aria-haspopup="dialog"]') as HTMLButtonElement);
  await click(button(tray(), 'All chats')!);
  await settle();
  assert.match(tray().textContent!, /Nothing open or merged today/);
  assert.equal(tray().querySelector('section[aria-label="Only"]'), null);
  prs[url(31)] = { ...open(31), state: 'merged', title: 'New merge', mergedAt: Date.now() };
  await show({ ...old, y: child('x', 31) });
  await settle();
  assert.doesNotMatch(tray().textContent!, /Nothing open or merged today/);
  const section = tray().querySelector('section[aria-label="Merged today"]')!;
  assert.doesNotMatch(section.textContent!, /New merge/);
  const fold = button(section, 'Merged today (1)')!;
  await click(fold);
  assert.match(section.textContent!, /New merge/);
  await click(fold);
  assert.doesNotMatch(section.textContent!, /New merge/);
  await v.unmount();
});

test('the summary lists open PRs and merges alike; as Claude Desktop’s Changes, five show and the rest are behind Show N more', async () => {
  store.setState({ threads: { passive: { id: 'passive', updatedAt: 1, name: 'p' } } });
  Object.assign(rows, { pending: 'working' });
  prs[url(20)] = open(20, pending);
  const day = new Date(2026, 0, 15).getTime();
  listed.passive = [1, 2, 3, 4, 5, 6].map((n) => ({ ...open(100 + n), state: 'merged', mergedAt: day - n * 1000 }));
  listed.passive.push({ ...open(107), state: 'merged', title: 'No date' });
  const children = { pending: child('passive', 20) };
  await show(children);
  const counts: number[] = [];
  const v = await render(h(SummaryPullRequests, { threadId: 'passive', onCount: (n: number) => counts.push(n) }));
  try {
    await show(children);
    const card = v.host.querySelector('section[aria-label="Pull requests"]')!;
    const shown = () => [...card.querySelectorAll('button.summary-row')].map((b) => b.textContent);
    // the whole list's count goes to the Changes section's summary
    assert.equal(counts.at(-1), 8);
    assert.equal(shown().length, 6);
    assert.equal(shown()[0], 'PR 20Checks');
    assert.match(shown()[1], /^PR 101Jan 14|^PR 101Jan 15/);
    assert.equal(shown()[5], 'Show 3 more');
    await click(button(card, 'Show 3 more')!);
    assert.equal(shown().length, 8);
    // no date to say: its word instead
    assert.equal(shown()[7], 'No dateMerged');
    links.length = 0;
    await click(card.querySelectorAll('button.summary-row')[1] as HTMLButtonElement);
    assert.deepEqual(links, [url(101)]);
  } finally {
    await v.unmount();
    delete listed.passive;
  }
});

test("the summary card lists a chat's PRs and opens the questions waiting on the user in their sessions", async () => {
  store.setState({ threads: {} });
  Object.assign(rows, { top: 'idle', ask: 'input', red: 'idle', run: 'working' });
  Object.assign(prs, { [url(8)]: open(8), [url(9)]: open(9, { checks: 'failing' }), [url(10)]: open(10, pending) });
  const children = { ask: child('top', 8), red: child('top', 9), run: child('top', 10) };
  await show(children, { wrapUps: { ask: { recap: 'r', ask: 'Keep it?', actions: [] } } });
  const v = await render(h(SummaryPullRequests, { threadId: 'top' }));
  await show(children, { wrapUps: { ask: { recap: 'r', ask: 'Keep it?', actions: [] } } });
  const card = v.host.querySelector('section[aria-label="Pull requests"]')!;
  const rowsShown = [...card.querySelectorAll('button.summary-row')] as HTMLButtonElement[];
  assert.deepEqual(
    rowsShown.map((b) => b.textContent),
    ['PR 8Asks you', 'PR 9Stuck', 'PR 10Checks'],
  );
  chatsOpened.length = 0;
  await click(rowsShown[0]);
  assert.deepEqual(chatsOpened, ['ask']);
  await v.unmount();
  // a remount starts from the last answer, so a failed read still shows the PR's title
  delete prs[url(8)];
  const again = await render(h(SummaryPullRequests, { threadId: 'top' }));
  await show(children, { wrapUps: { ask: { recap: 'r', ask: 'Keep it?', actions: [] } } });
  assert.match(again.host.textContent!, /PR 8Asks you/);
  await again.unmount();
  // a question whose PR GitHub never answered for is named by its number
  lastAnswers.clear();
  const unread = await render(h(SummaryPullRequests, { threadId: 'top' }));
  await show(children, { wrapUps: { ask: { recap: 'r', ask: 'Keep it?', actions: [] } } });
  assert.match(unread.host.textContent!, /#8Asks you/);
  await unread.unmount();
  const none = await render(h(SummaryPullRequests, { threadId: 'nobody' }));
  await settle();
  assert.equal(none.host.innerHTML, '');
  await none.unmount();
});
