// The context bar's branch + worktree chip and branch picker for a folder on a machine (src/components/composer/BranchPicker.tsx, src/lib/branchList.ts, src/lib/machineBranches.ts): the same chip and words as for a folder of this Mac, with the branches read through the machine's Host and never from this Mac's git.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement } from 'react';
import { fakeStore, popoverExports, render, click, flush } from './support/shell-chrome-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const BASE = { newChatWorktree: null, newChatBranch: null, prefs: { worktreeDefault: false } };
const store = fakeStore<any>(BASE);
stubStore({
  useStore: store.useStore,
  setState: store.setState,
  newChatWorktreeOn: (s: any) => s.newChatWorktree ?? s.prefs.worktreeDefault === true,
  setNewChatWorktree: (on: boolean) => store.setState((s: any) => ({ newChatWorktree: null, prefs: { ...s.prefs, worktreeDefault: on } })),
});
const KEY = 'box\0/srv/app';
const REPO = {
  isRepo: true,
  current: 'feature',
  default: 'main',
  branches: ['main', 'feature', 'dev'],
  commits: true,
  top: '/srv/app',
  sub: '',
};
let answer: any = { value: REPO };
const asked: any[] = [];
const local: string[] = [];
let linear = 0;
installNativeStub({
  linear: {
    status: async () => (linear++, { connected: false, last4: null }),
  },
  git: {
    branches: async (p: string) => (local.push(p), null),
    startSource: async (p: string) => (local.push(p), { ok: false, error: 'no' }),
  },
  host: {
    gitBranches: async (id: string, q: any) => {
      asked.push([id, q]);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  },
});
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverExports });
// the machine calls' types are declared in this module, which has no code of its own: loaded, as the host tests do
await import('../src/lib/native/host.ts');
const { WorktreeChip } = await import('../src/components/composer/BranchPicker.tsx');

const reset = (state: any = {}) => {
  store.reset({ ...BASE, ...state });
  answer = { value: REPO };
  asked.length = 0;
  local.length = 0;
  linear = 0;
};
const chip = (path = KEY) => createElement(WorktreeChip, { path });
const branchBtn = (host: Element) => host.querySelector('.ctx-wt-branch') as HTMLElement | null;
const titles = (host: Element) => [...host.querySelectorAll('.menu-scroll .menu-item .menu-title')].map((t) => t.textContent);

test('the chip is the one of this Mac, read from the machine: its default branch with a worktree, the switch sets the default for later chats', async () => {
  reset({ newChatWorktree: true });
  const { host, unmount } = await render(chip());
  await flush();
  assert.deepEqual(asked, [['box', { path: '/srv/app' }]]);
  assert.equal(branchBtn(host)!.textContent, 'main');
  assert.equal(branchBtn(host)!.getAttribute('aria-label'), 'Branch: main');
  assert.equal(branchBtn(host)!.title, 'Branch the worktree starts from');
  assert.equal(host.querySelector('.ctx-check')!.getAttribute('title'), 'Run this chat in an isolated git worktree');
  assert.ok(host.querySelector('.ctx-check .checkbox svg'));
  await click(host.querySelector('.ctx-check input'));
  assert.equal(store.getState().prefs.worktreeDefault, false);
  assert.equal(branchBtn(host)!.textContent, 'feature');
  assert.equal(branchBtn(host)!.title, 'Branch to work on');
  assert.deepEqual(local, [], 'nothing was read from this Mac');
  await unmount();
});

test("picking a branch sets it for the machine's folder; the search is a branch search, never a pull request or issue lookup on this Mac", async () => {
  reset({ newChatWorktree: true });
  const { host, unmount } = await render(chip());
  await flush();
  await click(branchBtn(host));
  await flush();
  assert.equal(asked.length, 2, 'opening the picker reads the branches again');
  assert.deepEqual(titles(host), ['main', 'feature', 'dev']);
  assert.equal((host.querySelector('.menu-search input') as HTMLInputElement).placeholder, 'Search branches…');
  await click([...host.querySelectorAll('.menu-scroll .menu-item')].find((r) => r.textContent?.includes('dev')));
  assert.deepEqual(store.getState().newChatBranch, { path: KEY, branch: 'dev' });
  assert.equal(branchBtn(host)!.textContent, 'dev');
  assert.deepEqual(local, []);
  assert.equal(linear, 0, 'no issue tracker is asked');
  await unmount();
});

test('a folder that is no repository, a repository with no commit, a Host from before the branch calls and an unreachable machine', async () => {
  reset();
  answer = { value: { isRepo: false } };
  let v = await render(chip());
  await flush();
  assert.equal(v.host.innerHTML, '', 'no repository: no chip');
  await v.unmount();
  answer = { value: { ...REPO, commits: false } };
  v = await render(chip());
  await flush();
  assert.equal((v.host.querySelector('.ctx-check input') as HTMLInputElement).disabled, true);
  assert.match(v.host.querySelector('.ctx-check')!.getAttribute('title')!, /^Worktree unavailable/);
  await v.unmount();
  for (const refusal of [{ error: { code: 'host_outdated', message: 'Update it.' } }, new Error('unreachable')]) {
    answer = refusal;
    v = await render(chip());
    await flush();
    assert.equal(v.host.innerHTML, '');
    await v.unmount();
  }
});
