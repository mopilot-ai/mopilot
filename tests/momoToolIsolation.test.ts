// MoMo is kept apart from the coding side (#2139), both ways (electron/momo/contract/toolIsolation.cjs): its chats neither see nor
// call the tools that read, list or target other chats, on every harness's channel (the registry's chat scope); no other
// chat reads, messages or mentions a MoMo chat (the peer runtime, the window's mention reader, the Chrome side panel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { sessionToken } from '../shared/sessionMentions.mjs';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { CHAT_TOOLS, isolateChatTools, momoTool, readable } = require('../electron/momo/contract/toolIsolation.cjs');
const { registerPeerTools } = require('../electron/capabilities/contract/peerMessages.cjs');
const { registerChatListTool } = require('../electron/capabilities/tools/chatList.cjs');
const { registerSessionTools } = require('../electron/capabilities/tools/sessions.cjs');
const { registerWindowTools } = require('../electron/capabilities/tools/windowTools.cjs');
const { registerRemoteControlTool } = require('../electron/capabilities/tools/remoteControl.cjs');
const { registerScheduledTaskTools } = require('../electron/capabilities/tools/scheduledTasks.cjs');
const { PeerRuntime } = require('../electron/session/peerRuntime.cjs');
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');

const rec = (meta: any = {}) => ({ segments: [{ kind: 'codex', nativeId: 'n' }], meta, updatedAt: 1 });
const chatsOf = () => ({
  records: new Map<string, any>([
    ['code', rec()],
    ['momo', rec({ momo: 'main' })],
    ['old', rec({ momo: 'previous' })],
    // a channel's journal (A2) is MoMo's like main
    ['chan', rec({ momo: 'channel:ch_0123456789abcdef' })],
  ]),
});

/** The real registrars, with stand-ins for what they would call: what each one registers. */
function registered() {
  const r = new Registry();
  const nop = () => undefined;
  registerPeerTools(r, { service: {}, owner: nop, directory: nop, read: nop });
  registerChatListTool(r, {
    owner: nop,
    records: () => new Map(),
    natives: () => [],
    sources: {},
    projects: () => [],
    home: '/',
    prefs: () => ({}),
  });
  registerSessionTools(r, { orchestrator: {}, owner: nop });
  registerWindowTools(r, {
    owner: nop,
    journal: nop,
    viewedBy: nop,
    windows: () => [],
    createWindow: nop,
    ipcMain: { on: nop, removeListener: nop },
  });
  registerRemoteControlTool(r, { owner: nop, refOf: nop, claude: {} });
  registerScheduledTaskTools(r, { store: {}, run: nop, owner: nop, harnessOf: nop, cwdOf: nop, nextRun: () => null, describe: nop });
  return r;
}

test('every tool that reads, lists or targets other chats is in the chat scope, and every name there is a real tool', () => {
  const r = registered();
  const names = r.list({ all: true }).map((t: any) => t.name);
  assert.deepEqual(
    CHAT_TOOLS.filter((n: string) => !names.includes(n)),
    [],
  );
  // what those registrars register beside them stays a chat's own: its task list and its wrap-up
  assert.deepEqual(
    names.filter((n: string) => !CHAT_TOOLS.includes(n)),
    ['update_task_list', 'wrap_up'],
  );
});

test('a MoMo chat neither sees nor calls the chat tools on any channel; other chats and a list for no chat keep them', async () => {
  const r = registered();
  const ok = async () => ({ content: [{ type: 'text', text: 'ok' }] });
  r.register({ name: 'show_pane', policy: 'observe', handler: ok });
  // a tool on neither list (one added later) stays out of MoMo's chats until it is decided: default deny
  r.register({ name: 'brand_new_tool', policy: 'observe', handler: ok });
  const chats = chatsOf();
  const momo = isolateChatTools(r, () => chats);
  assert.equal(momo('momo'), true);
  assert.equal(momo('chan'), true);
  assert.equal(momo('code'), false);
  const shown = (chatId: string | null) => r.list({ chatId }).map((t: any) => t.name);
  for (const id of ['momo', 'old', 'chan']) {
    assert.deepEqual(
      shown(id).filter((n: string) => CHAT_TOOLS.includes(n)),
      [],
    );
    assert.ok(shown(id).includes('show_pane'));
    assert.ok(shown(id).includes('update_task_list'));
    assert.ok(shown(id).includes('wrap_up'));
    assert.equal(shown(id).includes('brand_new_tool'), false);
  }
  for (const id of ['code', null]) {
    assert.equal(shown(id).filter((n: string) => CHAT_TOOLS.includes(n)).length, CHAT_TOOLS.length);
    assert.ok(shown(id).includes('brand_new_tool'));
  }
  assert.equal((await r.invoke('momo', 'n', 'brand_new_tool', {})).error.code, 'unavailable');
  const res = await r.invoke('momo', 'n', 'list_chats', {});
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'unavailable');
  // before main has its chats, no chat is MoMo's
  const early = new Registry();
  isolateChatTools(early, () => null);
  assert.equal(early.isApart('momo'), false);
  // a rule that fails keeps the chat apart (the tools stay hidden), and a registry no one scoped hides nothing
  const broken = registered();
  broken.setChatScope(momoTool, () => {
    throw new Error('store gone');
  });
  assert.equal(broken.list({ chatId: 'code' }).filter((t: any) => CHAT_TOOLS.includes(t.name)).length, 0);
  assert.ok(broken.list({ chatId: 'code' }).some((t: any) => t.name === 'wrap_up'));
  assert.equal(new Registry().isApart('momo'), false);
});

function peer(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-peer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const chats = chatsOf();
  const registry = new Registry();
  const rts = new Map<string, any>();
  const controller: any = {
    rt: (id: string) => {
      if (!rts.has(id)) rts.set(id, { token: null });
      return rts.get(id);
    },
    state: { get: () => ({ turn: 'idle' }) },
    send: () => ({ action: 'queued' }),
    peerCapabilities: () => ({ messaging: true, read: true, steer: false }),
    removeQueued: () => {},
  };
  const runtime = new PeerRuntime({
    file: path.join(dir, 'journal.json'),
    controller,
    chats,
    registry,
    sourceWindow: (e: any) => e.source,
    referenceWindow: () => true,
    readReference: async (id: string) => ({ turns: [], id }),
    gate: () => null,
    title: (id: string) => `Chat ${id}`,
    read: () => ({ records: ['history'] }),
    publish: () => {},
  });
  const handlers = new Map<string, any>();
  runtime.registerIpc({ handle: (name: string, handler: any) => handlers.set(name, handler) });
  return { runtime, controller, registry, handlers, chats };
}

test('no other chat reads, messages or mentions a MoMo chat; MoMo’s chats send nothing either', async (t) => {
  const { runtime, controller, registry, handlers, chats } = peer(t);
  assert.equal(readable(chats, 'code'), true);
  assert.equal(readable(chats, 'momo'), false);
  assert.equal(readable(chats, 'chan'), false);
  assert.equal(readable(chats, 'nowhere'), false);
  // read_chat, even with the user's own reference to it
  const turn = runtime.userTurn('code', { text: `结合 ${sessionToken('momo', 'MoMo')} 回答`, opts: { human: true } });
  controller.rt('code').token = `pending-${turn.id}`;
  assert.equal((await registry.invoke('code', 'n', 'read_chat', { targetChatId: 'momo' })).error.code, 'chat_unavailable');
  // a message to it, and one from it
  await assert.rejects(runtime.service.send('code', { targetChatId: 'momo', requestId: 'r1', body: 'hi' }), /chat_unavailable/);
  // a channel's journal is as unreachable as main's, both ways
  assert.equal((await registry.invoke('code', 'n', 'read_chat', { targetChatId: 'chan' })).error.code, 'chat_unavailable');
  await assert.rejects(runtime.service.send('code', { targetChatId: 'chan', requestId: 'r1c', body: 'hi' }), /chat_unavailable/);
  await assert.rejects(runtime.service.send('chan', { targetChatId: 'code', requestId: 'r2c', body: 'hi' }), /chat_unavailable/);
  await assert.rejects(runtime.service.send('momo', { targetChatId: 'code', requestId: 'r2', body: 'hi' }), /chat_unavailable/);
  // the window's typed or pasted mention token
  await assert.rejects(handlers.get('peer:referenceHistory')({}, ['code', 'momo']), /chat_unavailable/);
  assert.deepEqual(Object.keys(await handlers.get('peer:referenceHistory')({}, ['code'])), ['code']);
  // a mention typed in a MoMo chat reads no other chat; one in a coding chat, or outside any chat, still does
  await assert.rejects(handlers.get('peer:referenceHistory')({}, ['code'], false, 'momo'), /chat_unavailable/);
  for (const source of ['code', null, 'fresh'])
    assert.deepEqual(Object.keys(await handlers.get('peer:referenceHistory')({}, ['code'], false, source)), ['code']);
  // a MoMo chat lists no other chat; a coding chat's list leaves MoMo's out
  await assert.rejects(handlers.get('peer:directory')({ source: 'momo' }, 'momo', {}), /chat_unavailable/);
  const listed = await handlers.get('peer:directory')({ source: 'code' }, 'code', {});
  assert.equal(JSON.stringify(listed).includes('momo'), false);
});

test('the Chrome side panel never opens, writes to or mentions a MoMo chat', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-panel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sent: any[] = [];
  const opened: any[] = [];
  const stopped: any[] = [];
  const chats = chatsOf();
  const live: any = {
    chats: { ...chats, patchMeta: () => undefined, get: () => undefined },
    controller: {
      state: new Map<string, any>([
        ['fresh', {}],
        ['momo', { turn: 'running', approvals: [{ id: 1 }] }],
        ['code', { turn: 'running', approvals: [] }],
      ]),
      ref: () => null,
      onLiveEvent: null,
      stopChat: async (id: string) => stopped.push(id),
    },
    peerRuntime: { readReference: async () => ({ turns: [], earlierContentOmitted: false }) },
  };
  const panel = createChromePanel({
    live,
    claude: { findBinary: async () => null, catalog: async () => null },
    sources: {},
    projectsFile: projectsFileOf(dir),
    home: dir,
    prefs: () => ({ projectlessFolder: path.join(dir, 'chats') }),
    usable: async () => true,
    starter: {
      prefs: () => ({}),
      codexThread: async () => ({ id: 'th-new' }),
      claudeSession: () => undefined,
      acpSession: () => undefined,
      chats: live.chats,
      started: () => undefined,
    },
    send: async (chatId: string, item: any) => sent.push([chatId, item]),
    open: (chatId: string | null, page?: string) => opened.push([chatId, page]),
    cwdOf: async () => dir,
  });
  const ask = async (method: string, params: any) => {
    let out: any;
    await panel.handle({ id: 1, method, params }, (m: any) => (out = m));
    return out.error ?? out.result;
  };
  assert.match(String(await ask('read', { chatId: 'momo' })), /isn't in MoPilot/);
  assert.match(String(await ask('send', { chatId: 'momo', text: 'hi' })), /isn't in MoPilot/);
  assert.match(String(await ask('send', { chatId: 'code', text: `see ${sessionToken('old', 'Old MoMo')}` })), /isn't a chat in MoPilot/);
  assert.deepEqual(sent, []);
  // every other request that names a MoMo chat: pin, its turn, a card's answer, Stop, opening the app at it, the menus
  for (const [method, params] of [
    ['pin', { chatId: 'momo', pinned: true }],
    ['answer', { chatId: 'momo', approvalId: 1, choice: 'allow' }],
    ['stop', { chatId: 'momo' }],
    ['open', { chatId: 'momo' }],
    ['options', { chatId: 'momo' }],
    ['choose', { chatId: 'momo', model: 'opus', effort: null }],
    ['permit', { chatId: 'momo', value: 'default' }],
    ['commands', { chatId: 'momo' }],
  ] as const)
    assert.match(String(await ask(method, params)), /isn't in MoPilot/, method);
  assert.equal(panel.o.turn('momo'), undefined);
  assert.deepEqual([opened, stopped], [[], []]);
  // a coding chat keeps them, and opening the app at no chat or at a page still works
  assert.deepEqual(await ask('pin', { chatId: 'code', pinned: true }), { pinned: true });
  assert.equal(panel.o.turn('code'), 'running');
  assert.deepEqual(await ask('stop', { chatId: 'code' }), { stopped: true });
  await ask('open', { chatId: 'code' });
  await ask('open', { page: 'scheduled' });
  assert.deepEqual(stopped, ['code']);
  assert.deepEqual(opened, [
    ['code', undefined],
    [null, 'scheduled'],
  ]);
  // a coding chat, and one started a moment ago with no record yet, still are
  await ask('send', { chatId: 'code', text: 'hi' });
  await ask('send', { chatId: 'fresh', text: 'hi' });
  assert.deepEqual(
    (sent as any[]).map((x: any) => x[0]),
    ['code', 'fresh'],
  );
});

test("a chat of MoMo's memory pass is MoMo's (hidden from every chat list) and sees and calls no tool at all, MoMo's own included", async () => {
  const { dataOnlyMeta } = require('../electron/momo/contract/toolIsolation.cjs');
  const { isMomoMeta } = await import('../shared/momoChat.mjs');
  const meta = { momo: 'memory', forChat: 'momo' };
  assert.equal(isMomoMeta(meta), true, 'every MoMo-only rule (lists, usage sharing, peer reads) covers it');
  assert.equal(dataOnlyMeta(meta), true);
  assert.equal(dataOnlyMeta({ momo: 'main' }), false);
  assert.equal(dataOnlyMeta(undefined), false);
  const r = new Registry();
  for (const name of [
    'momo_memory_save',
    'momo_calendar_events',
    'browser_navigate',
    'chrome_click',
    'computer_screenshot',
    'show_pane',
    'list_chats',
  ])
    r.register({ name, policy: 'observe', handler: () => 'ran' });
  const chats = chatsOf();
  chats.records.set('pass', rec(meta));
  isolateChatTools(r, () => chats);
  assert.deepEqual(
    r.list({ chatId: 'pass' }).map((t: any) => t.name),
    [],
    'nothing listed',
  );
  for (const name of ['momo_memory_save', 'browser_navigate', 'computer_screenshot']) {
    const res = await r.invoke('pass', 'codex:s1', name, {});
    assert.equal(res.ok, false, name);
  }
  assert.ok(
    r.list({ chatId: 'momo' }).some((t: any) => t.name === 'momo_memory_save'),
    'MoMo’s main chat keeps its tools',
  );
  assert.ok(
    r.list({ chatId: 'code' }).some((t: any) => t.name === 'list_chats'),
    'a coding chat keeps its tools',
  );
});

test('a registry with no chat scope set keeps no chat apart and limits none', () => {
  const r = new Registry();
  assert.equal(r.isApart('any'), false);
  assert.equal(r.apartAllows('show_pane', 'any'), true);
});
