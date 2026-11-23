// The summary panel for a chat whose folder is on a machine: no branch, changes or pull request is read on this Mac, the panel says so, and "Open in" is not offered for a path that is not here.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { one } from './support/shell-panels-kit.ts';
import { summaryPanelKit } from './support/summary-panel-kit.ts';

let state: { machine: { id: string; name: string; away: boolean } | null; pending: boolean } = { machine: null, pending: false };
mock.module('../src/lib/chatMachine.ts', {
  namedExports: {
    useLocalFolder: (_id: string, cwd: string) => ({ ...state, cwd: state.machine || state.pending ? '' : cwd }),
  },
});
let remote: any = null;
const reads: unknown[][] = [];
let refreshes = 0;
mock.module('../src/lib/hostRepo.ts', {
  namedExports: { useRemoteRepo: (...a: unknown[]) => (reads.push(a), { repo: remote, refresh: () => refreshes++ }) },
});
const kit = await summaryPanelKit();
const { calls, reset, mount } = kit;
const { act } = await import('react');

test('a folder on a machine is shown by name, read nowhere here, and has no Open in items', async () => {
  reset({ t1: { cwd: '/srv/app' } }, { t1: { turns: [] } });
  state = { machine: { id: 'ssh:me@box', name: 'box', away: false }, pending: false };
  remote = { state: 'loading' };
  const { host, unmount } = await mount();
  assert.equal(host.querySelector('.summary-project')!.textContent, 'app');
  assert.equal(host.querySelector('.summary-project')!.getAttribute('title'), '/srv/app');
  assert.deepEqual(calls, [], 'no git or gh call for the machine’s path');
  // the machine's Host has not answered yet: nothing is drawn for the changes
  assert.equal(host.querySelector('.machine-folder-note'), null);
  assert.equal(host.textContent!.includes('Branch changes'), false);
  assert.equal(reads[0][1], '/srv/app', 'the machine is asked about its own folder');
  await act(() => one(host, '.icon-btn').click());
  const items = [...document.querySelectorAll('[role="menuitem"]')].map((n) => n.textContent);
  assert.equal(
    items.some((t) => /Open in/.test(t ?? '')),
    false,
  );
  assert.ok(items.some((t) => /Open terminal/.test(t ?? '')));
  assert.ok(!items.includes('Track pull request…'));
  await unmount();
});

test('a machine with no ssh from this Mac has no Open terminal (audit turn:T63)', async () => {
  reset({ t1: { cwd: '/srv/app' } }, { t1: { turns: [] } });
  state = { machine: { id: 'relay:abc', name: 'far', away: false }, pending: false };
  remote = { state: 'loading' };
  const { host, unmount } = await mount();
  await act(() => one(host, '.icon-btn').click());
  const items = [...document.querySelectorAll('[role="menuitem"]')].map((n) => n.textContent);
  assert.equal(
    items.some((t) => /Open terminal/.test(t ?? '')),
    false,
  );
  const before = refreshes;
  await act(() => one(host, '[role="menuitem"]', 'Refresh').click());
  assert.equal(refreshes, before + 1);
  assert.deepEqual(calls, []);
  await unmount();
});

test('a Host worktree shows its repository name and the actual checkout path', async () => {
  const cwd = 'C:\\work\\mopilot.worktrees\\mopilot%2fc1c2b568';
  reset({ t1: { cwd } }, { t1: { turns: [] } });
  state = { machine: { id: 'm', name: 'box', away: false }, pending: false };
  remote = {
    state: 'ready',
    branch: 'mopilot/c1c2b568',
    remote: 'git@github.com:mopilot-ai/mopilot.git',
    files: 0,
    added: 0,
    removed: 0,
    untracked: 0,
    truncated: false,
  };
  const r = await mount();
  assert.equal(one(r.host, '.summary-project').textContent, 'mopilot');
  assert.equal(one(r.host, '.summary-project').title, cwd);
  assert.equal(one(r.host, '.summary-branch').textContent, 'mopilot/c1c2b568');
  assert.deepEqual(calls, []);
  await r.unmount();
});

test('while the owner is not known the folder is not read either, and a chat on this Mac still is', async () => {
  reset({ t1: { cwd: '/srv/app' } }, { t1: { turns: [] } });
  state = { machine: null, pending: true };
  let m = await mount();
  assert.deepEqual(calls, []);
  await m.unmount();
  state = { machine: null, pending: false };
  m = await mount();
  assert.equal(calls[0]?.[0], 'info');
  await m.unmount();
});

test('the machine’s branch is in the header and its changes are the Host’s: ready, an offline machine, a refusal, and a folder that is no repository', async () => {
  reset({ t1: { cwd: '/srv/app' } }, { t1: { turns: [] } });
  state = { machine: { id: 'm', name: 'box', away: false }, pending: false };
  remote = { state: 'ready', branch: 'feature', files: 2, added: 5, removed: 1, untracked: 0, truncated: false };
  let v = await mount();
  assert.equal(v.host.querySelector('.summary-branch')!.textContent, 'feature');
  assert.equal(one(v.host, '.summary-row', 'Branch changes').querySelector('.diff-stat')!.textContent, '+5 -1');
  assert.deepEqual(calls, [], 'still nothing read on this Mac');
  await v.unmount();
  // no branch while the machine has not answered
  remote = { state: 'loading' };
  v = await mount();
  assert.equal(v.host.querySelector('.summary-branch'), null);
  await v.unmount();
  state = { machine: { id: 'm', name: 'box', away: true }, pending: false };
  remote = null;
  v = await mount();
  assert.equal(one(v.host, '.machine-folder-note').textContent, "Branch and changes aren't available while box is offline.");
  await v.unmount();
});
