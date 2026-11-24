// Settings → Connections (SSH), Git, Worktrees with local environments, and Archived chats.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  calls,
  ctl,
  responses,
  resetCtl,
  defaultState,
  useStore,
  render,
  click,
  text,
  button,
  row,
  options,
  setValue,
  key,
  flush,
  lastPrefs,
  toggle,
} from './support/settings-harness.ts';
import { defined } from './support/defined.ts';

await setup();
const { createElement: h } = await import('react');
const { Settings, SshConnections } = await import('../src/components/pages/Settings.tsx');

const prefs = (p: any) => useStore.setState({ prefs: { ...useStore.getState().prefs, ...p } });
const section = (s: string) => render(h(Settings, { section: s }));
beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState(), true);
});

test('ssh hosts: add with validation, connect in a terminal, and remove', async () => {
  useStore.setState({ route: { name: 'settings', section: 'connections', tab: 'ssh' } } as any);
  const { host, unmount } = await section('connections');
  assert.match(text(host), /Connect to a remote device/);
  await click(button(host, 'Add'));
  const input = () => row(host, 'Host').querySelector('input')!;
  await setValue(input(), 'bad host!');
  await key(input(), { key: 'Enter' });
  assert.deepEqual(calls.at(-1), ['toast', 'Enter a host like user@example.com', 'error']);
  await setValue(input(), ' me@box ');
  await key(input(), { key: 'x' });
  await click(button(host, 'Save'));
  assert.deepEqual(lastPrefs(), { sshHosts: ['me@box'] });
  assert.ok(row(host, 'me@box'));
  await click(button(row(host, 'Add another host'), 'Add'));
  await setValue(input(), 'me@box');
  await key(input(), { key: 'Enter' });
  assert.deepEqual(lastPrefs(), { sshHosts: ['me@box'] });
  await click(button(row(host, 'me@box'), 'Connect'));
  assert.deepEqual(calls.slice(-2), [
    ['openPaneTab', 'terminal', { title: 'me@box', cwd: '/Users/me', command: ['/usr/bin/ssh', 'me@box'] }],
    ['navigate', { name: 'home' }],
  ]);
  useStore.setState({ home: null });
  await click(button(row(host, 'me@box'), 'Connect'));
  assert.equal(defined(calls.at(-2))[2].cwd, '/');
  await click(button(row(host, 'me@box'), 'Remove'));
  assert.deepEqual(lastPrefs(), { sshHosts: [] });
  await unmount();
});

test('connectors: the built-in connectors and Quick Actions are their own page, not part of Connections', async () => {
  responses['plugins.builtin.list'] = [{ id: 'github', title: 'GitHub', description: 'Official server.', version: '2.0.3', state: 'off' }];
  responses['app.quickActions.status'] = { state: 'off', installed: 0, total: 3 };
  const { host, unmount } = await section('connectors');
  assert.match(text(host), /Built-in connectors.*GitHub.*macOS.*Quick Actions/);
  await unmount();
  const connections = await section('connections');
  assert.doesNotMatch(text(connections.host), /Built-in connectors|Quick Actions/);
  await connections.unmount();
});

test('ssh: while adding with saved hosts, the add-another row is hidden', async () => {
  prefs({ sshHosts: ['a@b'] });
  const { host, unmount } = await render(h(SshConnections));
  assert.equal(host.querySelector('.connections-empty'), null);
  await click(button(row(host, 'Add another host'), 'Add'));
  assert.throws(() => row(host, 'Add another host'));
  assert.ok(row(host, 'Host'));
  await unmount();
});

test('git branch prefix edits the pref', async () => {
  const { host, unmount } = await section('git');
  await setValue(row(host, 'Branch prefix').querySelector('input')!, 'me/');
  assert.deepEqual(lastPrefs(), { branchPrefix: 'me/' });
  await toggle(host, 'Show only last turn changes');
  assert.deepEqual(lastPrefs(), { changesLastTurnOnly: true });
  await unmount();
});

test('worktrees list loads, refreshes, opens, and the options write prefs', async () => {
  let resolve!: (v: any) => void;
  responses['git.worktreeList'] = () => new Promise((r) => (resolve = r));
  const { host, unmount } = await section('git');
  assert.equal(calls.find((c) => c[0] === 'git.worktreeList')![1], '/Users/me/.mopilot/worktrees');
  assert.ok(host.querySelector('.settings-pad .spinner, .settings-pad svg, .settings-pad'));
  assert.match(text(host), /No worktrees yet/);
  resolve([
    { path: '/w/one', branch: 'b1' },
    { path: '/w/two', branch: null },
  ]);
  await flush();
  assert.match(text(host), /2 worktrees/);
  assert.equal(text(row(host, 'two').querySelector('.settings-row-desc')), ' · /w/two'.trim());
  await click(button(row(host, 'one'), 'Open'));
  assert.deepEqual(calls.at(-1), ['shell.openPath', '/w/one']);
  // a list that couldn't be read says so with Retry, instead of claiming there are no worktrees
  responses['git.worktreeList'] = () => Promise.reject(new Error('no git'));
  await click(host.querySelector('[title=Refresh]')!);
  await flush();
  assert.equal(text(host.querySelector('[role="alert"]')!), "Couldn't list the worktrees: no git Retry");
  assert.doesNotMatch(text(host), /No worktrees yet|will appear here/);
  responses['git.worktreeList'] = [];
  await click(button(host.querySelector('[role="alert"]')!, 'Retry'));
  await flush();
  assert.equal(host.querySelector('[role="alert"]'), null);
  assert.match(text(host), /Worktrees created by MoPilot will appear here/);
  const root = row(host, 'Worktree root').querySelector('input')!;
  assert.equal(root.getAttribute('placeholder'), '/Users/me/.mopilot/worktrees');
  await setValue(root, '/x');
  assert.deepEqual(lastPrefs(), { worktreeRoot: '/x' });
  // a folder that isn't a full path says so (main can't make worktrees there); ~ is the home folder
  for (const [typed, bad] of [
    ['worktrees', true],
    ['~/wt', false],
    ['~', false],
    ['C:\\wt', false],
    ['/x', false],
  ] as const) {
    prefs({ worktreeRoot: typed });
    await flush();
    assert.equal(/Use a full path/.test(text(row(host, 'Worktree root'))), bad, typed);
  }
  // the Codex app's own worktree folder says why it can't be used: the app deletes worktrees there (main refuses it)
  const codexOwned = /The Codex app deletes worktrees in its own folder/;
  const codexHomeBefore = useStore.getState().codexHome;
  useStore.setState({ codexHome: null });
  prefs({ worktreeRoot: '~/.codex/worktrees' });
  await flush();
  // until Codex reports where its folder is, nothing can be said about it
  assert.doesNotMatch(text(row(host, 'Worktree root')), codexOwned);
  useStore.setState({ codexHome: '/Users/me/.codex' });
  for (const [typed, owned] of [
    ['~/.codex/worktrees', true],
    ['/Users/me/.codex/worktrees/', true],
    ['/Users/me/.codex/worktrees/mine', true],
    ['/Users/me/.codex/worktrees-mine', false],
    ['/Users/me/.codex', false],
    ['worktrees', false],
  ] as const) {
    prefs({ worktreeRoot: typed });
    await flush();
    assert.equal(codexOwned.test(text(row(host, 'Worktree root'))), owned, typed);
  }
  useStore.setState({ codexHome: codexHomeBefore });
  await setValue(row(host, 'Worktree root').querySelector('input')!, '');
  assert.deepEqual(lastPrefs(), { worktreeRoot: null });
  assert.equal(text(host).includes('Fetch before creating'), false);
  await toggle(host, 'Delete old worktrees');
  assert.deepEqual(lastPrefs(), { autoDeleteWorktrees: true });
  // off at first; on, an archive removes the worktree and deletes its branch when nothing on them is lost
  await toggle(host, 'Delete branch on archive');
  assert.deepEqual(lastPrefs(), { deleteBranchOnArchive: true });
  await setValue(row(host, 'Worktrees to keep').querySelector('input')!, '4');
  assert.deepEqual(lastPrefs(), { autoDeleteLimit: 4 });
  await setValue(row(host, 'Worktrees to keep').querySelector('input')!, '');
  assert.deepEqual(lastPrefs(), { autoDeleteLimit: 15 });
  await unmount();
});

test('worktrees: only the latest list is shown when an earlier read answers late', async () => {
  const reads: ((v: any) => void)[] = [];
  responses['git.worktreeList'] = () => new Promise((r) => reads.push(r));
  const { host, unmount } = await section('git');
  await click(host.querySelector('[title=Refresh]')!);
  reads[1]([{ path: '/w/new', branch: 'b' }]);
  await flush();
  reads[0]([{ path: '/w/old', branch: 'a' }]);
  await flush();
  assert.match(text(host), /1 worktree/);
  assert.ok(row(host, 'new'));
  assert.throws(() => row(host, 'old'));
  await unmount();
});

test("local environments: an environment file that can't be read says why and offers no editor to save over it", async () => {
  responses['git.worktreeList'] = [];
  useStore.setState({ savedProjects: [{ id: 'p1', name: 'Proj', roots: [{ path: '/w/p' }] }] });
  ctl.env = new Error('EACCES');
  const { host, unmount } = await section('git');
  await click(button(host, 'Environments'));
  await click(row(host, 'Proj'));
  await flush();
  assert.equal(text(host.querySelector('[role="alert"]')!), "Couldn't read Proj's environment: EACCES");
  assert.equal(host.querySelector('textarea'), null);
  await click(host.querySelector('.link-muted')!);
  // an answer for an editor that was left is dropped, whether it read or failed
  for (const late of ['read', 'failed'] as const) {
    let settle!: { resolve: (v: any) => void; reject: (e: Error) => void };
    ctl.env = () => new Promise((resolve, reject) => (settle = { resolve, reject }));
    await click(row(host, 'Proj'));
    await click(button(host, 'General'));
    if (late === 'read') settle.resolve(null);
    else settle.reject(new Error('late'));
    await flush();
    assert.equal(host.querySelector('[role="alert"]'), null);
    await click(button(host, 'Environments'));
  }
  await unmount();
});

test('local environments: pick a project, add one, and edit then save its environment', async () => {
  responses['git.worktreeList'] = [];
  useStore.setState({ savedProjects: [{ id: 'p1', name: 'Proj', roots: [{ path: '/w/p' }] }] });
  const { host, unmount } = await section('git');
  await click(button(host, 'Environments'));
  assert.ok(host.querySelector('.tabs-seg .on') && text(host.querySelector('.tabs-seg .on')) === 'Environments');
  await click(host.querySelector('.env-lead a')!);
  assert.deepEqual(calls.at(-1), ['shell.openExternal', 'https://developers.openai.com/codex']);
  responses['dialog.openFolder'] = null;
  await click(button(host, 'Add project'));
  assert.equal(
    calls.some((c) => c[0] === 'createProject'),
    false,
  );
  responses['dialog.openFolder'] = '/w/new';
  await click(button(host, 'Add project'));
  assert.deepEqual(calls.at(-1), ['createProject', '/w/new']);
  let read!: (v: any) => void;
  ctl.env = null;
  await click(row(host, 'Proj'));
  await flush();
  assert.equal(defined(calls.find((c) => c[0] === 'resolveEnvironment'))[1], '/w/p');
  // nothing to read yet: the editor starts blank and says saving creates the file
  assert.equal(
    calls.some((c) => c[0] === 'readEnvironment'),
    false,
  );
  assert.equal(
    text(host.querySelector('[data-env-source]')),
    'No environment yet; saving creates /w/p/.codex/environments/environment.toml',
  );
  assert.match(text(host), /\/w\/p\/\.codex\/environments\/environment\.toml/);
  const save = () => button(host, 'Save');
  assert.ok(save().disabled);
  assert.match(text(host), /No actions/);
  await setValue(row(host, 'Name').querySelector('input')!, 'Env');
  const [setupBox, cleanupBox] = host.querySelectorAll('textarea');
  assert.equal(cleanupBox.value, '');
  await setValue(setupBox, 'npm ci');
  await setValue(cleanupBox, 'rm -rf x');
  await click(button(host, 'Add action'));
  await click(button(host, 'Add action'));
  const action = (i: number) => host.querySelectorAll('.env-action')[i];
  await setValue(action(0).querySelector('select')!, 'test', 'change');
  await setValue(action(0).querySelectorAll('input')[0], 'Test');
  await setValue(action(0).querySelectorAll('input')[1], 'npm test');
  // a removed action takes its own inputs with it: the action after it keeps its elements (focus, undo history)
  await click(button(host, 'Add action'));
  await setValue(action(2).querySelectorAll('input')[0], 'Last');
  const lastName = action(2).querySelectorAll('input')[0];
  await click(action(1).querySelector('[aria-label="Remove action"]')!);
  assert.equal(action(1).querySelectorAll('input')[0], lastName);
  assert.equal((lastName as HTMLInputElement).value, 'Last');
  await click(action(1).querySelector('[aria-label="Remove action"]')!);
  assert.equal(host.querySelectorAll('.env-action').length, 1);
  assert.ok(!save().disabled);
  await click(save());
  await flush();
  assert.deepEqual(
    calls.find((c) => c[0] === 'writeEnvironment'),
    [
      'writeEnvironment',
      '/w/p',
      {
        version: 1,
        name: 'Env',
        setup: { script: 'npm ci' },
        cleanup: { script: 'rm -rf x' },
        actions: [{ name: 'Test', icon: 'test', command: 'npm test' }],
      },
    ],
  );
  assert.deepEqual(calls.at(-1), ['toast', 'Environment saved']);
  assert.ok(save().disabled);
  // the saved file is the project's source from here on
  assert.equal(text(host.querySelector('[data-env-source]')), 'Source: /w/p/.codex/environments/environment.toml');
  ctl.writeEnv = async () => {
    throw new Error('disk full');
  };
  await setValue(row(host, 'Name').querySelector('input')!, 'Env2');
  await click(save());
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', 'disk full', 'error']);
  ctl.writeEnv = async () => {
    throw 'denied';
  };
  await click(save());
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', 'denied', 'error']);
  await click(host.querySelector('.env-head .link-muted')!);
  assert.ok(row(host, 'Proj'));
  await click(button(host, 'General'));
  assert.ok(row(host, 'Worktree root'));
  await click(button(host, 'Environments'));
  // an environment file with actions but no icon shows the default icon
  ctl.env = { version: 1, name: 'Saved', setup: { script: '' }, cleanup: { script: 'bye' }, actions: [{ name: 'Run', command: 'go' }] };
  await click(row(host, 'Proj'));
  await flush();
  assert.equal((host.querySelector('.env-action select') as HTMLSelectElement).value, 'tool');
  assert.equal(host.querySelectorAll('textarea')[1].value, 'bye');
  ctl.env = { version: 1, name: 'NoActions', setup: { script: '' } };
  await click(host.querySelector('.env-head .link-muted')!);
  await click(row(host, 'Proj'));
  await flush();
  assert.match(text(host), /No actions/);
  void read;
  await unmount();
});

const archived = [
  { id: 't1', title: 'Beta', cwd: '/w/p/sub', updatedAt: 300 },
  { id: 't2', title: 'Alpha', cwd: '/elsewhere/proj2', updatedAt: 200, createdAt: 30 },
  { id: 't3', title: 'Gamma', cwd: null, updatedAt: 100 },
  { id: 't4', cwd: '/w/p', updatedAt: 50, createdAt: 20 },
];

test('archived chats load, group by project, filter, sort, restore and delete', async () => {
  let done!: () => void;
  ctl.archivedLoad = () => new Promise<any[]>((r) => (done = () => r([])));
  useStore.setState({ archived, savedProjects: [{ id: 'p1', name: 'Proj', roots: [{ path: '/w/p' }] }] });
  const { host, unmount } = await section('archived');
  assert.equal(host.querySelector('.archived-bar'), null);
  done();
  await flush();
  const heads = () => [...host.querySelectorAll('.archived-group-head')].map(text);
  assert.deepEqual(heads(), ['Proj2 chats', 'proj21 chat', '/1 chat']);
  const titles = () => [...host.querySelectorAll('.settings-row-title')].map(text);
  assert.deepEqual(titles(), ['Beta', 'Untitled', 'Alpha', 'Gamma']);
  const sort = host.querySelector('.archived-bar')!;
  await click(sort.querySelectorAll('.select-btn')[0]);
  await click([...sort.querySelectorAll('.menu-item')].find((b) => text(b) === 'Created')!);
  assert.match(text(sort), /Sort: Created/);
  assert.deepEqual(titles(), ['Alpha', 'Untitled', 'Beta', 'Gamma']);
  await click([...sort.querySelectorAll('.menu-item')].find((b) => text(b) === 'Alphabetical')!);
  assert.match(text(sort), /Sort: Alphabetical/);
  assert.deepEqual(titles(), ['Alpha', 'Beta', 'Untitled', 'Gamma']);
  await click([...sort.querySelectorAll('.menu-item')].find((b) => text(b) === 'Updated')!);
  await click(sort.querySelectorAll('.select-btn')[0]);
  await setValue(host.querySelector('.archived-bar input')!, 'ALP');
  assert.deepEqual(titles(), ['Alpha']);
  await setValue(host.querySelector('.archived-bar input')!, '');
  await click(sort.querySelectorAll('.select-btn')[1]);
  assert.deepEqual(options(sort), ['All projects', 'Proj']);
  await click([...sort.querySelectorAll('.menu-item')][1]);
  assert.deepEqual(titles(), ['Beta', 'Untitled']);
  await click(button(row(host, 'Beta'), 'Unarchive'));
  await flush();
  assert.deepEqual(calls.slice(-2), [
    ['unarchiveThread', 't1'],
    ['toast', 'Chat restored'],
  ]);
  ctl.confirm = false;
  await click(row(host, 'Beta').querySelectorAll('button')[1]);
  assert.equal(
    calls.some((c) => c[0] === 'deleteThread'),
    false,
  );
  ctl.confirm = true;
  await click(row(host, 'Beta').querySelectorAll('button')[1]);
  assert.deepEqual(calls.at(-1), ['deleteThread', 't1']);
  // a restore or delete that fails says so instead of claiming success or doing nothing
  ctl.unarchiveError = new Error('still archived in Codex');
  await click(button(row(host, 'Beta'), 'Unarchive'));
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', "Couldn't restore chat: still archived in Codex", 'error']);
  ctl.deleteError = new Error('locked');
  await click(row(host, 'Beta').querySelectorAll('button')[1]);
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', "Couldn't delete chat: locked", 'error']);
  ctl.unarchiveError = 'plain';
  ctl.deleteError = 'plain';
  await click(button(row(host, 'Beta'), 'Unarchive'));
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', "Couldn't restore chat: plain", 'error']);
  await click(row(host, 'Beta').querySelectorAll('button')[1]);
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', "Couldn't delete chat: plain", 'error']);
  await setValue(host.querySelector('.archived-bar input')!, 'zzz');
  assert.match(text(host), /No archived chats/);
  await unmount();
});

test("archived chats a harness couldn't list are named with Retry instead of passing the rest off as the whole archive", async () => {
  ctl.archivedLoad = async () => [
    { source: 'Codex', error: 'not connected' },
    { source: 'Kimi Code', error: 'gone' },
  ];
  useStore.setState({ archived: [], savedProjects: [] });
  const { host, unmount } = await section('archived');
  await flush();
  const alerts = () => [...host.querySelectorAll('[role="alert"]')].map(text);
  assert.deepEqual(alerts(), [
    "Couldn't load the archived Codex chats: not connected Retry",
    "Couldn't load the archived Kimi Code chats: gone Retry",
  ]);
  assert.doesNotMatch(text(host), /No archived chats/, 'an unread list is not an empty archive');
  // Retry reads every list again; one that loads now clears its notice
  ctl.archivedLoad = async () => [];
  const before = calls.filter((c) => c[0] === 'loadArchived').length;
  await click(button(host.querySelector('[role="alert"]')!, 'Retry'));
  await flush();
  assert.equal(calls.filter((c) => c[0] === 'loadArchived').length, before + 1);
  assert.deepEqual(alerts(), []);
  assert.match(text(host), /No archived chats/);
  await unmount();
});
