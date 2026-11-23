// electron/capabilities/tools/sessions.cjs and electron/app/orchestration.cjs: the linked-session tools answer only the
// chat that owns the call, carry the orchestrator's error codes, and the wiring adds the orchestrator beside the
// controller hooks already there (never replacing the peer service's or the turn-end ledger's).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SESSION_BACKGROUND as BACKGROUND } from './support/orchestration-harness.ts';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { registerSessionTools } = require('../electron/capabilities/tools/sessions.cjs');
const { createOrchestration } = require('../electron/app/orchestration.cjs');

function registry() {
  const r = new Registry();
  r.setApprover(async () => true);
  return r;
}

test('the tools resolve the calling chat from its segment and pass the orchestrator’s answers and error codes', async () => {
  const calls: any[] = [];
  const orchestrator: any = {
    unavailable: null,
    start: async (id: string, a: any) => (calls.push(['start', id, a]), { status: 'started' }),
    list: (id: string) => (calls.push(['list', id]), { sessions: [] }),
    message: async (id: string, a: any) => {
      calls.push(['message', id, a]);
      throw Object.assign(new Error('not linked'), { code: 'not_linked' });
    },
    stop: async () => {
      throw new Error('plain failure');
    },
    dismiss: (id: string, a: any) => (calls.push(['dismiss', id, a]), { status: 'dismissed' }),
    handOff: async (id: string, a: any) => (calls.push(['handOff', id, a]), { status: 'started' }),
    archive: (id: string, a: any) => (calls.push(['archive', id, a]), { archived: true, name: 'kid' }),
    taskList: (id: string, a: any) => (calls.push(['taskList', id, a]), { steps: 1 }),
    wrapUp: (id: string, a: any) => (calls.push(['wrapUp', id, a]), { shown: true }),
  };
  const r = registry();
  const dispose = registerSessionTools(r, { orchestrator, owner: (ctx: any) => (ctx.segmentId === 'seg' ? ctx.chatId : null) });
  assert.deepEqual(
    r.list().map((t: any) => [t.name, t.policy]),
    [
      ['configure_main_repair', 'act'],
      ['request_main_repair', 'act'],
      ['get_main_repair', 'observe'],
      ['start_session', 'act'],
      ['dismiss_task', 'act'],
      ['hand_off_to_session', 'act'],
      ['list_sessions', 'observe'],
      ['send_message', 'act'],
      ['stop_session', 'act'],
      ['archive_session', 'act'],
      ['update_task_list', 'observe'],
      ['wrap_up', 'observe'],
    ],
  );
  orchestrator.o = { mainRepair: () => ({ status: async (id: string) => ({ repo: id }) }) };
  assert.deepEqual(JSON.parse((await r.invoke('top', 'seg', 'get_main_repair', {})).content[0].text), { repo: 'top' });
  // as Claude Desktop's: a list for every multi-step request, riding with the turn's first tool call, sent again after
  // each user message, kept in one list, and never closed over unperformed work
  const listTool = r.list().find((t: any) => t.name === 'update_task_list');
  assert.match(listTool.description, /Every request that edits files or runs more than one command gets one/);
  assert.match(listTool.description, /IN THE SAME MESSAGE as another tool call, never alone/);
  assert.match(listTool.description, /with the very first tool call of the turn/);
  assert.match(
    listTool.description,
    /After the user’s new message, even a correction or a question mid-task: \{"items": \[\.\.\.\]\} again/,
  );
  assert.match(listTool.description, /After a wake-up, reconcile the list with what actually completed/);
  assert.match(listTool.description, /mark every step you performed completed before wrap_up/);
  assert.match(listTool.description, /instead of in a plan or todo tool of your own/);
  assert.match(listTool.description, /Never mark unfinished or blocked work completed/);
  assert.match(listTool.description, /set_pr_monitor.continuation/);
  // the wrap-up is the turn's end when it draws a box, and comes before the closing message only when it does not
  const wrapTool = r.list().find((t: any) => t.name === 'wrap_up');
  assert.doesNotMatch(wrapTool.description, /before your closing message/);
  assert.match(
    wrapTool.description,
    /With a question and answers the app draws a box under the turn that ends it: write no text after the call/,
  );
  assert.match(wrapTool.description, /A recap alone draws no box .*write your closing message after the call/);
  assert.match(wrapTool.description, /in the user’s language/);
  assert.match(wrapTool.description, /checks off the task list’s last step when that step is the one in progress/);
  const started = await r.invoke('top', 'seg', 'start_session', { background: BACKGROUND, title: 'T', prompt: 'P' });
  assert.equal(started.ok, true);
  assert.deepEqual(calls[0], ['start', 'top', { background: BACKGROUND, title: 'T', prompt: 'P' }]);
  assert.equal((await r.invoke('top', 'seg', 'list_sessions', { linked: true })).ok, true);
  assert.equal((await r.invoke('top', 'seg', 'dismiss_task', { task_id: 'task_1' })).ok, true);
  assert.equal(
    (await r.invoke('top', 'seg', 'hand_off_to_session', { background: BACKGROUND, title: 'T', remaining_plan: 'rest' })).ok,
    true,
  );
  assert.equal((await r.invoke('top', 'seg', 'update_task_list', { items: [{ content: 'a', status: 'pending' }] })).ok, true);
  assert.equal((await r.invoke('top', 'seg', 'wrap_up', { recap: 'done' })).ok, true);
  assert.deepEqual(calls.slice(-2), [
    ['taskList', 'top', { items: [{ content: 'a', status: 'pending' }] }],
    ['wrapUp', 'top', { recap: 'done' }],
  ]);
  calls.splice(-2);
  // archiving is asked for only after the user said yes, and only for a session this chat started
  const archiveTool = r.list().find((t: any) => t.name === 'archive_session');
  assert.match(archiveTool.description, /only after the user said yes/);
  assert.match(archiveTool.description, /this chat started/);
  assert.equal((await r.invoke('top', 'seg', 'archive_session', { id: 'kid' })).ok, true);
  assert.deepEqual(calls.pop(), ['archive', 'top', { id: 'kid' }]);
  assert.deepEqual(calls.slice(-2), [
    ['dismiss', 'top', { task_id: 'task_1' }],
    ['handOff', 'top', { background: BACKGROUND, title: 'T', remaining_plan: 'rest' }],
  ]);
  const refused = await r.invoke('top', 'seg', 'send_message', { to: 'x', message: 'm' });
  assert.equal(refused.ok, false);
  assert.match(JSON.stringify(refused), /not_linked/);
  const plain = await r.invoke('top', 'seg', 'stop_session', { id: 'x' });
  assert.equal(plain.ok, false);
  assert.match(JSON.stringify(plain), /plain failure/);
  const stranger = await r.invoke('top', 'other-seg', 'list_sessions', {});
  assert.match(JSON.stringify(stranger), /no_owner/);
  orchestrator.unavailable = 'journal_unavailable';
  assert.match(JSON.stringify(await r.invoke('top', 'seg', 'list_sessions', {})), /journal_unavailable/);
  dispose();
  assert.equal(r.list().length, 0);
});

test('createOrchestration adds its hooks beside the ones there, registers the tools, serves the snapshot and publishes changes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wiring-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const order: string[] = [];
  let turn = 'idle';
  const controller: any = {
    state: { get: () => ({ turn, queue: [], approvals: [], activeTurn: null }) },
    rt: () => ({ inputToken: 'pending-1' }),
    ref: () => ({ kind: 'codex', id: 'n', key: 'k' }),
    onFinished: () => order.push('ledger finished'),
    onStopped: () => {
      order.push('peer stopped');
      throw new Error('pause not saved');
    },
    onCrash: () => order.push('ledger crash'),
    beforeDispatch: async () => order.push('peer dispatch'),
  };
  const handlers = new Map<string, any>();
  const broadcasts: any[] = [];
  const reg = registry();
  const live: any = {
    controller,
    chats: { records: new Map([['top', { meta: {} }]]) },
    capabilities: reg,
    peerRuntime: {
      readReference: async () => ({ turns: [{ items: [{ type: 'agentMessage', text: 'earlier answer' }] }] }),
      referenceWindow: (event: any) => event?.sender === 'app window',
    },
    codex: { chatName: (id: string) => (id === 'top' ? 'Top' : '') },
    chatDeletion: { onDeleted: (r: any) => order.push(`search forgets ${r.chatId}`) },
  };
  const orch = createOrchestration({
    file: path.join(dir, 'orchestration.json'),
    live,
    starter: { prefs: () => ({}) },
    usable: async () => true,
    send: async () => ({ started: true }),
    projectOf: async () => dir,
    worktreeInfo: () => null,
    owner: (ctx: any) => ctx.chatId,
    ipcMain: { handle: (name: string, fn: any) => handlers.set(name, fn) },
    broadcastAll: (...a: any[]) => broadcasts.push(a),
  });
  assert.ok(reg.has('start_session') && reg.has('send_message'));
  assert.equal(await orch.o.readExcerpt('top'), 'Agent: earlier answer');
  assert.equal(orch.o.title('top'), 'Top');
  assert.equal(orch.o.title('other'), null);
  // archive_session archives the way the inactive-chat sweep does, once the chats' IPC has set it up
  assert.equal(orch.o.archive('kid'), false);
  live.archiveChat = (id: string) => id === 'kid';
  assert.equal(orch.o.archive('kid'), true);
  assert.equal(orch.o.archive('other'), false);
  // the linked sessions' status a message carried counts as seen once the harness took it, beside the peer hook
  const item = { text: 'hi', opts: { human: true } };
  orch.roster.sent.set(item, ['top\nk', 'ROSTER']);
  await controller.onDispatchResult({ chatId: 'top', item, result: { started: true } });
  assert.equal(orch.roster.seen.get('top\nk'), 'ROSTER');
  live.peerRuntime.readReference = async () => null;
  assert.equal(await orch.o.readExcerpt('top'), null);
  // the hooks there keep running first, and a failure of the orchestrator's own never shows
  orch.finished = () => {
    order.push('orchestration finished');
    throw new Error('orchestration bug');
  };
  controller.onFinished({ chatId: 'x', completed: true });
  turn = 'running';
  assert.throws(() => controller.onStopped('x'), /pause not saved/);
  assert.ok(orch.stopping.has('x'), 'the orchestrator saw the stop although the peer hook threw');
  controller.onCrash('x');
  assert.ok(!orch.stopping.has('x'), 'a crash ends the stopped turn too');
  // a request to the user in a chat the journal never linked starts no settle wait (reportRoute.cjs)
  controller.onAwaitingUser('x');
  assert.equal(orch.settleTimers.size, 0);
  await controller.beforeDispatch({ chatId: 'x', item: { opts: {} } });
  assert.deepEqual(order, ['ledger finished', 'orchestration finished', 'peer stopped', 'ledger crash', 'peer dispatch']);
  assert.deepEqual(await handlers.get('orchestration:snapshot')({ sender: 'app window' }), {
    children: {},
    deliveries: {},
    proposals: {},
    queue: [],
    plans: {},
    wrapUps: {},
    waiting: {},
  });
  orch.act = (id: string, action: string, options: unknown) => Promise.resolve({ acted: [id, action, options] });
  assert.deepEqual(await handlers.get('orchestration:task')({ sender: 'app window' }, 'task_1', 'dismiss'), {
    acted: ['task_1', 'dismiss', null],
  });
  // what the user picked on the card goes with a start
  assert.deepEqual(await handlers.get('orchestration:task')({ sender: 'app window' }, 'task_1', 'start', { harness: 'claude' }), {
    acted: ['task_1', 'start', { harness: 'claude' }],
  });
  assert.throws(() => handlers.get('orchestration:task')({ sender: 'a guest page' }, 'task_1', 'start'), /Unknown app window/);
  // a card's Merge or Open PR goes to the child's work, from the app's own windows only, with main's own git and gh
  assert.equal(typeof orch.o.run.git, 'function');
  await assert.rejects(
    handlers.get('orchestration:child')({ sender: 'app window' }, 'nobody', 'merge'),
    (e: any) => e.code === 'no_worktree',
  );
  assert.throws(() => handlers.get('orchestration:child')({ sender: 'a guest page' }, 'nobody', 'merge'), /Unknown app window/);
  assert.throws(() => handlers.get('orchestration:snapshot')({ sender: 'a guest page' }), /Unknown app window/);
  orch.journal.change((d: any) => (d.children.c = { parentId: 'top', name: 'c', title: 'C', driven: [], lastReport: null }));
  assert.equal(broadcasts.at(-1)[0], 'orchestration:changed');
  assert.equal(broadcasts.at(-1)[1].children.c.name, 'c');
  // a deleted chat leaves the journal, beside the deletion hook already there
  live.chatDeletion.onDeleted({ chatId: 'c' });
  assert.equal(order.at(-1), 'search forgets c');
  assert.equal(broadcasts.at(-1)[1].children.c, undefined);
  // without a tool registry the orchestrator still runs
  const bare = createOrchestration({
    file: path.join(dir, 'other.json'),
    live: { ...live, capabilities: null, codex: null, controller: { ...controller } },
    starter: { prefs: () => ({}) },
    usable: async () => true,
    send: async () => ({}),
    projectOf: async () => null,
    worktreeInfo: () => null,
    owner: () => null,
    ipcMain: { handle: () => {} },
    broadcastAll: () => {},
  });
  assert.equal(bare.o.title('top'), null);
});

test('the wiring adds the window tools for the app’s windows (never Quick Chat), on the same journal', async () => {
  const { EventEmitter } = await import('node:events');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-window-'));
  const reg = registry();
  const ipcMain: any = Object.assign(new EventEmitter(), { handle: () => {} });
  const win = (id: number, layout: any) => ({
    isDestroyed: () => false,
    isFocused: () => false,
    webContents: Object.assign(new EventEmitter(), {
      id,
      isCrashed: () => false,
      send: (channel: string, rid: number) =>
        queueMicrotask(() => ipcMain.emit(`${channel}:reply`, {}, rid, { outcome: 'layout', layout })),
    }),
  });
  const main = win(1, { main: { session_id: 'top' }, panes: [], focused: 'main' });
  const mini = win(2, { main: { page: 'quick' }, panes: [], focused: 'main' });
  const viewedBy = new Map([
    [1, { visible: ['top'], primary: 'top', focused: 'top' }],
    [2, { visible: ['top'], primary: 'top', focused: 'top' }],
  ]);
  const created: any[] = [];
  createOrchestration({
    file: path.join(dir, 'orchestration.json'),
    live: { controller: { onDispatchResult: null }, chats: { records: new Map() }, capabilities: reg },
    starter: { prefs: () => ({}) },
    usable: async () => true,
    send: async () => ({ started: true }),
    projectOf: async () => dir,
    worktreeInfo: () => null,
    owner: (ctx: any) => ctx.chatId,
    ipcMain,
    broadcastAll: () => {},
    appWindows: { viewedBy, windows: new Set([main, mini]), mini, createWindow: (...a: any[]) => created.push(a) },
  } as any);
  assert.ok(reg.has('open_session_in') && reg.has('close_split') && reg.has('get_window_layout'));
  const layout = await reg.invoke('top', 'seg', 'get_window_layout', {});
  assert.deepEqual(JSON.parse(layout.content[0].text), {
    on_screen: true,
    main: { session_id: 'top' },
    panes: [],
    focused: 'main',
    windows_showing_this_session: 1,
  });
  // the journal knows no child of top: only "self" resolves
  assert.equal((await reg.invoke('top', 'seg', 'open_session_in', { session_id: 'kid', target: 'window' })).error.code, 'not_linked');
  assert.deepEqual(created, []);
});

test('the wiring adds the pane tools, and a terminal asks its card through the broker with the call’s signal', async () => {
  const { EventEmitter } = await import('node:events');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pane-'));
  const reg = registry();
  const ipcMain: any = Object.assign(new EventEmitter(), { handle: () => {} });
  const main = {
    isDestroyed: () => false,
    isFocused: () => true,
    webContents: Object.assign(new EventEmitter(), {
      id: 1,
      isCrashed: () => false,
      send: (channel: string, rid: number) =>
        queueMicrotask(() => ipcMain.emit(`${channel}:reply`, {}, rid, { outcome: 'opened', tab_id: 'terminal-1' })),
    }),
  };
  const asked: any[] = [];
  const typedInto: any[] = [];
  let decision = 'allow';
  const live: any = {
    controller: { onDispatchResult: null, ref: () => ({ kind: 'claude' }) },
    chats: { records: new Map() },
    pty: {
      info: () => ({ tail: '$ ', outputAt: 0, typed: false, running: false }),
      write: (key: string, data: string) => void typedInto.push([key, data]),
    },
    capabilities: reg,
    computerUse: { cu: { anchor: () => 'ask' }, broker: { ask: async (...a: any[]) => (asked.push(a), { decision }) } },
  };
  const wiring = {
    file: path.join(dir, 'orchestration.json'),
    live,
    starter: { prefs: () => ({}) },
    usable: async () => true,
    send: async () => ({ started: true }),
    projectOf: async () => dir,
    worktreeInfo: () => null,
    owner: (ctx: any) => ctx.chatId,
    ipcMain,
    broadcastAll: () => {},
    appWindows: {
      viewedBy: new Map([[1, { visible: ['top'], primary: 'top', focused: 'top' }]]),
      windows: new Set([main]),
      mini: null,
      createWindow: () => {},
    },
  };
  createOrchestration(wiring as any);
  assert.ok(reg.has('show_pane') && reg.has('close_pane') && reg.has('open_terminal_tab'));
  const res = await reg.invoke('top', 'seg', 'open_terminal_tab', {});
  assert.equal(JSON.parse(res.content[0].text).tab_id, 'terminal-1');
  assert.deepEqual(asked[0].slice(0, 3), ['top', 'terminalTab', { harness: 'claude', cwd: dir, tool: 'open_terminal_tab' }]);
  assert.ok(asked[0][3].signal instanceof AbortSignal);
  // a command asks its own card through the same broker, naming the line; the chat's mode decides whether it is asked
  const typed = await reg.invoke('top', 'seg', 'run_in_terminal', { command: 'npm test', tab_id: 'terminal-1' });
  assert.deepEqual(asked[1].slice(0, 3), [
    'top',
    'terminalTab',
    { harness: 'claude', cwd: dir, command: 'npm test', tool: 'run_in_terminal' },
  ]);
  assert.equal(JSON.parse(typed.content[0].text).changed, true);
  assert.deepEqual(typedInto, [['wc1:terminal-1', 'npm test\r']]);
  // declined, or no broker to ask: nothing opens
  decision = 'deny';
  assert.equal((await reg.invoke('top', 'seg', 'open_terminal_tab', { cwd: os.tmpdir() })).error.code, 'denied');
  const bare = registry();
  createOrchestration({ ...wiring, file: path.join(dir, 'o2.json'), live: { ...live, capabilities: bare, computerUse: undefined } } as any);
  assert.equal((await bare.invoke('top', 'seg', 'open_terminal_tab', {})).error.code, 'denied');
  assert.equal((await bare.invoke('top', 'seg', 'run_in_terminal', { command: 'ls' })).error.code, 'denied');
});
