// The branch picker's pull request lookup (src/components/composer/BranchPicker.tsx, src/lib/startSourceLookup.ts): `#12` or a link in its search shows that pull request, picking it sets its branch, and an answer for older text is dropped.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement, act } from 'react';
import { fakeStore, popoverExports, render, click, type, press, flush } from './support/shell-chrome-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const BASE = { newChatWorktree: true, newChatBranch: null, prefs: { worktreeDefault: false } };
const store = fakeStore<any>(BASE);
const asked: [string, string][] = [];
/** What each lookup answers: a value, an Error to throw, or a promise held until the test lets it go. */
let answer: (text: string) => unknown = () => ({ ok: false, error: 'none' });
stubStore({
  useStore: store.useStore,
  setState: store.setState,
  newChatWorktreeOn: (s: any) => s.newChatWorktree ?? s.prefs.worktreeDefault === true,
  setNewChatWorktree: () => {},
});
let linearOn = false;
installNativeStub({
  linear: { status: async () => ({ connected: linearOn, last4: null }) },
  git: {
    branches: async () => ({ current: 'main', default: 'main', branches: ['main', 'feature', 'ENG-12-old'], commits: true }),
    startSource: async (cwd: string, text: string) => {
      asked.push([cwd, text]);
      const a = await answer(text);
      if (a instanceof Error) throw a;
      return a;
    },
  },
});
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverExports });
const { WorktreeChip, BranchMenu } = await import('../src/components/composer/BranchPicker.tsx');
const { LOOKUP_DELAY_MS } = await import('../src/lib/startSourceLookup.ts');

const found = (over: object = {}) => ({
  ok: true,
  number: 12,
  title: 'Fix the thing',
  url: 'https://github.com/acme/app/pull/12',
  state: 'OPEN',
  base: 'main',
  head: 'fix-thing',
  fork: false,
  own: true,
  checkout: 'fix-thing',
  ...over,
});
/** Past the typing pause, with the lookup's answer drawn (inside act, as a timer firing in the app would be). */
const settle = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, LOOKUP_DELAY_MS + 30));
  });
  await flush();
};
const reset = () => {
  store.reset({ ...BASE });
  asked.length = 0;
  answer = () => found();
};
const rows = (host: Element) => [...host.querySelectorAll('.menu-scroll .menu-item')] as HTMLElement[];
const empty = (host: Element) => host.querySelector('.menu-empty')?.textContent ?? null;
const search = (host: Element) => host.querySelector('.menu-search input') as HTMLInputElement;
const branchBtn = (host: Element) => host.querySelector('.ctx-wt-branch') as HTMLElement;

async function openChip() {
  const v = await render(createElement(WorktreeChip, { path: '/repo' }));
  await flush();
  await click(branchBtn(v.host));
  await flush();
  return v;
}

test('#12 is looked up after a pause in typing; Enter picks its branch and the chip names the pull request', async () => {
  reset();
  const { host, unmount } = await openChip();
  assert.match(search(host).placeholder, /#12 for a pull request or issue/);
  await type(search(host), '#12');
  assert.equal(empty(host), 'Looking up #12…');
  assert.deepEqual(rows(host), [], 'the branches give way to the pull request');
  assert.deepEqual(asked, [], 'nothing is asked while typing');
  await settle();
  assert.deepEqual(asked, [['/repo', '#12']]);
  assert.equal(rows(host).length, 1);
  assert.equal(rows(host)[0].querySelector('.menu-title')!.textContent, '#12 Fix the thing');
  assert.equal(rows(host)[0].querySelector('.menu-desc')!.textContent, 'fix-thing into main');
  assert.equal(empty(host), null);
  await press(search(host), 'Enter');
  await flush();
  assert.deepEqual(store.getState().newChatBranch, {
    path: '/repo',
    branch: 'fix-thing',
    pullRequest: { number: 12, title: 'Fix the thing', fork: false, own: true },
  });
  assert.equal(host.querySelector('[data-popover]'), null);
  assert.equal(branchBtn(host).textContent, '#12 fix-thing');
  assert.equal(branchBtn(host).getAttribute('aria-label'), 'Branch: #12 fix-thing');
  assert.equal(branchBtn(host).title, 'Pull request #12: Fix the thing');
  // reopened, no branch row claims the pick
  await click(branchBtn(host));
  await flush();
  assert.equal(host.querySelectorAll('.menu-check svg').length, 0);
  // picking a branch again drops the pull request
  await click(rows(host)[1]);
  assert.deepEqual(store.getState().newChatBranch, { path: '/repo', branch: 'feature' });
  await unmount();
});

test('a fork’s or a closed pull request says it is worked on as a copy, and a click picks it too', async () => {
  for (const [pr, desc] of [
    [
      { number: 7, title: 'Theirs', head: 'theirs', fork: true, own: false, checkout: 'pr/7', state: 'CLOSED' },
      'theirs from a fork, as pr/7 into main · closed',
    ],
    [{ number: 7, title: 'Theirs', own: false, checkout: 'pr/7', state: 'MERGED' }, 'fix-thing, as pr/7 into main · merged'],
  ] as const) {
    reset();
    answer = () => found(pr);
    const { host, unmount } = await openChip();
    await type(search(host), 'https://github.com/acme/app/pull/7');
    await settle();
    assert.equal(rows(host)[0].querySelector('.menu-desc')!.textContent, desc);
    await click(rows(host)[0]);
    assert.deepEqual(store.getState().newChatBranch.pullRequest, { number: 7, title: 'Theirs', fork: pr.fork ?? false, own: false });
    await unmount();
  }
});

test('a lookup that fails, or throws, says why in place of any row; Enter then picks nothing', async () => {
  for (const a of [
    { ok: false, error: 'acme/app has no pull request #12.' },
    new Error("Error invoking remote method 'git:startSource': Error: boom"),
  ]) {
    reset();
    answer = () => a;
    const { host, unmount } = await openChip();
    await type(search(host), '#12');
    await settle();
    assert.deepEqual(rows(host), []);
    assert.equal(empty(host), a instanceof Error ? 'boom' : a.error);
    await press(search(host), 'Enter');
    assert.equal(store.getState().newChatBranch, null);
    await unmount();
  }
});

test('an answer for text since changed is dropped: what shows is for what is typed now', async () => {
  reset();
  const held: Record<string, (v: unknown) => void> = {};
  answer = (text) => new Promise((r) => (held[text] = r));
  const { host, unmount } = await openChip();
  await type(search(host), '#1');
  await settle();
  await type(search(host), '#12');
  await settle();
  assert.deepEqual(
    asked.map(([, t]) => t),
    ['#1', '#12'],
  );
  held['#12'](found());
  await flush();
  held['#1'](found({ number: 1, title: 'Old' }));
  await flush();
  assert.equal(rows(host)[0].querySelector('.menu-title')!.textContent, '#12 Fix the thing');
  // text that names no pull request is a branch search again, and asks nothing
  await type(search(host), 'feat');
  await settle();
  assert.equal(asked.length, 2);
  assert.deepEqual(
    rows(host).map((r) => r.textContent),
    ['feature'],
  );
  await unmount();
});

test('a branch menu with no pull request pick, or a closed one, looks nothing up', async () => {
  reset();
  const props = { anchor: document.body, onClose: () => {}, branches: ['main'], selected: null, onPick: () => {}, path: '/repo' };
  const { host, rerender, unmount } = await render(createElement(BranchMenu, { ...props, open: true }));
  await type(search(host), '#12');
  await settle();
  assert.equal(empty(host), 'No branches');
  assert.equal(search(host).placeholder, 'Search branches…');
  await rerender(createElement(BranchMenu, { ...props, open: false, onPickSource: () => {} }));
  await settle();
  assert.deepEqual(asked, []);
  await unmount();
});

test('an issue shows as one, and picking it keeps the branch shown, named on the chip with what the first message carries', async () => {
  for (const [state, desc] of [
    ['OPEN', 'Issue · a new chat that starts with its text'],
    ['CLOSED', 'Issue · a new chat that starts with its text · closed'],
  ] as const) {
    reset();
    answer = () => ({ ok: true, kind: 'issue', number: 34, title: 'Crash on save', url: 'https://github.com/acme/app/issues/34', state });
    const { host, unmount } = await openChip();
    await type(search(host), 'https://github.com/acme/app/issues/34');
    await settle();
    assert.equal(rows(host)[0].querySelector('.menu-title')!.textContent, '#34 Crash on save');
    assert.equal(rows(host)[0].querySelector('.menu-desc')!.textContent, desc);
    await press(search(host), 'Enter');
    await flush();
    // no branch was picked before it, so none is: the default shown (origin's, with Worktree on) still follows the switch
    assert.deepEqual(store.getState().newChatBranch, { path: '/repo', branch: null, issue: { number: 34, title: 'Crash on save' } });
    assert.equal(branchBtn(host).textContent, '#34 main');
    assert.equal(branchBtn(host).title, 'Issue #34: Crash on save. Your first message carries its text.');
    await click(branchBtn(host));
    await flush();
    assert.equal(host.querySelectorAll('.menu-check svg').length, 0, 'no branch row claims an issue pick');
    // a branch picked over it drops the issue, and the chip says what the branch is for
    await click(rows(host)[1]);
    await flush();
    assert.deepEqual(store.getState().newChatBranch, { path: '/repo', branch: 'feature' });
    assert.equal(branchBtn(host).title, 'Branch the worktree starts from');
    await act(async () => store.setState({ newChatWorktree: false }));
    await flush();
    assert.equal(branchBtn(host).title, 'Branch to work on');
    await unmount();
  }
});

test('a Linear issue shows by its key with Linear’s branch; picking it keeps the branch picked, and the chip names it', async () => {
  linearOn = true;
  for (const [over, desc] of [
    [{}, 'Linear issue · a new chat that starts with its text, on pat/eng-12-fix with a worktree'],
    [{ branch: null, done: true, state: 'Done' }, 'Linear issue · a new chat that starts with its text · done'],
  ] as const) {
    reset();
    answer = () => ({
      ok: true,
      kind: 'linear',
      key: 'ENG-12',
      title: 'Fix login',
      url: 'https://linear.app/a/issue/ENG-12/x',
      state: 'Todo',
      done: false,
      branch: 'pat/eng-12-fix',
      ...over,
    });
    const { host, unmount } = await openChip();
    await type(search(host), 'ENG-12');
    assert.equal(empty(host), 'Looking up ENG-12…');
    await settle();
    assert.equal(rows(host)[0].querySelector('.menu-title')!.textContent, 'ENG-12 Fix login');
    assert.equal(rows(host)[0].querySelector('.menu-desc')!.textContent, desc);
    await press(search(host), 'Enter');
    await flush();
    assert.deepEqual(store.getState().newChatBranch, {
      path: '/repo',
      branch: null,
      linear: { key: 'ENG-12', title: 'Fix login', branch: 'branch' in over ? over.branch : 'pat/eng-12-fix' },
    });
    assert.equal(branchBtn(host).textContent, 'ENG-12 main');
    assert.equal(branchBtn(host).title, 'Linear issue ENG-12: Fix login. Your first message carries its text.');
    await unmount();
  }
  linearOn = false;
});

test('without Linear connected, a key like JIRA-123 is a branch search; with it, branches named like it stay listed', async () => {
  reset();
  linearOn = false;
  const { host, unmount } = await openChip();
  await type(search(host), 'ENG-12');
  await settle();
  assert.deepEqual(asked, []);
  assert.deepEqual(
    rows(host).map((r) => r.textContent),
    ['ENG-12-old'],
  );
  await unmount();
  linearOn = true;
  answer = () => ({ ok: false, error: 'Linear has no issue ENG-12 you can see.' });
  const again = await openChip();
  await type(search(again.host), 'ENG-12');
  await settle();
  assert.equal(empty(again.host), 'Linear has no issue ENG-12 you can see.');
  assert.deepEqual(
    rows(again.host).map((r) => r.textContent),
    ['ENG-12-old'],
  );
  // Enter picks the branch listed under it
  await press(search(again.host), 'Enter');
  assert.equal(store.getState().newChatBranch.branch, 'ENG-12-old');
  await again.unmount();
  // found, the issue is the first row and highlighted; arrowing down moves the highlight to the branch under it
  answer = () => ({
    ok: true,
    kind: 'linear',
    key: 'ENG-12',
    title: 'Fix login',
    url: 'https://linear.app/a/issue/ENG-12/x',
    state: 'Todo',
    done: false,
    branch: null,
  });
  const found = await openChip();
  await type(search(found.host), 'ENG-12');
  await settle();
  const active = () => rows(found.host).map((r) => r.classList.contains('kbd-active'));
  assert.deepEqual(active(), [true, false]);
  await press(search(found.host), 'ArrowDown');
  assert.deepEqual(active(), [false, true]);
  await press(search(found.host), 'Enter');
  assert.equal(store.getState().newChatBranch.branch, 'ENG-12-old');
  await found.unmount();
  linearOn = false;
});
