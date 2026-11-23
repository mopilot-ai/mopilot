// src/store/store.ts: toasts, navigation, panes, helpers and the harness choice for new chats.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, flush } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, resetState } = await loadStore();
const chats = await import('../src/store/chats.ts');
const selections = await import('../shared/selections.mjs');
const { noteOwner } = await import('../src/harness/ownership.ts');
const S = store;
const [[idleFn]] = callsOf('codex.codexIsIdle');
const st = () => S.useStore.getState();
const set = S.useStore.setState;

beforeEach(() => {
  resetState();
  resetAll();
});

test('toasts go away after their time: longer with an action, or as asked', () => {
  S.toast('plain');
  S.toast('act', 'error', { action: { label: 'Undo', run: () => {} } });
  S.toast('long', 'success', { duration: 20000 });
  assert.deepEqual(
    st().toasts.map((t) => [t.text, t.kind, !!t.action]),
    [
      ['plain', 'info', false],
      ['act', 'error', true],
      ['long', 'success', false],
    ],
  );
  mock.timers.tick(3200);
  assert.deepEqual(
    st().toasts.map((t) => t.text),
    ['act', 'long'],
  );
  mock.timers.tick(4800);
  assert.deepEqual(
    st().toasts.map((t) => t.text),
    ['long'],
  );
  mock.timers.tick(20000);
  assert.deepEqual(st().toasts, []);
});

test('toastFailure says what the user asked for failed, and why, without the IPC wrapper', () => {
  S.toastFailure("Couldn't rename the project")(new Error("Error invoking remote method 'projects:rename': Error: no such project"));
  S.toastFailure("Couldn't copy")('denied');
  assert.deepEqual(
    st().toasts.map((t) => [t.text, t.kind]),
    [
      ["Couldn't rename the project: no such project", 'error'],
      ["Couldn't copy: denied", 'error'],
    ],
  );
  mock.timers.tick(3200);
});

test('navigate keeps history; back and forward move through it and open chats', async () => {
  noteOwner('t1', 'claude');
  set({ runtime: { t1: { loaded: true } as any } });
  S.navigate({ name: 'settings' });
  S.navigate({ name: 'settings' });
  assert.equal(st().back.length, 1);
  S.navigate({ name: 'thread', id: 't1' });
  assert.deepEqual(st().route, { name: 'thread', id: 't1' });
  S.goBack();
  assert.deepEqual(st().route, { name: 'settings' });
  assert.equal(st().forward.length, 1);
  S.goForward();
  assert.deepEqual(st().route, { name: 'thread', id: 't1' });
  S.goForward();
  S.goBack();
  S.goBack();
  assert.deepEqual(st().route, { name: 'home' });
  S.goBack();
  assert.deepEqual(st().route, { name: 'home' });
  S.goForward();
  S.goForward();
  assert.deepEqual(st().route, { name: 'thread', id: 't1' });
  S.goBack();
  set({ forward: [{ name: 'home' }, { name: 'thread', id: 't1' }] as any });
  S.goForward();
  S.goForward();
  assert.deepEqual(st().route, { name: 'thread', id: 't1' });
  set({ back: [{ name: 'thread', id: 't1' }], route: { name: 'home' } });
  S.goBack();
  assert.deepEqual(st().route, { name: 'thread', id: 't1' });
  // a claude chat already loaded isn't read again
  assert.equal(callsOf('claude.openClaudeThread').length, 0);
});

test('the chats on screen are reported to main, from the route or the active chat tab', async () => {
  let fail = true;
  impl['app.viewing'] = () => (fail ? ((fail = false), Promise.reject(new Error('x'))) : Promise.resolve());
  set({ route: { name: 'thread', id: 'v1' } as any, runtime: { v1: { loaded: true } as any } });
  noteOwner('v1', 'claude');
  set({ route: { name: 'home' } });
  set({ paneTabs: [{ id: 'c', kind: 'chat', threadId: 'side' }], paneActive: 'c', diffPanel: { open: true } });
  set({ paneTabs: [{ id: 'c', kind: 'chat' }], paneActive: 'c' });
  set({ paneTabs: [{ id: 'b', kind: 'browser' }], paneActive: 'b' });
  await flush();
  assert.deepEqual(
    callsOf('app.viewing').map(([v]) => `${v.visible}|${v.primary}|${v.focused}`),
    ['v1|v1|v1', '|null|null', 'side|side|side', '|null|null'],
  );
});

test('notify says whether the chat is in view, with its title', () => {
  set({ threads: { a: { id: 'a', name: 'Alpha' } as any }, route: { name: 'thread', id: 'a' }, focused: true });
  S.notify('turn', 'a', { title: 'x' } as any);
  set({ focused: false });
  S.notify('turn', 'a', { title: 'x' } as any);
  set({
    route: { name: 'home' },
    focused: true,
    paneTabs: [{ id: 'c', kind: 'chat', threadId: 'a' }],
    paneActive: 'c',
    diffPanel: { open: true },
  });
  S.notify('turn', 'a', { title: 'x' } as any);
  set({ paneTabs: [{ id: 'f', kind: 'files' }], paneActive: 'f' });
  S.notify('turn', 'a', { title: 'x' } as any);
  set({ diffPanel: { open: false } });
  S.notify('turn', 'b', { title: 'x' } as any);
  assert.deepEqual(
    callsOf('app.notify').map(([, id, o]) => [id, o.chatTitle, o.viewing]),
    [
      ['a', 'Alpha', true],
      ['a', 'Alpha', false],
      ['a', 'Alpha', true],
      ['a', 'Alpha', false],
      ['b', 'New chat', false],
    ],
  );
});

test('setPrefs merges, and tells main about a theme', () => {
  S.setPrefs({ fontSize: 20 });
  S.setPrefs({ theme: 'dark' });
  assert.equal(st().prefs.fontSize, 20);
  assert.deepEqual(callsOf('app.setTheme'), [['dark']]);
});

test('patchRuntime and patchTurn create what is missing and merge what is there', () => {
  S.patchRuntime('a', () => ({ error: 'e' }));
  assert.equal(st().runtime.a.error, 'e');
  assert.equal(st().runtime.a.loaded, false);
  S.patchTurn('a', 't1', () => ({ status: 'completed' }));
  S.patchTurn('a', 't2', () => ({}));
  S.patchTurn('a', 't1', (t) => ({ diff: `${t.status}!` }));
  assert.deepEqual(
    st().runtime.a.turns.map((t) => [t.id, t.status, t.diff]),
    [
      ['t1', 'completed', 'completed!'],
      ['t2', 'inProgress', undefined],
    ],
  );
  const t = S.newTurn('x');
  assert.equal(t.status, 'inProgress');
  assert.equal(S.turnFromServer({ id: 'z', status: 'completed', items: [] } as any).id, 'z');
});

test('upsertThread adds new chats first and moves one up only when bumped', () => {
  S.upsertThread({ id: 'a', name: 'A' } as any);
  S.upsertThread({ id: 'b' } as any);
  S.upsertThread({ id: 'a', preview: 'p' } as any);
  assert.deepEqual(st().threadOrder, ['b', 'a']);
  assert.equal((st().threads.a as any).name, 'A');
  S.upsertThread({ id: 'a' } as any, true);
  assert.deepEqual(st().threadOrder, ['a', 'b']);
});

test('threadTitle prefers the name, then a delegation input, then the first line of the preview', () => {
  assert.equal(S.threadTitle(null), 'New chat');
  assert.equal(S.threadTitle({ name: 'Named', preview: 'x' } as any), 'Named');
  assert.equal(S.threadTitle({ preview: '\n  first line  \nsecond' } as any), 'first line');
  // a long first line is cut before an emoji, not through it
  assert.equal(S.threadTitle({ preview: `${'x'.repeat(119)}🙂 more` } as any), 'x'.repeat(119));
  assert.equal(S.threadTitle({ preview: '<realtime_delegation><input>do it\nnow</input></realtime_delegation>' } as any), 'do it');
  assert.equal(S.threadTitle({ preview: '<realtime_delegation></realtime_delegation>' } as any), 'New chat');
  assert.equal(S.threadTitle({} as any), 'New chat');
});

test('chatOf and nativeOf follow a chat across its segments', () => {
  assert.equal(S.chatOf('x'), 'x');
  set({
    segments: {
      chat: [
        { nativeId: 'chat', harness: 'codex', start: 0 },
        { nativeId: 'cl', harness: 'claude', start: 2 },
      ] as any,
    },
  });
  assert.equal(S.chatOf('cl'), 'chat');
  assert.equal(S.chatOf('cl'), 'chat');
  assert.equal(S.nativeOf('chat'), 'cl');
  assert.equal(S.nativeOf('solo'), 'solo');
  assert.equal(S.chatFamily('chat'), 'claude');
  assert.deepEqual([...S.segmentNatives(st().segments)], ['cl']);
  set({ segments: { k: [{ nativeId: 'acp:kimi:1', harness: 'codex', start: 0 }] as any } });
  assert.equal(S.chatBasicHarness('k'), 'kimi');
  assert.equal(S.chatBasicHarness('acp:qwen:2'), 'qwen');
  assert.equal(S.chatBasicHarness('plain'), null);
  impl['acp.acpLabelOf'] = (id) => `label ${id}`;
  assert.equal(S.chatHarnessLabel('k'), 'label acp:kimi:1');
  assert.equal(S.chatHarnessLabel('plain'), 'Codex');
});

test('which harnesses are usable, and the one new chats start on', () => {
  const ready = { conn: 'ready' as const, requiresAuth: false, codexCompat: null };
  set(ready);
  assert.equal(S.codexUsable(), true);
  set({ codexCompat: { versionStatus: 'tooOld' } as any });
  assert.equal(S.codexUsable(), false);
  set({ codexCompat: { versionStatus: 'ok', probes: { 'codex.goals': false }, flags: {}, cliVersion: '1' } as any });
  assert.match(S.blockedReason(null, 'goal')!, /./);
  noteOwner('cc', 'claude');
  assert.equal(S.blockedReason('cc', 'goal'), null);
  assert.equal(S.blockedReason('cx', 'compact'), null);
  assert.match(S.blockedReason('cx', 'goal')!, /./);
  // Codex's failed probe is Codex's: a basic harness's chat is not greyed out by it
  assert.equal(S.blockedReason('acp:kimi:1', 'goal'), null);
  assert.deepEqual(
    ['cx', 'cc', 'acp:kimi:1'].map((id) => S.chatFamily(id)),
    ['codex', 'claude', 'acp'],
  );
  // a new chat on a picked basic harness neither; a temporary one runs on Claude Code (it keeps the chat off disk)
  assert.deepEqual([S.newChatFamily(), S.newChatKind()], ['codex', 'codex']);
  set({ prefs: { ...st().prefs, defaultHarness: 'acp:kimi' }, basicHarnesses: [{ id: 'kimi', state: 'admitted' }] as any });
  assert.deepEqual([S.newChatFamily(), S.newChatKind()], ['acp', 'acp:kimi']);
  assert.equal(S.blockedReason(null, 'goal'), null);
  set({ newChatTemporary: true });
  assert.deepEqual([S.newChatFamily(), S.newChatKind()], ['claude', 'claude']);
  assert.equal(S.blockedReason(null, 'goal'), null);
  // what the caller picks is checked there: Codex's own probe
  assert.match(chats.harnessBlocked('codex', 'goal')!, /./);
  set({ newChatTemporary: false, prefs: { ...st().prefs, defaultHarness: 'codex' }, basicHarnesses: [] });
  // Codex is the default; Claude takes over while Codex can't run
  set({ conn: 'error', claude: { status: { state: 'apikey' } as any, models: [] } });
  assert.equal(S.claudeUsable(), true);
  assert.equal(S.newChatHarness(), 'claude');
  set({ claude: { status: { state: 'missing' } as any, models: [] } });
  assert.equal(S.newChatHarness(), 'codex');
  set({ prefs: { ...st().prefs, defaultHarness: 'claude' }, conn: 'ready' });
  assert.equal(S.harnessUsable('codex'), true);
  assert.equal(S.newChatHarness(), 'codex');
  set({ claude: { status: { state: 'ready' } as any, models: [] } });
  assert.equal(S.newChatHarness(), 'claude');
  // the default can't run and isn't coming up: the other one, while it is being checked again, is the better bet
  set({ prefs: { ...st().prefs, defaultHarness: 'codex' }, conn: 'error', claude: { status: { state: 'detecting' } as any, models: [] } });
  assert.equal(S.newChatHarness(), 'claude');
  set({ prefs: { ...st().prefs, defaultHarness: 'claude' }, conn: 'connecting', claude: { status: { state: 'signin' } } as any });
  assert.equal(S.newChatHarness(), 'codex');
  // both still being looked for: the default stays
  set({ claude: { status: { state: 'detecting' } as any, models: [] } });
  assert.equal(S.newChatHarness(), 'claude');
  set({ prefs: { ...st().prefs, defaultHarness: 'codex' } });
  assert.equal(S.newChatHarness(), 'codex');
  set({ conn: 'ready', claude: { status: { state: 'ready' } as any, models: [] } });
  impl['flags.isEnabled'] = () => false;
  assert.equal(S.codexUsable(), false);
  assert.equal(S.claudeUsable(), false);
  assert.equal(S.anyHarnessUsable(), false);
  set({ basicHarnesses: [{ id: 'kimi', state: 'admitted' }] as any });
  assert.equal(S.anyHarnessUsable(), true);
  assert.equal(S.newChatBasic(), 'kimi');
  impl['flags.isEnabled'] = () => true;
  assert.equal(S.anyHarnessUsable(), true);
});

test('harnessesChecking while any harness may still turn up', () => {
  set({ conn: 'ready', claude: { status: { state: 'ready' } as any, models: [] }, basicListed: true, basicHarnesses: [] });
  assert.equal(S.harnessesChecking(), false);
  set({ basicHarnesses: [{ id: 'k', state: 'checking' }] as any });
  assert.equal(S.harnessesChecking(), true);
  set({ basicHarnesses: [], basicListed: false });
  assert.equal(S.harnessesChecking(), true);
  set({ basicListed: true, claude: { status: { state: 'detecting' } as any, models: [] } });
  assert.equal(S.harnessesChecking(), true);
  set({ conn: 'connecting' });
  assert.equal(S.harnessesChecking(), true);
});

test('accountNote adds a note after the last turn and keeps it in the chat notes', () => {
  assert.equal(S.accountNote('none', 'moved'), false);
  set({ runtime: { a: { turns: [{ id: 'pending-1', items: [] }] } as any, b: { turns: [{ id: 't9', items: [] }] } as any } });
  assert.equal(S.accountNote('a', 'moved'), true);
  assert.equal(st().chatNotes.a[0].turnId, null);
  assert.equal(S.accountNote('b', 'moved'), true);
  assert.equal(st().chatNotes.b[0].turnId, 't9');
  assert.equal(st().runtime.b.turns[0].items.length, 1);
  // main already saved the note: only shown, once
  assert.equal(S.accountNote('b', 'saved', 'n1'), true);
  assert.equal(S.accountNote('b', 'saved', 'n1'), true);
  assert.deepEqual(
    st()
      .runtime.b.turns[0].items.map((i: any) => i.id)
      .slice(1),
    ['n1'],
  );
  assert.equal(st().chatNotes.b.length, 1);
  // two moves in the same millisecond are two notes with their own ids
  const now = Date.now;
  Date.now = () => 1;
  try {
    S.accountNote('b', 'moved again');
    S.accountNote('b', 'and again');
  } finally {
    Date.now = now;
  }
  const ids = st().chatNotes.b.map((n: any) => n.id);
  assert.equal(new Set(ids).size, 3);
  assert.equal(new Set(st().runtime.b.turns[0].items.map((i: any) => i.id)).size, 4);
});

test('permission modes map to approval policy and sandbox mode', () => {
  assert.deepEqual(chats.permissionParams('read-only'), { approvalPolicy: 'on-request', sandbox: 'read-only' });
  assert.deepEqual(chats.permissionParams('full-access'), {
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    approvalsReviewer: 'user',
  });
  assert.deepEqual(chats.permissionParams('auto-review'), {
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    approvalsReviewer: 'auto_review',
  });
  assert.deepEqual(chats.permissionParams('default'), {
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    approvalsReviewer: 'user',
  });
});

test('migration results become a banner or a notice', async () => {
  const run = async (list: any[]) => {
    set({ toasts: [] });
    impl['chats.retryMigration'] = async () => list;
    await S.retryMigration();
    return [st().migrationIssue?.result ?? null, st().toasts.map((t) => t.text)] as const;
  };
  assert.deepEqual(
    await run([
      { id: 'cookies-v1', result: 'done' },
      { id: 'chats', result: 'ok' },
    ]),
    [null, ['Some sites in the built-in browser will ask you to sign in again']],
  );
  assert.deepEqual(await run([{ id: 'chats', result: 'failed' }]), ['failed', []]);
  assert.deepEqual(await run([{ id: 'chats', result: 'error' }]), ['error', []]);
  assert.match((await run([{ id: 'chats', result: 'deferred' }]))[1][0] as string, /^Not enough disk space to move chat data\./);
  assert.match((await run([{ id: 'chats', result: 'newer' }]))[1][0] as string, /newer version/);
  assert.deepEqual(await run([{ id: 'chats', result: 'skipped' }]), [null, []]);
  set({ toasts: [] });
  impl['chats.restoreMigration'] = async () => null;
  await S.restoreMigration();
  assert.equal(st().toasts[0].text, 'There is no backup to restore');
  impl['chats.restoreMigration'] = async () => [{ id: 'chats', result: 'failed' }];
  await S.restoreMigration();
  assert.equal(st().migrationIssue!.result, 'failed');
});

test('panes: tabs open, focus, close and toggle', () => {
  // a chat's agent tabs show in its own view
  set({ threads: { c: { id: 'c', name: 'Chat C' } as any }, route: { name: 'thread', id: 'c' } });
  S.openAgentBrowserTab('c');
  const tab = st().paneTabs[0];
  assert.deepEqual([tab.kind, tab.title, tab.agentChat, st().diffPanel.open], ['browser', 'Chat C', 'c', true]);
  set({ paneActive: '', diffPanel: { open: false } });
  S.openAgentBrowserTab('c');
  assert.equal(st().paneActive, tab.id);
  assert.equal(st().paneTabs.length, 1);
  S.openAgentBrowserTab('other');
  assert.equal(st().paneTabs[1].title, 'Agent browser');
  S.openPaneTab('file', { path: '/a.ts', line: 1 });
  S.openPaneTab('file', { path: '/a.ts', line: 9 });
  const files = st().paneTabs.filter((t) => t.kind === 'file');
  assert.deepEqual(
    files.map((t) => [t.kind, t.ownerChat, t.path, t.line]),
    [['file', 'c', '/a.ts', 9]],
  );
  S.openPaneTab('files');
  S.openPaneTab('files', { cwd: '/w' });
  assert.equal(st().paneTabs.filter((t) => t.kind === 'files').length, 1);
  assert.equal(st().paneFull, false);
  S.openChanges({ file: 'x' });
  S.openChanges();
  assert.equal(st().paneTabs[0].id, 'changes');
  assert.equal(st().paneTabs.filter((t) => t.id === 'changes').length, 1);
  S.togglePaneTab('changes');
  assert.equal(st().diffPanel.open, false);
  S.togglePaneTab('changes');
  assert.equal(st().diffPanel.open, true);
  S.togglePaneTab('terminal');
  const term = st().paneActive;
  S.closePaneTab('changes');
  assert.equal(st().paneActive, term);
  S.closePaneTab(term);
  assert.notEqual(st().paneActive, term);
  for (const t of st().paneTabs) S.closePaneTab(t.id);
  assert.deepEqual([st().paneTabs, st().paneActive, st().diffPanel], [[], '', { open: false }]);
});

test('panes: the tasks tab toggles per chat and stacks agent pages that Back pops', async () => {
  const P = await import('../src/store/panes.ts');
  const tasks = () => st().paneTabs.find((t) => t.kind === 'tasks')!;
  P.toggleTasksPane('c1');
  assert.deepEqual([tasks().threadId, tasks().views, st().paneActive, st().diffPanel.open], ['c1', [], 'tasks', true]);
  // in front on its list for the same chat: the toggle hides the pane
  P.toggleTasksPane('c1');
  assert.equal(st().diffPanel.open, false);
  P.openAgentPage('c1', 'a', 'Track A');
  P.openAgentPage('c1', 'b', 'Track B');
  // an agent already open moves to the top
  P.openAgentPage('c1', 'a', 'Track A');
  assert.deepEqual(
    tasks().views!.map((v) => v.key),
    ['b', 'a'],
  );
  assert.equal(st().diffPanel.open, true);
  // with a page in front the toggle shows the list again instead of hiding
  P.toggleTasksPane('c1');
  assert.deepEqual([tasks().views, st().diffPanel.open], [[], true]);
  P.openAgentPage('c1', 'a', 'Track A');
  P.openAgentPage('c1', 'b', 'Track B');
  P.popPaneView('tasks');
  assert.deepEqual(tasks().views, [{ kind: 'agent', key: 'a', title: 'Track A' }]);
  P.popPaneView('tasks');
  P.popPaneView('tasks');
  assert.deepEqual(tasks().views, []);
  // another chat's agent replaces the stack; the toggle for another chat retargets the tab
  P.openAgentPage('c1', 'a', 'Track A');
  P.openAgentPage('c2', 'z', 'Track Z');
  assert.deepEqual([tasks().threadId, tasks().views!.map((v) => v.key)], ['c2', ['z']]);
  P.toggleTasksPane('c1');
  assert.deepEqual([tasks().threadId, tasks().views, st().diffPanel.open], ['c1', [], true]);
  // a tab without a stack yet, or another tab in front, opens the list
  set({ paneTabs: [{ id: 'tasks', kind: 'tasks', threadId: 'c1' } as any, { id: 'x', kind: 'files' } as any], paneActive: 'x' });
  P.popPaneView('tasks');
  P.popPaneView('x');
  assert.deepEqual(tasks().views, []);
  set({ paneTabs: [{ id: 'tasks', kind: 'tasks', threadId: 'c1' } as any], paneActive: 'tasks', diffPanel: { open: true } });
  P.openAgentPage('c1', 'q', 'Track Q');
  assert.deepEqual(
    tasks().views!.map((v) => v.key),
    ['q'],
  );
  set({ paneTabs: [{ id: 'tasks', kind: 'tasks', threadId: 'c1' } as any], paneActive: 'tasks', diffPanel: { open: true } });
  P.toggleTasksPane('c1');
  assert.equal(st().diffPanel.open, false);
});

test('sub-agent threads open read-only beside the chat, once', () => {
  noteOwner('sub', 'claude');
  set({ runtime: { sub: { loaded: true } as any } });
  S.openSubThread('sub');
  assert.deepEqual(
    st().paneTabs.map((t) => [t.kind, t.readOnly, t.title]),
    [['chat', true, 'Sub-agent']],
  );
  set({ diffPanel: { open: false }, paneActive: '' });
  S.openSubThread('sub', 'Named');
  assert.equal(st().paneTabs.length, 1);
  assert.equal(st().diffPanel.open, true);
  S.openSubThread('sub2', 'Named');
  assert.equal(st().paneTabs[1].title, 'Named');
  // another app never "has" a sub-agent's thread
  S.setElsewhere('sub', { app: 'codex', running: true, hard: true });
  assert.equal(st().elsewhere.sub, undefined);
});

test('selected text and attachments become the turn input', () => {
  assert.equal(selections.withSelections('do', []), 'do');
  assert.equal(
    selections.withSelections('do', ['a', 'b']),
    '\n# Selected text:\n<selected-text>\n["a","b"]\n</selected-text>\n\n## My request:\ndo\n',
  );
  const input = S.buildInput('hi', [
    S.selectionAttachment('sel'),
    { kind: 'selection', path: '', name: 's' },
    { kind: 'session', path: '', name: 'Other', text: 'conv' },
    { kind: 'image', path: '/i.png', name: 'i' },
    { kind: 'skill', path: '/s', name: 'sk' },
    { kind: 'file', path: '/f', name: 'f' },
  ]);
  assert.deepEqual(input.slice(1), [
    { type: 'localImage', path: '/i.png' },
    { type: 'skill', name: 'sk', path: '/s' },
    { type: 'mention', name: 'f', path: '/f' },
  ]);
  assert.equal(input[0].type, 'text');
  assert.deepEqual(S.buildInput('  ', []), []);
});

test('the next new chat targets a chosen folder, the chosen project, the latest chat project or the first one', () => {
  const projects = [
    { id: 'p1', name: 'One', roots: [{ path: '/w/one' }], source: 'sage' },
    { id: 'p2', name: 'Two', roots: [{ path: '/w/two' }], source: 'codex', codexId: 'cx2' },
    { id: 'home', name: 'Home', roots: [{ path: '/home/me' }], source: 'sage' },
  ] as any;
  set({ home: '/home/me', savedProjects: [] });
  assert.equal(S.newChatTarget(), null);
  assert.equal(S.currentCwdForNewChat(), '/home/me');
  set({ savedProjects: projects, newChatCwd: '/tmp/x', newChatProjectId: null });
  assert.deepEqual(S.newChatTarget(), { name: 'x', path: '/tmp/x', projectId: null });
  assert.equal(S.currentCwdForNewChat(), '/tmp/x');
  set({ newChatCwd: '/', newChatProjectId: null });
  assert.equal(S.newChatTarget()!.name, '/');
  set({ newChatCwd: null, newChatProjectId: 'p2' });
  assert.deepEqual(S.newChatTarget(), { name: 'Two', path: '/w/two', projectId: 'p2' });
  assert.equal(S.currentCwdForNewChat(), '/w/two');
  set({ newChatProjectId: 'none' });
  assert.equal(S.newChatProject(), null);
  // the latest chat's project: by id, by Codex id, or by folder (never the home folder itself)
  set({ newChatProjectId: 'gone', threadOrder: ['x', 'a'], threads: { a: { id: 'a', cwd: '/w/one/sub' } as any } });
  assert.equal(S.newChatProject()!.id, 'p1');
  set({ threads: { a: { id: 'a', projectId: 'cx2' } as any } });
  assert.equal(S.newChatProject()!.id, 'p2');
  set({ threads: { a: { id: 'a', projectId: 'nope', cwd: '/home/me/else' } as any } });
  assert.equal(S.newChatProject()!.id, 'p1');
  set({ newChatProjectId: null, savedProjects: [{ id: 'e', name: 'E', roots: [], source: 'sage' }] as any, threads: {} });
  assert.deepEqual(S.newChatTarget(), { name: 'E', path: '', projectId: 'e' });
  assert.equal(S.currentCwdForNewChat(), '/home/me');
  // the deepest matching root wins
  const nested = [
    { id: 'o', name: 'O', roots: [{ path: '/w' }] },
    { id: 'i', name: 'I', roots: [{ path: '/w/in' }] },
    { id: 'o2', name: 'O2', roots: [{ path: '/w' }] },
  ] as any;
  assert.equal(S.projectForThread({ cwd: '/w/in/x' } as any, nested)!.id, 'i');
  assert.equal(S.projectForThread({} as any, nested), null);
});

test('chat config, drafts and the local project list', () => {
  S.setChatConfig('a', { model: 'm' });
  S.setChatConfig('a', { effort: 'high' });
  S.copyChatConfig('a', 'b');
  S.copyChatConfig('none', 'c');
  assert.deepEqual(st().chatConfig, { a: { model: 'm', effort: 'high' }, b: { model: 'm', effort: 'high' } });
  S.setDraft('k', { text: 't', attachments: [] });
  assert.deepEqual(st().drafts.k, { text: 't', attachments: [] });
});

test('pass-throughs to the harness modules and main', async () => {
  S.removeQueued('t', 'q');
  S.sendQueuedNow('t', 'q');
  S.stopAllTasks('t');
  S.setUltracode('t', true);
  S.editClaudeMessage('t', 'turn');
  impl['codex.pinLease'] = () => Promise.reject(new Error('x'));
  S.pinLease('t', true);
  await flush();
  assert.deepEqual(callsOf('proxy.removeQueued'), [['t', 'q']]);
  assert.deepEqual(callsOf('proxy.sendNow'), [['t', 'q']]);
  // no tasks known here: main is asked about the chat's current session
  assert.deepEqual(callsOf('claude.claudeStopAllTasks'), [['t', []]]);
  assert.deepEqual(callsOf('claude.setClaudeUltracode'), [['t', true]]);
  assert.deepEqual(callsOf('claude.claudeEditMessage'), [['t', 'turn']]);
  assert.deepEqual(callsOf('codex.pinLease'), [['t', true]]);
  assert.equal(S.ensureHarness('claude'), undefined);
  set({ conn: 'ready' });
  assert.equal(S.ensureHarness('codex'), undefined);
});

test('editBlockedFor: an earlier segment or a Claude message without a checkpoint', () => {
  set({
    runtime: { a: { turns: [{ id: 't0' }, { id: 't1' }] } as any, c: { turns: [{ id: 'x' }], checkpoints: {} } as any },
    segments: {
      a: [
        { nativeId: 'a', harness: 'codex', start: 0 },
        { nativeId: 'b', harness: 'codex', start: 1 },
      ] as any,
    },
  });
  assert.equal(S.editBlockedFor(st(), 'a', 't0'), 'Ran on an earlier harness · Fork from here instead');
  assert.equal(S.editBlockedFor(st(), 'a', 't1'), null);
  noteOwner('c', 'claude');
  assert.equal(S.editBlockedFor(st(), 'c', 'x'), 'Created before checkpoints · Fork from here instead');
  assert.equal(S.editBlockedFor(st(), 'missing', 'x'), null);
  // a basic harness's message keeps no checkpoint and isn't asked for one
  set({ runtime: { ...st().runtime, 'acp:k:1': { turns: [{ id: 'x' }], checkpoints: {} } as any } });
  assert.equal(S.editBlockedFor(st(), 'acp:k:1', 'x'), null);
});

test('codexIsIdle reads whether Codex was left for first use', () => {
  set({ conn: 'idle' });
  assert.equal(idleFn(), true);
  set({ conn: 'ready' });
  assert.equal(idleFn(), false);
});

test('project lookup ranks the matching root rather than a different first root', () => {
  set({ home: '/home/me' });
  const thread = { cwd: '/repo/deep/chat' } as any;
  const outer = { id: 'outer', roots: [{ path: '/repo' }] } as any;
  const inner = { id: 'inner', roots: [{ path: '/x' }, { path: '/repo/deep' }] } as any;
  const unrelatedFirst = { id: 'unrelated-first', roots: [{ path: '/a/very/long/unrelated/root' }, { path: '/repo' }] } as any;
  for (const projects of [
    [inner, outer],
    [outer, inner],
    [unrelatedFirst, inner],
    [inner, unrelatedFirst],
  ]) {
    assert.equal(S.projectForThread(thread, projects)!.id, 'inner');
  }
  const trailing = { id: 'trailing', roots: [{ path: '/repo/////////////' }] } as any;
  assert.equal(S.projectForThread(thread, [trailing, inner])!.id, 'inner');
  assert.equal(S.projectForThread({ ...thread, projectId: 'outer' }, [inner, outer])!.id, 'outer');
  const windows = [
    { id: 'windows-inner', roots: [{ path: 'D:\\elsewhere' }, { path: 'C:\\repo\\deep' }] },
    { id: 'windows-outer', roots: [{ path: 'C:\\repo' }] },
  ] as any;
  assert.equal(S.projectForThread({ cwd: 'c:/repo/deep/chat' } as any, windows)!.id, 'windows-inner');
});

test('a chat stays in the project it started in when its folder matches no project root', () => {
  // the checkout was renamed (sagecode -> mopilot): the saved root no longer holds the chat's cwd
  const renamed = [{ id: 'p', codexId: 'cx', name: 'mopilot', roots: [{ path: '/gh/sagecode' }] }] as any;
  const chat = { id: 'claude:c', cwd: '/gh/mopilot/.claude/worktrees/w' } as any;
  assert.equal(S.projectForThread(chat, renamed), null);
  S.rememberChatProject('claude:c', 'p');
  assert.equal(S.projectForThread(chat, renamed)!.id, 'p');
  S.rememberChatProject('claude:x', 'cx');
  assert.equal(S.projectForThread({ id: 'claude:x', cwd: '/elsewhere' } as any, renamed)!.id, 'p');
  S.rememberChatProject('claude:t', 'p', true);
  S.rememberChatProject('claude:n', null);
  assert.deepEqual(Object.keys(st().chatProject).sort(), ['claude:c', 'claude:x']);
});

test('project lookup excludes the home folder regardless of trailing separators', () => {
  for (const home of ['/home/me', '/home/me/'])
    for (const root of ['/home/me', '/home/me/']) {
      set({ home });
      const homeProject = { id: 'home-project', roots: [{ path: root }] } as any;
      const thread = { cwd: '/home/me/unassigned' } as any;
      assert.ok(S.projectForThread(thread, [homeProject]) === null);
      const parent = { id: 'parent', roots: [{ path: '/home' }] } as any;
      assert.equal(S.projectForThread(thread, [homeProject, parent])!.id, 'parent');
      const nested = { id: 'nested', roots: [{ path: '/home/me/project' }] } as any;
      assert.equal(S.projectForThread({ cwd: '/home/me/project/chat' } as any, [homeProject, nested])!.id, 'nested');
      assert.equal(S.projectForThread({ ...thread, projectId: 'home-project' }, [homeProject])!.id, 'home-project');
    }
});

test('tabs opened within one clock tick have separate identities and close independently', (t) => {
  t.mock.method(Date, 'now', () => 1700000000000);
  for (const kind of ['browser', 'terminal', 'chat'] as const) {
    set({ paneTabs: [], paneActive: '', route: { name: 'home' } });
    S.openPaneTab(kind, { threadId: 'first' });
    S.openPaneTab(kind, { threadId: 'second' });
    const [first, second] = st().paneTabs;
    assert.notEqual(first.id, second.id, kind);
    assert.equal(st().paneActive, second.id);
    S.closePaneTab(first.id);
    assert.deepEqual(
      st().paneTabs.map((tab) => tab.id),
      [second.id],
    );
    assert.equal(st().paneActive, second.id);
  }
});

test('project lookup preserves native and remembered local id namespaces when their strings collide', () => {
  noteOwner('claude:chat', 'claude');
  const local = { id: 'shared', codexId: 'native-local', name: 'Local', roots: [{ path: '/local' }] };
  const imported = { id: 'imported', codexId: 'shared', name: 'Imported', roots: [{ path: '/imported' }] };
  for (const projects of [
    [local, imported],
    [imported, local],
  ]) {
    assert.equal(S.projectForThread({ id: 'native-chat', projectId: 'shared', cwd: '/elsewhere' } as any, projects as any), imported);
    for (const id of ['native-chat', 'claude:chat', 'acp:kimi:chat']) {
      S.rememberChatProject(id, 'shared');
      assert.equal(S.projectForThread({ id, projectId: null, cwd: '/elsewhere' } as any, projects as any), local);
      if (id !== 'native-chat')
        assert.equal(S.projectForThread({ id, projectId: 'shared', cwd: '/elsewhere' } as any, projects as any), local);
      assert.equal(S.projectForThread({ id, projectId: 'missing-native', cwd: '/elsewhere' } as any, projects as any), local);
    }
  }
});

test('project lookup tries known namespaces before legacy fallbacks from either source', () => {
  const wrong = { id: 'native-stale', name: 'Wrong', roots: [{ path: '/wrong' }] };
  const saved = { id: 'saved', codexId: 'native-saved', name: 'Saved', roots: [{ path: '/saved' }] };
  S.rememberChatProject('native-stale-chat', 'saved');
  assert.equal(
    S.projectForThread({ id: 'native-stale-chat', projectId: 'native-stale', cwd: '/elsewhere' } as any, [wrong, saved] as any),
    saved,
  );
  noteOwner('legacy-local-chat', 'claude');
  assert.equal(S.projectForThread({ id: 'legacy-local-chat', projectId: 'native-saved', cwd: '/elsewhere' } as any, [saved] as any), saved);
});

test("stop all goes to each running task's own session: after a switch, the old Claude session runs them", async () => {
  const sessions = await import('../src/store/session/useSession.ts');
  const task = (id: string, status: string, key?: string) => ({ id, status, ...(key ? { source: { kind: 'claude', key } } : {}) });
  sessions.useSessions.setState({
    sessions: {
      sw: {
        ...sessions.sessionOf('sw'),
        tasks: [
          task('a', 'running', 'claude:old'),
          task('b', 'running', 'claude:old'),
          task('c', 'completed', 'claude:gone'),
          task('d', 'running'),
        ],
      },
    },
  } as any);
  S.stopAllTasks('sw');
  await flush();
  assert.deepEqual(callsOf('claude.claudeStopAllTasks').at(-1), ['sw', ['claude:old', 'sw']]);
});

for (const kind of ['file', 'skill'] as const) {
  test(`${kind} pane identities preserve both the owner and path when either contains separators`, () => {
    set({ route: { name: 'thread', id: 'chat:/one' } });
    S.openPaneTab(kind, { path: '/two' });
    set({ route: { name: 'thread', id: 'chat' } });
    S.openPaneTab(kind, { path: '/one:/two' });
    const tabs = st().paneTabs.filter((tab) => tab.kind === kind);
    assert.equal(tabs.length, 2);
    assert.equal(new Set(tabs.map((tab) => tab.id)).size, 2);
    S.closePaneTab(tabs[0].id);
    assert.equal(st().paneTabs.filter((tab) => tab.kind === kind).length, 1);
  });
}

test('global blank file details and a file literally named undefined keep separate pane identities', () => {
  set({ route: { name: 'home' } });
  S.openPaneTab('file');
  S.openPaneTab('file');
  assert.equal(st().paneTabs.length, 1);
  S.openPaneTab('file', { path: 'undefined' });
  const tabs = st().paneTabs.filter((tab) => tab.kind === 'file');
  assert.equal(tabs.length, 2);
  assert.notEqual(tabs[0].id, tabs[1].id);
  S.closePaneTab(tabs[0].id);
  assert.equal(st().paneTabs[0].path, 'undefined');
});
