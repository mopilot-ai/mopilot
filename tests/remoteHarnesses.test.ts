// The real panel wiring (app/chromePanel.cjs) serving a phone on a Codex, a Claude Code and an ACP chat: follow, answer through each harness's own path, send, start, and a phone and a window answering one card.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createMemoryLink } from '../shared/remote/transport.mjs';
import { settle } from './support/remote-kit.ts';

const require = createRequire(import.meta.url);
const { SessionStore } = require('../electron/session/state.cjs');
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-remote-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** Each harness: its chat, the card it raises, and what answering "once" must do. */
const HARNESS = {
  codex: {
    chat: 'th-cx',
    kind: 'codex',
    card: { id: 12, method: 'item/commandExecution/requestApproval', params: { command: 'make' } },
    live: { method: 'item/completed', params: { threadId: 'th-cx', item: { type: 'agentMessage', id: 'm1', text: 'Hello', phase: null } } },
    key: 'once',
    expect: [
      ['onCodexOutgoing', { id: 12, result: { decision: 'accept' } }],
      ['codex', 12, { decision: 'accept' }],
    ],
  },
  claude: {
    chat: 'claude:cl',
    kind: 'claude',
    card: { id: 'cperm-1', method: 'claude/permission', params: { toolName: 'Bash', input: { command: 'ls' }, suggestions: [] } },
    live: {
      kind: 'message',
      key: 'claude:cl',
      msg: { type: 'assistant', uuid: 'a', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: 'Hello' }] } },
    },
    key: 'once',
    expect: [
      ['resolveApproval', 'cperm-1'],
      ['claude', 'cperm-1'],
    ],
  },
  acp: {
    chat: 'acp:kimi:ac',
    kind: 'acp:kimi',
    card: {
      id: 'p1',
      method: 'acp/permission',
      params: { toolCall: { title: 'Act' }, options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }] },
    },
    live: {
      kind: 'update',
      key: 'acp:kimi:ac',
      turnId: 't',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
    },
    key: 'o0',
    expect: [
      ['resolveApproval', 'p1'],
      ['acp', 'p1', 'yes'],
    ],
  },
} as const;

function world(usageIdentity?: any) {
  const calls: any[] = [];
  const holder: { panel?: any } = {};
  const state = new SessionStore({ publish: (p: any) => holder.panel?.service.onSessionPatch(p) });
  const records = new Map<string, any>(
    Object.values(HARNESS).map((h) => [h.chat, { segments: [{ kind: h.kind, nativeId: h.chat }], meta: {} }]),
  );
  const live: any = {
    chats: { records, patchMeta: () => true },
    controller: {
      state,
      chatOf: (k: string) => k,
      ref: (id: string) => ({ kind: records.get(id)?.segments[0].kind ?? 'codex', key: id }),
      resolveApproval: (id: any) => calls.push(['resolveApproval', id]),
      onCodexOutgoing: (m: any) => (calls.push(['onCodexOutgoing', m]), true),
      stopChat: async (id: string) => calls.push(['stopChat', id]),
    },
    acpAdmission: { list: () => [{ id: 'kimi', state: 'admitted', label: 'Kimi Code' }], admitted: () => true },
    peerRuntime: { readHistory: async () => ({ turns: [], earlierContentOmitted: false }) },
    acpHost: { permission: (id: string, option: string) => (calls.push(['acp', id, option]), true) },
    codex: {
      respond: (id: any, result: any) => calls.push(['codex', id, result]),
      chatName: () => null,
      modelList: async () => ({ data: [] }),
    },
  };
  const panel = createChromePanel({
    live,
    claude: {
      resolvePermission: (id: string, a: any) => (calls.push(['claude', id, a]), true),
      identity: usageIdentity,
      probeInfo: () => ({ models: [{ value: 'opus', displayName: 'Opus' }] }),
    },
    sources: {},
    projectsFile: projectsFileOf(scratch),
    home: scratch,
    prefs: () => ({ projectlessFolder: path.join(scratch, 'chats') }),
    usable: async () => true,
    starter: {
      prefs: () => ({}),
      codexThread: async ({ cwd }: any) => (calls.push(['startCodex', cwd]), { id: 'th-new' }),
      claudeSession: (key: string) => calls.push(['startClaude', key]),
      acpSession: (key: string) => calls.push(['startAcp', key]),
      chats: live.chats,
      started: () => undefined,
    },
    send: async (chatId: string, item: any) => (calls.push(['send', chatId, item.text]), { action: 'started', id: 'x' }),
    open: () => undefined,
    now: () => new Date('2026-10-26T10:00:00Z'),
    remote: { momoAllowed: () => false, version: '9.9' },
  });
  holder.panel = panel;
  const link = createMemoryLink();
  link.addPair('p1');
  panel.service.attach(link.mac);
  const end = link.phone('p1');
  const inbox: any[] = [];
  end.onMessage((m: any) => inbox.push(m));
  let n = 0;
  const ask = async (method: string, params: any = {}) => {
    const id = `r${++n}`;
    await end.send({ id, t: 1, kind: 'request', method, params });
    await settle();
    return inbox.filter((m) => m.inReplyTo === id).at(-1);
  };
  const windowAsk = (method: string, params: any) => new Promise<any>((resolve) => void panel.handle({ id: 1, method, params }, resolve));
  return { calls, state, live, panel, ask, inbox, windowAsk };
}

for (const [name, h] of Object.entries(HARNESS)) {
  test(`${name}: a phone follows the chat, answers its card through the harness's own path, and sends to it`, async () => {
    const w = world();
    w.state.patch(h.chat, { turn: 'awaitingUser', approvals: [h.card] });
    const snap = (await w.ask('chat.follow', { chatId: h.chat })).result;
    assert.equal(snap.session.turn, 'awaitingUser');
    assert.equal(snap.session.cards.length, 1);
    assert.equal(snap.session.cards[0].id, h.card.id);
    assert.equal(snap.session.approvals, undefined);
    assert.equal(snap.itemsShape, 'rows');
    const answer = await w.ask('card.answer', { chatId: h.chat, cardId: h.card.id, rev: snap.session.cards[0].rev, key: h.key });
    assert.equal(answer.ok, true, JSON.stringify(answer.error));
    assert.deepEqual(
      w.calls.map((c) => (c[0] === 'claude' ? [c[0], c[1]] : c)),
      h.expect,
    );
    // the card is gone now; a second answer is stale
    w.state.patch(h.chat, { turn: 'running', approvals: [] });
    const late = await w.ask('card.answer', { chatId: h.chat, cardId: h.card.id, rev: snap.session.cards[0].rev, key: h.key });
    assert.equal(late.error.code, 'stale');
    // a follow-up goes through the controller's send as the user's own message
    assert.equal((await w.ask('chat.send', { chatId: h.chat, text: 'and then?' })).result.sent, true);
    assert.deepEqual(w.calls.at(-1), ['send', h.chat, 'and then?']);
    assert.equal((await w.ask('chat.stop', { chatId: h.chat })).result.stopped, true);
    assert.deepEqual(w.calls.at(-1), ['stopChat', h.chat]);
    // the chat's translated items reach the follower once a transport is attached
    w.live.controller.onLiveEvent(name, h.live);
    await new Promise((r) => setTimeout(r, 150));
    await settle();
    const appended = w.inbox.filter((m) => m.ev === 'items.append' || m.ev === 'items.delta');
    assert.ok(appended.length > 0, 'the follower got items');
  });
}

test('a phone and a window answering one card: the first wins and the other is told so', async () => {
  for (const order of ['phone first', 'window first']) {
    const w = world();
    const h = HARNESS.codex;
    w.state.patch(h.chat, { turn: 'awaitingUser', approvals: [h.card] });
    const snap = (await w.ask('chat.follow', { chatId: h.chat })).result;
    const version = (await w.windowAsk('read', { chatId: h.chat })).result.approvals[0].version;
    const phone = () => w.ask('card.answer', { chatId: h.chat, cardId: 12, rev: snap.session.cards[0].rev, key: 'once' });
    const window = () => w.windowAsk('answer', { chatId: h.chat, approvalId: 12, choice: 'once', version });
    const [first, second] = order === 'phone first' ? [phone, window] : [window, phone];
    const a = await first();
    // the harness took the first answer; main retires the card as the controller does
    w.state.patch(h.chat, { turn: 'running', approvals: [] });
    const b = await second();
    if (order === 'phone first') {
      assert.equal(a.ok, true);
      assert.match(b.error, /already answered/);
    } else {
      assert.equal(a.result.answered, true);
      assert.equal(b.error.code, 'stale');
    }
    assert.equal(w.calls.filter((c) => c[0] === 'codex').length, 1, order);
  }
});

test('a phone starts a chat on each harness, reads the menus and gets the machine hello', async () => {
  const w = world();
  assert.equal((await w.ask('machine.hello')).result.app, '9.9');
  assert.deepEqual(
    (await w.ask('harnesses.list')).result.harnesses.map((x: any) => x.id),
    ['claude', 'codex', 'acp:kimi'],
  );
  assert.equal((await w.ask('chat.start', { harness: 'codex', text: 'one' })).result.chatId, 'th-new');
  assert.match((await w.ask('chat.start', { harness: 'claude', text: 'two' })).result.chatId, /^claude:/);
  assert.match((await w.ask('chat.start', { harness: 'acp:kimi', text: 'three' })).result.chatId, /^acp:kimi:/);
  assert.deepEqual(
    w.calls.filter((c) => c[0] === 'send').map((c) => c[2]),
    ['one', 'two', 'three'],
  );
});

test('a chat main does not know is gone for a phone; reading it does not start a panel watch', async () => {
  const w = world();
  assert.equal((await w.ask('chat.follow', { chatId: 'nowhere' })).error.code, 'gone');
  w.state.patch('th-cx', { plan: true });
  const snap = (await w.ask('chat.follow', { chatId: 'th-cx' })).result;
  assert.equal(snap.chatId, 'th-cx');
  w.panel.push = () => assert.fail('the phone’s snapshot must not watch the chat for the panel');
  await w.ask('chat.follow', { chatId: 'th-cx' });
});

test('a chat started a moment ago can be followed; items follow once main has seen the chat’s events; translation stops with the transport', async () => {
  const w = world();
  w.state.patch('fresh', { turn: 'running' });
  const first = (await w.ask('chat.follow', { chatId: 'fresh' })).result;
  assert.equal(first.itemsShape, 'rows');
  assert.deepEqual(first.items, []);
  const h = HARNESS.codex;
  w.live.controller.onLiveEvent('codex', { ...h.live, params: { ...h.live.params, threadId: 'fresh' } });
  await new Promise((r) => setTimeout(r, 150));
  const again = (await w.ask('chat.follow', { chatId: 'fresh' })).result;
  assert.equal(again.itemsShape, 'items');
  assert.equal(again.items[0].text, 'Hello');
  // an event main cannot place in a chat is noted, not thrown
  w.live.controller.chatOf = () => {
    throw new Error('no chat');
  };
  assert.doesNotThrow(() => w.live.controller.onLiveEvent('claude', { kind: 'message', key: 'k' }));
  // with no transport nothing is translated
  w.panel.service.detach();
  assert.doesNotThrow(() => w.live.controller.onLiveEvent('codex', h.live));
});

test('a follow that asks for no items sends none, whichever source they come from', async () => {
  const w = world();
  w.state.patch('th-cx', { plan: true });
  assert.deepEqual((await w.ask('chat.follow', { chatId: 'th-cx', items: 0 })).result.items, []);
});

test('phone usage reaches the production operation factory and preserves surface versus explicit refresh for each harness', async () => {
  const reasons: any[] = [];
  const at = Date.now();
  const w = world({
    accounts: () => ({ view: () => ({ accounts: [{ id: 'work', serverId: 'claude-work' }] }) }),
    readUsageResult: async (account: string, reason: string) => {
      reasons.push(['claude', account, reason]);
      return { state: 'success', account: 'claude-work', measuredAt: at, text: 'Current session: 35% used' };
    },
  });
  const accounts = ['claude', 'codex'].map((harness) => ({
    harness,
    account: 'work',
    label: `${harness} Work`,
    billing: 'subscription',
    status: 'ok',
    active: true,
  }));
  w.live.identity = {
    instances: (harness?: string) => accounts.filter((a) => !harness || a.harness === harness),
    driver: () => ({
      usage: async (account: string, reason: string) => {
        reasons.push(['codex', account, reason]);
        return { at, primary: { usedPercent: 42, windowDurationMins: 300 } };
      },
    }),
  };
  for (const refresh of [false, true]) {
    const answer = await w.ask('usage.get', { refresh });
    assert.equal(answer.ok, true, JSON.stringify(answer.error));
    assert.equal(answer.result.scope, 'local');
    assert.deepEqual(
      answer.result.accounts.map((a: any) => [a.harness, a.state, a.windows[0].usedPercent]),
      [
        ['claude', 'available', 35],
        ['codex', 'available', 42],
      ],
    );
  }
  assert.deepEqual(reasons, [
    ['claude', 'work', 'surface'],
    ['codex', 'work', 'surface'],
    ['claude', 'work', 'now'],
    ['codex', 'work', 'now'],
  ]);
});

test('harnesses.list with states names every agent with its state and whether a chat can move to it; without states the list is as before', async () => {
  const w = world();
  (w.live.acpAdmission as any).list = () => [
    { id: 'kimi', state: 'admitted', label: 'Kimi Code' },
    { id: 'gem', state: 'signin', label: 'Gemini', reason: 'Sign in with its CLI' },
    { id: 'old', state: 'off', reason: 'Switched off' },
    { id: 'gone', state: 'missing' },
    { id: 'new', state: 'checking' },
  ];
  const plain = await w.ask('harnesses.list');
  assert.equal(plain.ok, true, JSON.stringify(plain.error));
  assert.equal('states' in plain.result, false);
  const r = await w.ask('harnesses.list', { states: true });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const by = Object.fromEntries(r.result.states.map((h: any) => [h.id, h]));
  assert.deepEqual(by.claude, {
    id: 'claude',
    label: 'Claude Code',
    kind: 'builtin',
    state: 'ready',
    reason: null,
    canSwitch: true,
    switchReason: null,
  });
  // Codex lists no model on this Mac: the Mac would refuse a move to it, so the phone is told why
  assert.deepEqual([by.codex.canSwitch, by.codex.switchReason], [false, 'Pick a model for Codex in MoPilot first.']);
  assert.deepEqual([by['acp:kimi'].kind, by['acp:kimi'].state, by['acp:kimi'].canSwitch], ['acp', 'ready', true]);
  assert.deepEqual([by['acp:gem'].state, by['acp:gem'].reason], ['signin', 'Sign in with its CLI']);
  assert.deepEqual([by['acp:old'].state, by['acp:gone'].state, by['acp:new'].state], ['off', 'missing', 'checking']);
  assert.equal(by['acp:old'].label, 'old');
});

test('phone accounts reach the production operation factory: the registry’s logins read, and auto-switch lands on each harness’s own accounts', async () => {
  const set: any[] = [];
  const w = world({ accounts: () => ({ setAutoSwitch: (on: boolean) => set.push(['claude', on]) }) });
  w.live.accounts = { setAutoSwitch: (on: boolean) => set.push(['codex', on]) };
  w.live.identity = {
    instances: (harness: string) =>
      harness === 'codex' ? [{ account: 'a', label: 'a@x.com', status: 'ok', billing: 'subscription', active: true }] : [],
    driver: () => ({ poolPolicy: { pool: 'spread', autoSwitch: true } }),
  };
  const read = await w.ask('accounts.get');
  assert.equal(read.ok, true, JSON.stringify(read.error));
  assert.deepEqual(read.result.harnesses, [{ harness: 'codex', autoSwitch: true, pool: 'spread' }]);
  assert.equal(read.result.accounts[0].label, 'a@x.com');
  for (const harness of ['claude', 'codex']) {
    const done = await w.ask('accounts.autoSwitch', { harness, on: false });
    assert.deepEqual(done.result, { harness, autoSwitch: false });
  }
  assert.deepEqual(set, [
    ['claude', false],
    ['codex', false],
  ]);
});
