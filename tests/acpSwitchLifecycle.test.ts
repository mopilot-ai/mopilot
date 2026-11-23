// Real ACP host/session lifecycle and ChatController routing for in-place switches, without an app window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeSpawn, INIT } from './support/electron-acp-fake.ts';
import { deferred, tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { SwitchRunner } = require('../electron/session/switch.cjs');
const { AcpHost } = require('../electron/harness/acp.cjs');
const { AcpTurns } = require('../electron/harness/acpTurns.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { ChatController } = require('../electron/session/controller.cjs');
const { adapterSettings } = require('../electron/session/adapterSettings.cjs');
const { ChatsStore, ItemsLog } = require('../electron/platform/chats.cjs');

function setup(
  t: any,
  o: {
    load?: boolean;
    failLoad?: boolean;
    partialLoadFailure?: boolean;
    replaySettings?: boolean;
    responseSettings?: boolean;
    newSession?: () => Promise<any>;
    linked?: boolean;
    anchors?: Record<string, string>;
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-switch-lifecycle-'));
  const chats = new ChatsStore(path.join(dir, 'threads'), { legacyMirror: false });
  const items = new ItemsLog(path.join(dir, 'items'));
  const state = new SessionStore();
  const events: any[] = [];
  let sequence = 0;
  const modes = { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }] };
  const sp = fakeSpawn({
    initialize: () => INIT({ loadSession: !!o.load }),
    'session/new': async () => (o.newSession ? o.newSession() : { sessionId: `native-${++sequence}`, modes }),
    'session/load': (p, proc) => {
      if (o.failLoad && p.sessionId === 'old-native') throw new Error('Session expired');
      proc.notify('session/update', {
        sessionId: p.sessionId,
        update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'restored' }] },
      });
      if (o.partialLoadFailure) {
        proc.notify('session/update', {
          sessionId: p.sessionId,
          update: { sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', currentValue: 'retired-model' }] },
        });
        proc.notify('session/update', { sessionId: p.sessionId, update: { sessionUpdate: 'usage_update', used: 99, size: 100 } });
        throw new Error('Load failed after partial replay');
      }
      if (o.replaySettings) {
        proc.notify('session/update', {
          sessionId: p.sessionId,
          update: { sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', currentValue: 'native-choice' }] },
        });
        proc.notify('session/update', { sessionId: p.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: 'ask' } });
        return o.responseSettings ? { modes, configOptions: [{ id: 'model', currentValue: 'response-choice' }] } : {};
      }
      return { sessionId: p.sessionId, modes };
    },
    'session/prompt': () => ({ stopReason: 'end_turn' }),
    'session/set_mode': () => ({}),
  });
  let controller: any;
  const host = new AcpHost({
    items,
    ids: ['opencode', 'kimi'],
    quirks: (id: string) => ({ label: id, args: ['acp'], anchors: o.anchors ?? { ask: 'ask' } }),
    resolveBin: () => '/fake-agent',
    env: () => ({}),
    spawnFn: sp.spawnFn,
    tools: {
      prepare: async (key: string, opts: any) => {
        assert.equal(controller.chatOf(key), opts.chatId, 'tool listing sees the stable owner before session/new');
        return { mcpServers: [], serverName: 'sage_switch' };
      },
      admission: async () => true,
      end() {},
    },
  });
  const sent: any[] = [];
  const runner = new SwitchRunner({
    chats,
    acpHost: host,
    ref: (id: string) => controller.ref(id),
    claim: (key: string, id: string) => controller.claim(key, id),
    unclaim: (key: string, id: string) => controller.unclaim(key, id),
    invalidate: () => controller.invalidate(),
    changed() {},
    prefs: () => ({ permission: 'default' }),
    home: '/home/me',
    emit: (e: any) => events.push(e),
    permissionParams: () => ({}),
    git: { info: async () => null, status: async () => null },
    codex: {
      cwdOf: () => '/repo',
      ensureResumed: async () => {},
      threadTurns: async () => ({ data: [], nextCursor: null }),
      startThread: async () => ({ thread: { id: 'cx' } }),
    },
    claude: { isFresh: () => true, cwdOf: () => '/repo', registerSession() {} },
  });
  const saved = adapterSettings({ chats, orchestrator: { journal: { child: () => (o.linked ? { parentId: 'parent' } : null) } } });
  const acpTurns = new AcpTurns({
    savedSettings: saved.acpSettings,
    send: (...args: any[]) => controller.acpSend(...args),
    readImage: async () => null,
    rename() {},
    named: () => true,
    emit: (e: any) => (events.push(e), true),
    turnCheck: (id: string) => controller.turnCheck(id),
  });
  const adapter = {
    stopTurn: async () => true,
    startTurn: async (_chat: string, ref: any, item: any) => (sent.push({ ref, item }), { started: true, turnId: item.id }),
  };
  controller = new ChatController({ chats, state, switcher: runner, acp: host, acpTurns, codex: adapter, claudeTurns: adapter });
  host.on('event', (e: any) => {
    events.push(e);
    controller.onAcpEvent(e);
  });
  t.after(async () => {
    host.closeAll();
    await items.drain();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { controller, runner, chats, state, host, items, sp, events, sent };
}

const choose = (state: any, chat: string, harness: string) =>
  state.patch(chat, { pendingSwitch: { harness, model: '', modelLabel: '', mode: 'auto' } });
const message = (id: string) => ({ id, text: `message ${id}`, opts: { human: true } });

for (const explicit of [false, true]) {
  test(`session/load keeps replayed options when response fields are ${explicit ? 'explicit' : 'absent'}`, async (t) => {
    const s = setup(t, { load: true, replaySettings: true, responseSettings: explicit });
    const key = 'acp:opencode:replay-options';
    s.state.get(key);
    s.items.append(key, { t: 'session', sessionId: 'loaded-native', cwd: '/repo' });
    const chat = await s.host.ensure(key, { cwd: '/repo' });
    assert.equal(chat.state.configOptions[0].currentValue, explicit ? 'response-choice' : 'native-choice');
    assert.equal(chat.state.modes.currentModeId, 'ask');
    assert.equal(s.state.get(key).acp.configOptions[0].currentValue, explicit ? 'response-choice' : 'native-choice');
    assert.equal((await s.items.readAsync(key)).filter((r: any) => r.t === 'user').length, 0);
  });
}

for (const explicit of [false, true]) {
  test(`a failed load retires partial session state before replacement (${explicit ? 'new options' : 'optional fields absent'})`, async (t) => {
    const s = setup(t, {
      load: true,
      partialLoadFailure: true,
      newSession: async () => ({
        sessionId: 'old-native',
        ...(explicit ? { configOptions: [{ id: 'model', currentValue: 'new-model' }] } : {}),
      }),
    });
    const key = 'acp:opencode:failed-replay';
    s.state.get(key);
    s.items.append(key, { t: 'session', sessionId: 'old-native', cwd: '/repo' });
    const chat = await s.host.ensure(key, { cwd: '/repo' });
    assert.deepEqual(chat.state.configOptions, explicit ? [{ id: 'model', currentValue: 'new-model' }] : null);
    const session = s.events.findLast((e) => e.kind === 'session');
    assert.equal(session.fresh, true, 'session/new is new even if the agent reused an id');
    assert.equal(s.state.get(key).acp.commands, null);
    assert.equal(s.state.get(key).acp.usage, null);
  });
}

test('a real ACP session starts under the stable chat, gets its handoff and owns the current settings without a window', async (t) => {
  const s = setup(t);
  choose(s.state, 'chat', 'acp:opencode');
  const result = await s.controller.send('chat', message('first'), null, true);
  assert.equal(result.action, 'started');
  const ref = s.controller.ref('chat');
  assert.equal(ref.kind, 'acp:opencode');
  assert.equal(s.controller.chatOf(ref.key), 'chat');
  assert.equal(s.chats.records.size, 1);
  const prompt = s.sp.procs[0].received.find((m: any) => m.method === 'session/prompt');
  assert.match(prompt.params.prompt[0].text, /sage-handoff/);
  assert.equal(s.state.get('chat').acp.modes.currentModeId, 'ask');
  assert.equal(s.events.find((e) => e.kind === 'turnStarting').note.kind, 'switch');
});

for (const reopen of [false, true]) {
  test(`a replacement whose segment write failed still needs full context on retry (${reopen ? 'after reload' : 'while live'})`, async (t) => {
    const s = setup(t, { load: true, failLoad: true });
    const chat = 'acp:opencode:old';
    s.items.append(chat, { t: 'session', sessionId: 'old-native', cwd: '/repo' });
    s.items.append(chat, {
      t: 'user',
      at: 1,
      turnId: 'old-turn',
      user: { id: 'u', content: [{ type: 'text', text: 'original context' }] },
    });
    s.items.append(chat, { t: 'end', at: 2, turnId: 'old-turn', stopReason: 'end_turn' });
    await s.runner.perform(chat, { harness: 'claude', model: '', mode: 'auto' });
    const commit = s.chats.commit.bind(s.chats);
    s.chats.commit = () => false;
    const back = { harness: 'acp:opencode', model: '', mode: 'auto' };
    assert.equal((await s.runner.perform(chat, back)).ready, false);
    s.chats.commit = commit;
    if (reopen) {
      s.host.close(chat);
      await s.items.drain();
      s.chats.load();
      s.controller.invalidate();
    }
    const result = await s.runner.perform(chat, back);
    assert.equal(result.ready, true);
    assert.equal(s.chats.record(chat).segments.at(-1).handoff.mode, 'auto');
    assert.match(result.prefix, /original context/);
  });
}

for (const o of [{ load: true }, { load: true, failLoad: true }, { load: false }]) {
  test(`reopen through the real host: ${JSON.stringify(o)}`, async (t) => {
    const s = setup(t, o);
    const chat = 'acp:opencode:old';
    s.items.append(chat, { t: 'session', sessionId: 'old-native', cwd: '/repo' });
    s.items.append(chat, {
      t: 'user',
      at: 1,
      turnId: 'old-turn',
      user: { id: 'old-user', content: [{ type: 'text', text: 'remember original' }] },
    });
    s.items.append(chat, { t: 'end', at: 2, turnId: 'old-turn', stopReason: 'end_turn' });
    assert.equal((await s.runner.perform(chat, { harness: 'claude', model: '', modelLabel: '', mode: 'auto' })).ready, true);
    // Another ACP's settings may have been displayed before the return; none may leak into the resumed session.
    s.state.patch(chat, {
      plan: true,
      acp: { commands: [{ name: 'wrong-owner' }], usage: { used: 999 }, modes: null, configOptions: null },
    });
    const r = await s.runner.perform(chat, { harness: 'acp:opencode', model: '', modelLabel: '', mode: 'auto' });
    assert.equal(r.ready, true);
    assert.equal(s.controller.ref(chat).key, chat);
    assert.equal(s.chats.record(chat).segments.at(-1).handoff.mode, o.load && !o.failLoad ? 'delta' : 'auto');
    if (!o.load || o.failLoad) assert.match(r.prefix, /remember original/);
    assert.equal(s.state.get(chat).acp.usage, null);
    assert.equal(s.state.get(chat).plan, false);
    assert.deepEqual(s.state.get(chat).acp.commands, o.load && !o.failLoad ? [{ name: 'restored' }] : null);
  });
}

test('Stop during ACP session/new keeps input queued with prepared handoff, then a successful retry dispatches it once', async (t) => {
  const opening = deferred();
  const s = setup(t, { newSession: () => opening.promise });
  choose(s.state, 'chat', 'acp:opencode');
  const start = s.controller.send('chat', message('held'), null, true);
  while (!s.sp.procs.some((p: any) => p.received.some((m: any) => m.method === 'session/new'))) await tick();
  await s.controller.stopChat('chat');
  opening.resolve({ sessionId: 'prepared-native' });
  await start;
  assert.equal(s.sp.procs[0].received.filter((m: any) => m.method === 'session/prompt').length, 0);
  const queued = s.state.get('chat').queue;
  assert.equal(queued.length, 1);
  assert.match(queued[0].opts.prefix, /sage-handoff/);
  s.state.patch('chat', { queue: [], turn: 'idle' });
  await s.controller.send('chat', queued[0], null, true);
  assert.equal(s.sp.procs[0].received.filter((m: any) => m.method === 'session/prompt').length, 1);
});

for (const chat of ['chat', 'claude:source']) {
  test(`saved first-tier permission does not become an inherited cap when ${chat} switches to a mode-less ACP`, async (t) => {
    const s = setup(t, { newSession: async () => ({ sessionId: 'native-with-no-modes' }) });
    s.chats.patchMeta(chat, { config: { permission: 'default' } });
    choose(s.state, chat, 'acp:opencode');
    const result = await s.controller.send(chat, message('first-native'), null, true);
    assert.equal(result.action, 'started');
    assert.ok(s.sp.procs[0].received.some((m: any) => m.method === 'session/prompt'));
    assert.equal(s.chats.record(chat).meta.config.permission, 'default', 'returning first-tier settings remain saved');
  });
}

test('a linked child retains its inherited cap when switching to a fresh ACP without permission controls', async (t) => {
  const s = setup(t, { linked: true, newSession: async () => ({ sessionId: 'no-controls' }) });
  s.chats.patchMeta('child', { config: { permission: 'read-only' } });
  choose(s.state, 'child', 'acp:opencode');
  const result = await s.controller.send('child', message('bounded'), null, true);
  assert.equal(result.action, 'queued');
  assert.match(s.events.findLast((e: any) => e.kind === 'turnFailed').error, /cannot inherit the parent permission safely/);
  assert.equal(s.sp.procs[0].received.filter((m: any) => m.method === 'session/prompt').length, 0);
  assert.equal(s.state.get('child').queue[0].text, 'message bounded');
});

test('a linked child can switch to an ACP whose native permission satisfies its inherited cap', async (t) => {
  const s = setup(t, { linked: true });
  s.chats.patchMeta('child', { config: { permission: 'default' } });
  choose(s.state, 'child', 'acp:opencode');
  const result = await s.controller.send('child', message('bounded'), null, true);
  assert.equal(result.action, 'started');
  assert.ok(s.sp.procs[0].received.some((m: any) => m.method === 'session/prompt'));
});

test('a linked child reapplies its cap after switch-back replaces the prior native generation', async (t) => {
  let generation = 0;
  const s = setup(t, {
    linked: true,
    load: true,
    failLoad: true,
    anchors: { ask: 'readOnly', full: 'full' },
    newSession: async () => ({
      sessionId: ++generation === 1 ? 'old-native' : 'replacement',
      modes: {
        currentModeId: generation === 1 ? 'ask' : 'full',
        availableModes: [
          { id: 'ask', name: 'Read' },
          { id: 'full', name: 'Full' },
        ],
      },
    }),
  });
  const chat = 'acp:opencode:old';
  s.chats.patchMeta(chat, { config: { permission: 'read-only' } });
  assert.equal((await s.controller.send(chat, message('old'), null, true)).action, 'started');
  while (s.state.get(chat).turn !== 'idle') await tick();
  assert.equal(
    (await s.items.readAsync(chat)).some((r: any) => r.t === 'mode'),
    false,
    'the original native default already satisfied the cap',
  );
  await s.runner.perform(chat, { harness: 'claude', model: '', mode: 'auto' });
  s.host.close(chat);
  await s.items.drain();
  choose(s.state, chat, 'acp:opencode');
  assert.equal((await s.controller.send(chat, message('replacement'), null, true)).action, 'started');
  assert.equal(s.host.chats.get(chat).state.modes.currentModeId, 'ask');
  const changes = s.sp.procs.flatMap((p: any) => p.received).filter((m: any) => m.method === 'session/set_mode');
  assert.deepEqual(
    changes.map((m: any) => m.params),
    [{ sessionId: 'replacement', modeId: 'ask' }],
  );
  while (s.state.get(chat).turn !== 'idle') await tick();
  await s.host.setMode(chat, 'full');
  assert.equal((await s.controller.send(chat, message('user-choice'), null, true)).action, 'started');
  assert.equal(s.host.chats.get(chat).state.modes.currentModeId, 'full', 'a current-generation user choice remains authoritative');
});

test('returning to an original ACP without native input does not inherit a later first-tier permission', async (t) => {
  const s = setup(t, { newSession: async () => ({ sessionId: 'mode-less' }) });
  const chat = 'acp:opencode:empty';
  assert.equal((await s.runner.perform(chat, { harness: 'codex', model: 'model', mode: 'auto' })).ready, true);
  s.chats.patchMeta(chat, { config: { permission: 'default' } });
  choose(s.state, chat, 'acp:opencode');
  const result = await s.controller.send(chat, message('recovered'), null, true);
  assert.equal(result.action, 'started');
  assert.ok(s.sp.procs[0].received.some((m: any) => m.method === 'session/prompt'));
});
