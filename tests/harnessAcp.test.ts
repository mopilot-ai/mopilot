// Basic-tier harnesses over ACP, renderer side (src/session/harness/acp.ts): detection, sign-in, chats,
// turns and the events main relays.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { called, fx, reset, tick } from './support/harness-logic-fakes.ts';
import { defined } from './support/defined.ts';

const acp = await import('../src/session/harness/acp.ts');
const { acpSessionOf } = await import('../src/harness/acpSessions.ts');

const log: any[] = [];
const rec =
  (name: string, ret: any = undefined) =>
  (...args: any[]) => (log.push([name, ...args]), typeof ret === 'function' ? ret(...args) : ret);
const notes = () => called('applyNotification');
const harness = (o: any = {}) => ({ id: 'kimi', label: 'Kimi Code', state: 'ready', authMethods: [], login: null, bin: null, ...o });

beforeEach(() => {
  reset();
  log.length = 0;
  fx.native.session = { acpNew: async () => true, acpCancel: async () => true };
});

test('labels, copy and the / menu for a basic harness', () => {
  assert.equal(acp.basicLabel('kimi'), 'Kimi Code');
  assert.equal(acp.basicLabel('nope'), 'nope');
  // one the registry doesn't list goes by the label its quirks give, as admission lists it
  fx.state.basicHarnesses = [harness({ id: 'claude-acp', label: 'Claude Code (ACP)' })];
  assert.equal(acp.basicLabel('claude-acp'), 'Claude Code (ACP)');
  assert.equal(acp.acpLabelOf('acp:claude-acp:1'), 'Claude Code (ACP)');
  assert.equal(acp.acpLabelOf('acp:kimi:1'), 'Kimi Code');
  assert.equal(acp.acpLabelOf('codex-1'), '');
  // a chat that runs Claude Code or Codex on a machine goes by that agent's name
  assert.equal(acp.acpLabelOf('acp:host-claude:1'), 'Claude Code');
  assert.equal(acp.basicLabel('host-codex'), 'Codex');
  assert.match(acp.BASIC_HOVER('Kimi Code'), /only if Kimi Code has them/);
  assert.equal(acp.UNSUPPORTED(null), "Installed · Can't run in MoPilot");
  assert.equal(acp.UNSUPPORTED('too old'), "Installed · Can't run in MoPilot · too old");
  assert.deepEqual([acp.TURNED_OFF('Paused by MoPilot'), acp.TURNED_OFF(null)], ['Paused by MoPilot', 'Turned off for now']);
  assert.equal(acp.isAcpThread('acp:kimi:1'), true);
  const reg = acp.acpRegistry('kimi', [{ name: 'review', description: 'Review' }] as any);
  assert.ok(reg.menu.some((c) => c.name === 'review'));
  assert.equal(acp.acpRegistry('kimi', undefined as any).provider.listed, false);
  assert.deepEqual(acp.acpTyped('/review now', 'kimi', [{ name: 'review', description: 'Review' }] as any).kind, 'passthrough');
  assert.equal(acp.acpTyped('/nothing', 'kimi', [] as any).kind, 'unknown');
  assert.deepEqual(
    acp
      .optionValues({
        options: [
          { value: 1, name: 'a' },
          { group: 'g', options: [{ value: 2, name: 'b' }] },
        ],
      } as any)
      .map((o) => o.value),
    [1, 2],
  );
  assert.deepEqual(acp.optionValues({} as any), []);
  // the model a basic chat runs on, as the harness names it (Status and the picker show it)
  const model = (currentValue: unknown) => [
    { category: 'mode' },
    { category: 'model', currentValue, options: [{ value: 'k2', name: 'Kimi K2' }] },
  ];
  assert.deepEqual(
    [model('k2'), model('other'), model(undefined), [{ category: 'mode' }], null].map((c) => acp.acpModelName(c as any)),
    ['Kimi K2', 'other', '', null, null],
  );
});

test('admission failures preserve the observed reason without inventing an update remedy', () => {
  for (const reason of [
    null,
    '',
    "MoPilot can't give Antigravity computer and browser control",
    'Opening a session took longer than 30s',
  ]) {
    const shown = acp.UNSUPPORTED(reason);
    assert.equal(shown, `Installed · Can't run in MoPilot${reason ? ` · ${reason}` : ''}`);
    assert.doesNotMatch(shown, /needs an update/i);
  }
});

test('chats load into the sidebar, keeping local names and projects, skipping archived ones', async () => {
  fx.state.threads['acp:kimi:a'] = { id: 'acp:kimi:a', name: 'Mine', projectId: 'p1' };
  fx.state.threads['acp:kimi:c'] = { id: 'acp:kimi:c', name: 'Old' };
  fx.state.threadOrder = ['acp:kimi:a'];
  fx.state.claudeArchived = { 'acp:kimi:z': true };
  fx.native.acp = {
    list: async () => [
      { id: 'acp:kimi:a', cwd: '/w', createdAt: 1000, updatedAt: 2000 },
      { id: 'acp:kimi:b', cwd: '/w', preview: 'hi', name: 'B', sessionId: 'agent-b', createdAt: 3000, updatedAt: 4500 },
      { id: 'acp:kimi:c', cwd: '/w', name: 'New', createdAt: 0, updatedAt: 0 },
      { id: 'acp:kimi:z', cwd: '/w', createdAt: 0, updatedAt: 0 },
    ],
  };
  await acp.loadAcpThreads();
  const t = fx.state.threads;
  assert.equal(t['acp:kimi:a'].name, 'Mine');
  assert.equal(t['acp:kimi:a'].projectId, 'p1');
  assert.equal(t['acp:kimi:c'].name, 'New');
  assert.equal(t['acp:kimi:c'].projectId, null);
  assert.deepEqual([t['acp:kimi:b'].name, t['acp:kimi:b'].preview, t['acp:kimi:b'].updatedAt], ['B', 'hi', 4]);
  assert.equal(t['acp:kimi:z'], undefined);
  assert.deepEqual(fx.state.threadOrder, ['acp:kimi:a', 'acp:kimi:b', 'acp:kimi:c']);
  // the agent's own session id, which its CLI resumes by
  assert.deepEqual([acpSessionOf('acp:kimi:b'), acpSessionOf('acp:kimi:a')], ['agent-b', null]);
  const warn = console.warn;
  const warned: any[] = [];
  console.warn = (...a: any[]) => void warned.push(a);
  fx.native.acp = {
    list: async () => {
      throw new Error('gone');
    },
  };
  await acp.loadAcpThreads();
  console.warn = warn;
  assert.equal(warned[0][0], 'ACP chats');
});

test("the archived list reads the basic-tier chats archived in Sage meta from main's list, and rejects when main can't list them", async () => {
  fx.state.claudeArchived = { 'acp:kimi:z': 1 };
  fx.native.acp = {
    list: async () => [
      { id: 'acp:kimi:a', cwd: '/w', createdAt: 0, updatedAt: 0 },
      { id: 'acp:kimi:z', cwd: '/w', name: 'Z', createdAt: 0, updatedAt: 0 },
    ],
  };
  assert.deepEqual(
    (await acp.archivedAcpThreads()).map((t) => [t.id, t.name]),
    [['acp:kimi:z', 'Z']],
  );
  fx.native.acp = {
    list: async () => {
      throw new Error('gone');
    },
  };
  await assert.rejects(acp.archivedAcpThreads(), /gone/);
});

test("search maps main's matches to threads", async () => {
  fx.native.acp = {
    search: async (term: string, n: number, scope?: string) => (
      log.push([term, n, scope]), [{ id: 'acp:kimi:s', cwd: '/w', createdAt: 0, updatedAt: 0 }]
    ),
  };
  const r = await acp.searchAcpThreads('foo', 'palette');
  assert.deepEqual([r[0].id, r[0].name, r[0].preview], ['acp:kimi:s', null, '']);
  assert.deepEqual(log, [['foo', 30, 'palette']]);
});

test('a new chat starts fresh: no history to read until it is sent to', async () => {
  fx.native.session = { acpNew: rec('acpNew', async () => true) };
  fx.native.acp = { history: rec('history', async () => []), rename: rec('rename', async () => {}) };
  const id = acp.startAcpThread({ cwd: '/w', harness: 'kimi', projectId: 'p' });
  assert.match(id, /^acp:kimi:/);
  assert.deepEqual(called('unhideFolder'), [['/w']]);
  assert.equal(called('upsertThread')[0][0].projectId, 'p');
  assert.deepEqual(called('rememberChatProject')[0], [id, 'p']);
  acp.startAcpThread({ cwd: '/w', harness: 'kimi' });
  assert.equal(called('upsertThread')[1][0].projectId, null);
  await acp.openAcpThread(id);
  assert.equal(fx.state.runtime[id].loaded, true);
  assert.equal(log.filter((x) => x[0] === 'history').length, 0);
  await acp.acpRename(id, 'Name');
  assert.deepEqual(
    log.filter((x) => x[0] !== 'acpNew'),
    [['rename', id, 'Name']],
  );
});

test('older pages and the whole of a chat are read a page at a time', async () => {
  const page = (ids: string[], olderCursor: string | null) => ({
    page: new TextEncoder().encode(JSON.stringify({ turns: ids.map((id) => ({ id })), olderCursor })),
    activeTurnId: 'b2',
    diffs: {},
  });
  const asked: any[] = [];
  const pages: Record<string, ReturnType<typeof page>> = {
    none: page(['b1', 'b2'], 'b1'),
    b1: page(['a1', 'a2'], 'a1'),
    a1: page(['z'], null),
  };
  fx.native.acp = { turns: async (_k: string, _c: string, _w: string, o: any) => (asked.push(o), pages[o.before ?? 'none']) };
  const ids = (turns: { id: string }[]) => turns.map((t) => t.id);
  const all = await acp.readAllAcpTurns('acp:kimi:p', 'c', '/w');
  assert.deepEqual([ids(all.turns), all.activeTurnId], [['z', 'a1', 'a2', 'b1', 'b2'], 'b2']);
  assert.deepEqual(asked.at(1), { limit: 30, before: 'b1' });
  fx.state.threads['acp:kimi:p'] = { cwd: '/w' };
  assert.equal((await acp.loadOlderAcpTurns('acp:kimi:unknown', 'b1')).nextCursor, 'a1');
  const older = await acp.loadOlderAcpTurns('acp:kimi:p', 'b1');
  assert.deepEqual([ids(older.turns), older.nextCursor], [['a1', 'a2'], 'a1']);
  // a chat opened again keeps the older pages shown ahead of what it read
  fx.state.runtime['acp:kimi:p'] = { turns: [{ id: 'a2' }, { id: 'b1' }], olderCursor: 'a2' };
  await acp.openAcpThread('acp:kimi:p');
  const rt = fx.state.runtime['acp:kimi:p'];
  assert.deepEqual([ids(rt.turns), rt.olderCursor], [['a2', 'b1', 'b2'], 'a2']);
});

test('a turn that ended while older pages were read is not kept as read', async () => {
  const turn = (id: string, status: string) => ({ id, status });
  const page = (turns: { id: string; status: string }[], olderCursor: string | null) => ({
    page: new TextEncoder().encode(JSON.stringify({ turns, olderCursor })),
    activeTurnId: turns.at(-1)!.id,
    diffs: {},
  });
  // the running turn fills a page by itself, so the page taken again after it ends has only the next turn
  const replies = [
    page([turn('big', 'inProgress')], '1'),
    page([turn('old', 'completed')], null),
    page([turn('next', 'inProgress')], '2'),
    page([turn('big', 'completed')], '1'),
    page([turn('old', 'completed')], null),
    page([turn('next', 'inProgress')], '2'),
  ];
  fx.native.acp = { turns: async () => replies.shift() };
  const { turns, activeTurnId } = await acp.readAllAcpTurns('acp:kimi:p', 'c', '/w', { active: true });
  assert.deepEqual(
    turns.map((t: any) => [t.id, t.status]),
    [
      ['old', 'completed'],
      ['big', 'completed'],
      ['next', 'inProgress'],
    ],
  );
  assert.equal(activeTurnId, 'next');
  assert.equal(replies.length, 0);
});

test("opening a chat shows main's turns and the turn it runs; one it can't read says why", async () => {
  const asked: any[] = [];
  const turns = [{ id: 't1', status: 'inProgress', items: [] }];
  const history = {
    page: new TextEncoder().encode(JSON.stringify({ turns, olderCursor: 't1' })),
    activeTurnId: 't1',
    diffs: { t1: 'patch' },
  };
  fx.state.threads['acp:kimi:o'] = { cwd: '/w' };
  fx.native.acp = { turns: async (...a: any[]) => (asked.push(a), history) };
  await acp.openAcpThread('acp:kimi:o');
  const rt = fx.state.runtime['acp:kimi:o'];
  assert.deepEqual(asked, [['acp:kimi:o', 'acp:kimi:o', '/w', { limit: 30 }]]);
  assert.deepEqual(rt.turns, [{ ...turns[0], diff: 'patch' }]);
  assert.equal(rt.activeTurnId, 't1');
  assert.equal(rt.olderCursor, 't1');
  assert.deepEqual([rt.loaded, rt.loading], [true, false]);
  // without a known thread, history still loads with no folder
  await acp.openAcpThread('acp:kimi:nofolder');
  assert.deepEqual(asked.at(-1), ['acp:kimi:nofolder', 'acp:kimi:nofolder', '', { limit: 30 }]);
  fx.native.acp = {
    turns: async () => {
      throw new Error('unreadable');
    },
  };
  await acp.openAcpThread('acp:kimi:o');
  assert.equal(fx.state.runtime['acp:kimi:o'].error, 'unreadable');
  fx.native.acp = {
    turns: async () => {
      throw 'raw';
    },
  };
  await acp.openAcpThread('acp:kimi:o');
  assert.equal(fx.state.runtime['acp:kimi:o'].error, 'raw');
});

test('interrupt, approvals, modes and config options go to main; failures are toasted', async () => {
  fx.native.session = { acpCancel: rec('cancel', async () => 'retired') };
  // main's answer for the turn a button showed comes back ('retired' when another one runs)
  assert.equal(await acp.acpInterrupt('acp:kimi:1', 'm1'), 'retired');
  assert.deepEqual(log, [['cancel', 'acp:kimi:1', 'm1']]);
  fx.native.session = {
    acpCancel: async () => {
      throw new Error('busy');
    },
  };
  await acp.acpInterrupt('acp:kimi:1');
  fx.native.session = {
    acpCancel: async () => {
      throw 'raw';
    },
  };
  await acp.acpInterrupt('acp:kimi:1');
  fx.native.acp = {
    permission: rec('permission'),
    setMode: rec('setMode', async () => {}),
    setConfigOption: rec('setConfigOption', async () => {}),
  };
  acp.resolveAcpRequest({ id: 9 } as any, { optionId: 'allow' });
  acp.resolveAcpRequest({ id: 10 } as any, null);
  // each says whether the harness took it
  assert.equal(await acp.setAcpMode('acp:kimi:1', 'plan'), true);
  assert.equal(await acp.setAcpConfig('acp:kimi:1', 'model', 'k2'), true);
  assert.deepEqual(log.slice(1), [
    ['permission', '9', 'allow'],
    ['permission', '10', null],
    ['setMode', 'acp:kimi:1', 'plan'],
    ['setConfigOption', 'acp:kimi:1', 'model', 'k2'],
  ]);
  fx.native.acp = {
    setMode: async () => {
      throw new Error("Error invoking remote method 'acp:mode': Error: no such mode");
    },
    setConfigOption: async () => {
      throw 'bad value';
    },
  };
  assert.equal(await acp.setAcpMode('acp:kimi:1', 'x'), false);
  assert.equal(await acp.setAcpConfig('acp:kimi:1', 'model', 'x'), false);
  assert.deepEqual(called('toast'), [
    ["Couldn't stop: busy", 'error'],
    ["Couldn't stop: raw", 'error'],
    ["Couldn't change the mode: no such mode", 'error'],
    ["Couldn't change it: bad value", 'error'],
  ]);
});

let onEvent: any;
test('events from main drive the chat: turns, names, notes and a harness that quit', async () => {
  let onHarnesses: any;
  let onItems: any;
  (globalThis as any).window = new EventTarget();
  fx.native.acp = {
    onEvent: (h: any) => (onEvent = h),
    onItems: (h: any) => (onItems = h),
    onHarnesses: (h: any) => (onHarnesses = h),
    harnesses: async () => [],
    onSignIns: () => {},
    signIns: async () => ({}),
    list: async () => [],
  };
  acp.startAcp();
  acp.startAcp(); // once only
  await tick();
  onHarnesses([harness()]);
  assert.deepEqual([fx.state.basicHarnesses.length, fx.state.basicListed], [1, true]);

  const chat = 'acp:kimi:e';
  fx.state.threads[chat] = { id: chat, cwd: '/w', name: null, preview: '', recencyAt: 1 };
  fx.state.threadOrder = ['other', chat];
  // turnStarting shows the message in a pending turn
  onEvent({ kind: 'turnStarting', key: chat, chatId: chat, clientId: 'c1', text: 'hi', attachments: [] });
  assert.equal(fx.state.runtime[chat].activeTurnId, 'pending-c1');
  assert.equal(fx.state.runtime[chat].turns[0].items[0].clientId, 'c1');
  // turnFailed marks only that pending turn
  onEvent({ kind: 'turnStarting', key: chat, chatId: chat, clientId: 'c2', text: 'again', attachments: [] });
  onEvent({ kind: 'turnFailed', key: chat, chatId: chat, clientId: 'c1', error: 'no' });
  assert.deepEqual(
    fx.state.runtime[chat].turns.map((t: any) => t.status),
    ['failed', 'inProgress'],
  );
  assert.equal(fx.state.runtime[chat].activeTurnId, 'pending-c2');
  onEvent({ kind: 'turnFailed', key: chat, chatId: chat, clientId: 'c2', error: 'no' });
  assert.equal(fx.state.runtime[chat].activeTurnId, null);
  // a message shown before main settled a switch to this harness is the turn it starts, not a second one
  fx.state.runtime[chat].turns = [{ id: 'pending-req', status: 'inProgress', items: [{ type: 'userMessage', id: 'local-req' }] }];
  onEvent({ kind: 'turnStarting', key: chat, chatId: chat, clientId: 'c4', itemId: 'req', text: 'hi', attachments: [] });
  assert.equal(fx.state.runtime[chat].turns.map((t: any) => t.id).join(), 'pending-c4');
  onEvent({ kind: 'turnFailed', key: chat, chatId: chat, clientId: 'c4', error: 'no' });
  assert.deepEqual(called('suggestOtherHarness'), []);
  // a session the harness refused for lack of quota offers another harness
  onEvent({ kind: 'turnFailed', key: chat, chatId: chat, clientId: 'c3', error: 'You exceeded your current quota' });
  assert.deepEqual(called('suggestOtherHarness'), [[chat, 'acp']]);
  // a transcript main could not write is told, with the harness and the reason
  onEvent({ kind: 'transcriptError', key: chat, error: 'ENOSPC: no space left on device' });
  assert.match(
    defined(called('toast').at(-1))[0],
    /^Couldn't save the history of “.+” \(Kimi Code\) to disk: ENOSPC: no space left on device\./,
  );
  assert.equal(defined(called('toast').at(-1))[1], 'error');
  // turnStarted moves it to the top and takes a preview; a chat not in the list is left alone
  onEvent({ kind: 'turnStarted', key: chat, chatId: chat, text: 'hi there' });
  assert.deepEqual(fx.state.threadOrder, [chat, 'other']);
  assert.ok(fx.state.threads[chat].recencyAt > 1);
  assert.equal(fx.state.threads[chat].recencyAt, fx.state.threads[chat].updatedAt);
  assert.equal(fx.state.threads[chat].preview, 'hi there');
  onEvent({ kind: 'turnStarted', key: chat, chatId: chat, text: 'later' });
  assert.equal(fx.state.threads[chat].preview, 'hi there');
  onEvent({ kind: 'turnStarted', key: 'acp:kimi:unknown', chatId: 'acp:kimi:unknown', text: 'x' });
  assert.equal(fx.state.threads['acp:kimi:unknown'], undefined);
  // threadName names an unnamed chat only
  onEvent({ kind: 'threadName', key: chat, chatId: chat, name: 'First' });
  onEvent({ kind: 'threadName', key: chat, chatId: chat, name: 'Second' });
  onEvent({ kind: 'threadName', key: 'x', chatId: 'acp:kimi:nothere', name: 'N' });
  assert.equal(fx.state.threads[chat].name, 'First');
  // main's items show; the events they came from are translated there
  onEvent({ kind: 'turnStart', key: chat, turnId: 'T1', user: { id: 'u', clientId: 'c3', content: [] } });
  onEvent({
    kind: 'update',
    key: chat,
    turnId: 'T1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
  });
  onEvent({ kind: 'turnEnd', key: chat, turnId: 'T1', stopReason: 'end_turn', running: true });
  assert.deepEqual(notes(), []);
  onItems({ chatId: chat, key: chat, method: 'turn/started', params: { threadId: chat, turn: { id: 'T1' } } });
  assert.deepEqual(
    notes().map((n) => n[0]),
    ['turn/started'],
  );
  fx.calls.length = 0;
  // only a failure that says the harness ran out of quota offers another harness, and only as the turn that ran ends
  onEvent({ kind: 'turnEnd', key: chat, turnId: 'T2', stopReason: 'error', error: 'Rate limit exceeded (429)', running: true });
  assert.deepEqual(called('suggestOtherHarness'), [[chat, 'acp']]);
  // the same end again, once the turn is over: nothing more
  onEvent({ kind: 'turnEnd', key: chat, turnId: 'T2', stopReason: 'error', error: 'Rate limit exceeded (429)', running: false });
  assert.equal(called('suggestOtherHarness').length, 1);
  onEvent({ kind: 'turnEnd', key: chat, turnId: 'T3', stopReason: 'end_turn', running: true });
  assert.equal(called('suggestOtherHarness').length, 1);
  // a retired segment's end is not the chat's
  fx.state.segments['acp:kimi:old'] = [{ harness: 'acp:kimi', nativeId: 'acp:kimi:new', start: 0, count: null }];
  onEvent({ kind: 'turnEnd', key: 'acp:kimi:old', turnId: 'T4', error: 'Rate limit exceeded (429)', running: true });
  assert.equal(called('suggestOtherHarness').length, 1);
  // approvals are main's
  onEvent({ kind: 'permission', key: chat });
  onEvent({ kind: 'permissionCancelled', key: chat });
  // a Host that says how a card closed leaves that line in the thread, only with host.unattended on
  fx.state.runtime[chat] = { turns: [{ id: 'T1', items: [] }] };
  onEvent({ kind: 'permissionCancelled', key: chat, line: 'Allowed on Pocket iPhone' });
  assert.equal(notes().filter((n) => n[1]?.item?.kind === 'card').length, 0, 'flag off: no line');
  fx.native.flags = { isEnabled: (k: string) => k === 'host.unattended', onChanged: () => () => {} };
  onEvent({ kind: 'permissionCancelled', key: chat, line: 'Allowed on Pocket iPhone' });
  onEvent({ kind: 'permissionCancelled', key: chat });
  fx.native.flags = undefined;
  assert.deepEqual(
    notes()
      .filter((n) => n[1]?.item?.kind === 'card')
      .map((n) => n[1].item.text),
    ['Allowed on Pocket iPhone'],
  );
  fx.state.runtime[chat] = undefined;
  // session notes and unattended work go on the last turn; no turn, no note
  fx.state.runtime[chat] = { turns: [{ id: 'T1', items: [] }] };
  onEvent({ kind: 'session', key: chat, fresh: true });
  onEvent({ kind: 'session', key: chat, note: 'Resumed', sessionId: 'agent-live' });
  // a session the agent opened or loaded names the chat's id there
  assert.equal(acpSessionOf(chat), 'agent-live');
  onEvent({ kind: 'unattended', key: chat });
  onEvent({ kind: 'unattended', key: 'acp:kimi:none' });
  const statusNotes = notes()
    .filter((n) => n[0] === 'item/completed' && n[1].item.type === 'statusNote')
    .map((n) => [n[1].turnId, n[1].item.kind, n[1].item.text]);
  assert.deepEqual(statusNotes, [
    ['T1', 'card', 'Allowed on Pocket iPhone'],
    ['T1', 'resume', 'Resumed'],
    ['T1', 'unattended', 'Kimi Code started working with no message running, so MoPilot stopped it'],
  ]);
  // two notes of one kind in the same millisecond keep distinct ids (they key the thread's items)
  const now = Date.now;
  Date.now = () => 1;
  try {
    onEvent({ kind: 'session', key: chat, note: 'Resumed again' });
    onEvent({ kind: 'session', key: chat, note: 'Resumed again' });
  } finally {
    Date.now = now;
  }
  const resumeIds = notes()
    .filter((n) => n[0] === 'item/completed' && n[1].item.kind === 'resume')
    .map((n) => n[1].item.id);
  assert.equal(new Set(resumeIds).size, 3);
  // closed: the user is told when main says a turn was running; main owns approval cleanup
  fx.state.pending = [
    { threadId: chat, method: 'acp/permission' },
    { threadId: chat, method: 'other' },
    { threadId: 'x', method: 'acp/permission' },
  ];
  onEvent({ kind: 'closed', key: chat, error: 'crashed', working: true });
  assert.equal(fx.state.pending.length, 3);
  assert.match(defined(called('toast').at(-1))[0], /^Kimi Code quit while working/);
  const toasts = called('toast').length;
  onEvent({ kind: 'closed', key: chat, error: 'again', working: false });
  onEvent({ kind: 'closed', key: 'acp:kimi:never', error: 'x', working: false });
  assert.equal(called('toast').length, toasts);
  // an unknown event kind is ignored
  onEvent({ kind: 'mystery', key: chat });
});

test('a scheduled run made a basic chat in main: it shows in the sidebar, fresh, under the project it came from', async () => {
  fx.native.acp = { history: rec('history', async () => []) };
  const id = 'acp:kimi:sched';
  onEvent({ kind: 'chatStarted', key: id, chatId: id, cwd: '/wt/abcd/proj', worktreeOf: '/proj' });
  assert.deepEqual(called('unhideFolder'), [['/proj']]);
  assert.equal(called('upsertThread')[0][0].id, id);
  assert.equal(called('upsertThread')[0][0].cwd, '/wt/abcd/proj');
  assert.equal(fx.state.worktreeOf[id], '/proj');
  assert.equal(fx.state.runtime[id].loaded, true);
  await acp.openAcpThread(id);
  assert.equal(log.filter((x) => x[0] === 'history').length, 0, 'nothing to read yet');
  const plain = 'acp:kimi:sched2';
  onEvent({ kind: 'chatStarted', key: plain, chatId: plain, cwd: '/proj', worktreeOf: null });
  assert.deepEqual(called('unhideFolder').at(-1), ['/proj']);
  assert.equal(fx.state.worktreeOf?.[plain], undefined);
});
