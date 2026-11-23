// The context bar's branch + worktree chip and branch picker (src/components/composer/BranchPicker.tsx).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement } from 'react';
import { fakeStore, popoverExports, render, click, type, press, flush } from './support/shell-chrome-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const BASE = { newChatWorktree: null, newChatBranch: null, prefs: { worktreeDefault: false } };
const store = fakeStore<any>(BASE);
let lists: Record<string, any> = {};
const loads: string[] = [];
stubStore({
  useStore: store.useStore,
  setState: store.setState,
  newChatWorktreeOn: (s: any) => s.newChatWorktree ?? s.prefs.worktreeDefault === true,
  setNewChatWorktree: (on: boolean) => store.setState((s: any) => ({ newChatWorktree: null, prefs: { ...s.prefs, worktreeDefault: on } })),
});
installNativeStub({
  // Linear not connected: the search is a branch search
  linear: { status: async () => ({ connected: false, last4: null }) },
  git: {
    branches: async (p: string) => {
      loads.push(p);
      const l = lists[p];
      if (l instanceof Error) throw l;
      return l ?? null;
    },
  },
});
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverExports });
const { WorktreeChip, BranchMenu, branchShown } = await import('../src/components/composer/BranchPicker.tsx');
const { NO_COMMITS } = await import('../shared/worktreeSupport.mjs');

const REPO = { current: 'feature', default: 'main', branches: ['main', 'ci-pr-100', 'ci-pr-39', 'feature'], commits: true };
const reset = (state: any = {}) => {
  store.reset({ ...BASE, ...state });
  lists = { '/repo': REPO };
  loads.length = 0;
};
const chip = (path = '/repo') => createElement(WorktreeChip, { path });
const branchBtn = (host: Element) => host.querySelector('.ctx-wt-branch') as HTMLElement | null;
const rows = (host: Element) => [...host.querySelectorAll('.menu-scroll .menu-item')] as HTMLElement[];
const titles = (host: Element) => rows(host).map((r) => r.querySelector('.menu-title')!.textContent);
const checked = (host: Element) =>
  rows(host)
    .filter((r) => r.querySelector('.menu-check svg'))
    .map((r) => r.textContent);
const search = (host: Element) => host.querySelector('.menu-search input') as HTMLInputElement;

test("branchShown: the picked branch, else origin's default with a worktree, else the checked-out one", () => {
  assert.equal(branchShown(REPO, 'x', true), 'x');
  assert.equal(branchShown(REPO, null, true), 'main');
  assert.equal(branchShown(REPO, null, false), 'feature');
  assert.equal(branchShown({ current: 'feature', default: null, branches: [], commits: true }, null, true), 'feature');
  assert.equal(branchShown({ current: null, default: null, branches: [], commits: true }, null, false), null);
});

test('the chip shows the default branch with a worktree and the checked-out one without; the switch sets the default for later chats', async () => {
  reset({ newChatWorktree: true });
  const { host, unmount } = await render(chip());
  await flush();
  assert.equal(host.querySelector('.ctx-check')!.getAttribute('title'), 'Run this chat in an isolated git worktree');
  assert.equal((host.querySelector('.ctx-check input') as HTMLInputElement).disabled, false);
  assert.equal(branchBtn(host)!.textContent, 'main');
  assert.equal(branchBtn(host)!.getAttribute('aria-label'), 'Branch: main');
  assert.equal(branchBtn(host)!.title, 'Branch the worktree starts from');
  assert.ok(host.querySelector('.ctx-check .checkbox svg'));
  await click(host.querySelector('.ctx-check input'));
  // the draft's own choice gives way to the saved default the switch wrote
  assert.equal(store.getState().newChatWorktree, null);
  assert.equal(store.getState().prefs.worktreeDefault, false);
  assert.equal(branchBtn(host)!.textContent, 'feature');
  assert.equal(branchBtn(host)!.title, 'Branch to work on');
  assert.equal(host.querySelector('.ctx-check .checkbox svg'), null);
  await click(host.querySelector('.ctx-check input'));
  assert.equal(store.getState().prefs.worktreeDefault, true);
  assert.ok(host.querySelector('.ctx-check .checkbox svg'));
  await unmount();
});

test('the saved default turns the switch on for a new draft', async () => {
  reset({ prefs: { worktreeDefault: true } });
  const { host, unmount } = await render(chip());
  await flush();
  assert.ok(host.querySelector('.ctx-check .checkbox svg'));
  assert.equal(branchBtn(host)!.textContent, 'main');
  await unmount();
});

test('nothing shows until the branches load or outside a repo; with no commits the switch is off, disabled and says why', async () => {
  reset({ prefs: { worktreeDefault: true } });
  lists['/plain'] = null;
  lists['/empty'] = { current: 'main', default: null, branches: [], commits: false };
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const native = (await import('../src/lib/native.ts')).native as any;
  const real = native.git.branches;
  native.git.branches = async (p: string) => (await gate, real(p));
  const { host, rerender, unmount } = await render(chip('/repo'));
  const input = () => host.querySelector('.ctx-check input') as HTMLInputElement | null;
  const label = () => host.querySelector('.ctx-check') as HTMLElement;
  assert.equal(host.innerHTML, '', 'not known yet: no switch that could flash and then go away');
  release();
  await flush();
  native.git.branches = real;
  assert.equal(input()!.disabled, false);
  assert.equal(input()!.checked, true);
  await rerender(chip('/plain'));
  await flush();
  assert.equal(host.innerHTML, '', 'not a repo: no branch, and no switch to choose');
  await rerender(chip('/empty'));
  await flush();
  assert.equal(input()!.disabled, true);
  assert.equal(input()!.checked, false);
  assert.ok(label().classList.contains('disabled'));
  assert.equal(label().title, `Worktree unavailable: ${NO_COMMITS}`);
  assert.equal(branchBtn(host)!.textContent, 'main', 'the checked-out branch, not the worktree default');
  await rerender(chip('/repo'));
  await flush();
  assert.equal(input()!.disabled, false);
  assert.equal(input()!.checked, true);
  assert.ok(!label().classList.contains('disabled'));
  assert.equal(store.getState().prefs.worktreeDefault, true, 'the saved default is kept for a folder that can hold one');
  await unmount();
});

test('opening the picker reloads branches, lists them in order with the shown one checked, and picking sets the branch for this folder', async () => {
  reset({ newChatWorktree: true });
  const { host, unmount } = await render(chip());
  await flush();
  assert.equal(host.querySelector('[data-popover]'), null);
  await click(branchBtn(host));
  await flush();
  assert.deepEqual(loads, ['/repo', '/repo']);
  assert.equal(host.querySelector('[data-popover]')!.getAttribute('data-popover'), 'top-start');
  assert.ok(branchBtn(host)!.classList.contains('active'));
  assert.deepEqual(titles(host), ['main', 'ci-pr-100', 'ci-pr-39', 'feature']);
  assert.deepEqual(checked(host), ['main']);
  assert.equal(document.activeElement, search(host));
  await click(rows(host)[2]);
  assert.deepEqual(store.getState().newChatBranch, { path: '/repo', branch: 'ci-pr-39' });
  assert.equal(host.querySelector('[data-popover]'), null);
  assert.equal(branchBtn(host)!.textContent, 'ci-pr-39');
  await unmount();
});

test('a branch picked for another folder is ignored; a detached checkout shows HEAD', async () => {
  reset({ newChatBranch: { path: '/other', branch: 'x' } });
  lists['/repo'] = { current: null, default: null, branches: ['a'], commits: true };
  const { host, unmount } = await render(chip());
  await flush();
  assert.equal(branchBtn(host)!.textContent, 'HEAD');
  await unmount();
});

test('outside a git repo, or when listing fails, the chip is hidden; a new folder drops the old list', async () => {
  reset();
  lists['/plain'] = null;
  lists['/broken'] = new Error('git missing');
  const { host, rerender, unmount } = await render(chip('/repo'));
  await flush();
  assert.ok(branchBtn(host));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  lists['/slow'] = REPO;
  const native = (await import('../src/lib/native.ts')).native as any;
  const real = native.git.branches;
  native.git.branches = async (p: string) => (p === '/slow' ? (await gate, REPO) : real(p));
  await rerender(chip('/slow'));
  assert.equal(branchBtn(host), null, "the old folder's branches are not shown for the new one");
  release();
  await flush();
  assert.ok(branchBtn(host));
  native.git.branches = real;
  await rerender(chip('/plain'));
  await flush();
  assert.equal(host.innerHTML, '');
  await rerender(chip('/broken'));
  await flush();
  assert.equal(host.innerHTML, '');
  await unmount();
});

test('a load that finishes after the chip is gone is dropped, success or failure', async () => {
  reset();
  let ok!: (v: any) => void;
  let fail!: (e: Error) => void;
  const native = (await import('../src/lib/native.ts')).native as any;
  const real = native.git.branches;
  native.git.branches = (p: string) => new Promise((res, rej) => (p === '/a' ? (ok = res) : (fail = rej)));
  const a = await render(chip('/a'));
  const b = await render(chip('/b'));
  await a.unmount();
  await b.unmount();
  ok(REPO);
  fail(new Error('late'));
  await flush();
  native.git.branches = real;
});

test('search filters case-insensitively, arrows move within bounds, Enter picks, and an empty result says so', async () => {
  reset();
  let picked: string | null = null;
  let closes = 0;
  const menu = (open: boolean) =>
    createElement(BranchMenu, {
      anchor: null,
      open,
      onClose: () => closes++,
      branches: REPO.branches,
      selected: null,
      onPick: (b: string) => (picked = b),
    });
  const { host, rerender, unmount } = await render(menu(false));
  assert.equal(host.innerHTML, '');
  await rerender(menu(true));
  await flush();
  assert.deepEqual(checked(host), []);
  await type(search(host), '  CI-PR ');
  assert.deepEqual(titles(host), ['ci-pr-100', 'ci-pr-39']);
  const active = () => rows(host).findIndex((r) => r.classList.contains('kbd-active'));
  await press(search(host), 'ArrowUp');
  assert.equal(active(), 0);
  await press(search(host), 'ArrowDown');
  await press(search(host), 'ArrowDown');
  assert.equal(active(), 1);
  await press(search(host), 'x');
  await press(search(host), 'Enter');
  assert.equal(picked, 'ci-pr-39');
  const { fire } = await import('./support/composer-kit.ts');
  await fire(rows(host)[0], new (window as any).MouseEvent('mousemove', { bubbles: true }));
  assert.equal(active(), 0);
  await type(search(host), 'zzz');
  assert.deepEqual(titles(host), []);
  assert.equal(host.querySelector('.menu-empty')!.textContent, 'No branches');
  picked = null;
  await press(search(host), 'Enter');
  assert.equal(picked, null);
  assert.equal(closes, 0);
  await unmount();
});

test('a long list draws the first 200 and says how many more a search would reach', async () => {
  reset();
  const many = Array.from({ length: 251 }, (_, i) => `b${i}`);
  const { host, unmount } = await render(
    createElement(BranchMenu, { anchor: null, open: true, onClose: () => {}, branches: many, selected: 'b0', onPick: () => {} }),
  );
  await flush();
  assert.equal(rows(host).length, 200);
  assert.deepEqual(checked(host), ['b0']);
  assert.equal(host.querySelector('.menu-empty')!.textContent, '51 more · search to narrow');
  await type(search(host), 'b250');
  assert.deepEqual(titles(host), ['b250']);
  assert.equal(host.querySelector('.menu-empty'), null);
  await unmount();
});
