// Automatic input guards across real Codex, Claude and ACP adapter preparation awaits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexTurns } from '../electron/harness/codexTurns.cjs';
import { ClaudeAdapter } from '../electron/harness/claude/adapter.cjs';
import { AcpTurns } from '../electron/harness/acpTurns.cjs';
import { guardInput, assertInputCurrent, carryInputGuard, inputIsGuarded } from '../electron/session/contract/inputGuard.cjs';
import { CodexConnection } from '../electron/harness/codexConnection.cjs';
import { ThreadLocked } from '../electron/harness/codexLeases.cjs';
import { AcpHost } from '../electron/harness/acp.cjs';
import { createSessions } from '../electron/harness/claude/sessions.cjs';
import { deferred } from './support/async-scenarios.ts';

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

test('every Codex preparation await rechecks the automatic owner before native turn/start', async () => {
  // the turn-diff baseline is not awaited before turn/start (#1651), so it is no preparation stage
  for (const stage of ['resume', 'release', 'defaults']) {
    const wait = deferred();
    let current = true;
    const sent: string[] = [];
    const item = { text: 'fix', opts: { human: false }, attachments: [] };
    const release = guardInput(item, () => current);
    const adapter: any = {
      ensureResumed: () => (stage === 'resume' ? wait.promise : Promise.resolve()),
      touch() {},
      nativeLifecycle: { turnEnded: () => (stage === 'release' ? wait.promise : Promise.resolve()) },
      prefs: () => ({}),
      chatConfig: () => ({}),
      meta: new Map([['native', { cwd: '/work', preview: 'existing' }]]),
      emit: () => true,
      defaults: () => (stage === 'defaults' ? wait.promise : Promise.resolve({})),
      state: { patch() {} },
      turnChanges: { begin: () => Promise.resolve(), abort() {} },
      request: async (method: string) => {
        sent.push(method);
        return { turn: { id: 'native-turn' } };
      },
    };
    const task = CodexTurns.prototype.startTurn.call(adapter, 'chat', { kind: 'codex', id: 'native' }, item);
    await flush();
    current = false;
    wait.resolve({});
    assert.equal((await task).started, false);
    assert.deepEqual(sent, []);
    release();
    assertInputCurrent(item);
  }
});

test('Claude live-control awaits cannot send a retired automatic input', async () => {
  const wait = deferred();
  let current = true;
  let sent = 0;
  const item = { text: 'fix', opts: { human: false }, attachments: [] };
  const release = guardInput(item, () => current);
  const adapter: any = Object.assign(Object.create(ClaudeAdapter.prototype), {
    clock: () => 0,
    policy: { claudeLoginFor: () => 'default' },
    accountOf: () => 'default',
    pickOf: () => null,
    marks: { get: () => undefined, snapshot: () => new Map() },
    recent: new Map(),
    settings: () => ({ model: 'new', effort: null, permission: 'default', fast: false, account: 'default', prefs: {} }),
    retiredGoalSets: new Set(),
    goalRestarts: new Map(),
    lastTurn: new Map(),
    discardStaleContinuation() {},
    state: { patch() {} },
    emit: () => true,
    served: () => undefined,
    live: new Map([['claude:native', { model: 'old', effort: null, permission: 'default', fast: false, account: 'default' }]]),
    api: {
      isLive: () => true,
      control: () => wait.promise,
      sessionCwd: () => '/work',
      accounts: () => ({ active: 'default', accounts: [] }),
    },
    sessions: new Map(),
    firstOutput: { open() {} },
    sendTo: async () => {
      sent++;
      return { elsewhere: [] };
    },
  });
  const task = adapter.beginTurn('chat', { key: 'claude:native', id: 'native' }, item);
  await flush();
  current = false;
  wait.resolve();
  assert.equal((await task).started, false);
  assert.equal(sent, 0);
  release();
});

test('ACP content preparation cannot send a retired automatic input; current and ordinary input still work', async () => {
  const wait = deferred();
  let current = true;
  let sent = 0;
  const adapter = new AcpTurns({
    send: async () => {
      sent++;
      return { turnId: 'turn' };
    },
    rename() {},
    named: () => true,
    readImage: () => wait.promise,
  });
  const item = { text: 'fix', opts: { human: false }, attachments: [{ kind: 'image', path: '/image.png' }] };
  const release = guardInput(item, () => current);
  const ref = { key: 'acp:qwen:native', id: 'native', kind: 'acp:qwen' };
  const task = adapter.startTurn('chat', ref, item);
  await flush();
  current = false;
  wait.resolve(null);
  assert.equal((await task).started, false);
  assert.equal(sent, 0);
  current = true;
  assert.equal((await adapter.startTurn('chat', ref, item)).started, true);
  release();
  current = false;
  assert.equal((await adapter.startTurn('chat', ref, item)).started, true);
  assert.equal(sent, 2);
});

test('Codex connection rechecks carried ownership after initialization and final native release, including context-copy paths', async () => {
  for (const stage of ['initialize', 'native-release']) {
    const wait = deferred();
    let current = true;
    const sent: string[] = [];
    const item = { text: 'autofix' };
    const release = guardInput(item, () => current);
    const params = carryInputGuard(item, { threadId: 'native' });
    const owner: any = {
      initialize: () => (stage === 'initialize' ? wait.promise : Promise.resolve()),
      nativeLifecycle: {
        turnEnded: () => (stage === 'native-release' ? wait.promise : Promise.resolve()),
        resetContext: () => ({ context: 'reset', turnId: 'old' }),
        contextForwarded() {},
      },
      tools: { turnContext: () => ({ key: 'tools', context: 'browser' }), contextForwarded() {} },
      call: async (method: string) => {
        sent.push(method);
        return {};
      },
    };
    const task = CodexConnection.prototype.request.call(owner, 'turn/start', params);
    await flush();
    current = false;
    wait.resolve();
    await assert.rejects(task, /paused/);
    assert.deepEqual(sent, []);
    release();
  }
});

test('ACP host session startup cannot publish a user message or prompt after its carried owner retires', async () => {
  const wait = deferred();
  let current = true;
  const events: any[] = [];
  const item = {};
  const release = guardInput(item, () => current);
  const host: any = {
    starting: new Map(),
    ensure: () => wait.promise,
    emitEvent: (e: any) => events.push(e),
    items: { append: (e: any) => events.push(e) },
  };
  const meta = { ...carryInputGuard(item, { human: false }), chatId: 'chat' };
  const task = AcpHost.prototype.send.call(host, 'acp:qwen:native', { blocks: [] }, meta);
  await flush();
  current = false;
  wait.resolve({});
  await assert.rejects(task, /paused/);
  assert.deepEqual(events, []);
  release();
});

test('Claude process startup queue rechecks ownership before busy bookkeeping and CLI input', async () => {
  const wait = deferred();
  let current = true;
  const inputs: any[] = [];
  const item = {};
  const release = guardInput(item, () => current);
  const session = {
    account: 'a',
    busy: false,
    owed: 0,
    sent: 0,
    unpersisted: true,
    seen: new Set(),
    input: { push: (m: any) => inputs.push(m) },
  };
  const state: any = { starting: new Map([['key', wait.promise]]), sessions: new Map([['key', session]]), prewarmed: new Set() };
  const sessions = createSessions(state, { auth: {}, cli: {}, catalog: {}, chrome: {} } as any);
  const task = sessions.send('key', { account: 'a' }, { role: 'user', content: 'fix' }, undefined, {
    ...carryInputGuard(item, { human: false }),
  });
  await flush();
  current = false;
  state.starting.delete('key');
  wait.resolve();
  await assert.rejects(task, /paused/);
  assert.deepEqual(inputs, []);
  assert.equal(session.busy, false);
  assert.equal(session.sent, 0);
  assert.equal(session.owed, 0);
  release();
});

test('guard propagation survives internal spreads but never enters JSON or structured-clone messages', () => {
  let current = true;
  const item = {};
  const release = guardInput(item, () => current);
  const carried = carryInputGuard(item, { uuid: 'id' });
  const twice = carryInputGuard(carried, { uuid: 'copy' });
  assert.equal(JSON.stringify(carried), '{"uuid":"id"}');
  assert.deepEqual(structuredClone(carried), { uuid: 'id' });
  assert.equal(inputIsGuarded(twice), true);
  current = false;
  assert.throws(() => assertInputCurrent({ ...twice }), /paused/);
  release();
  assert.equal(inputIsGuarded(carried), false);
  assertInputCurrent(carried);
});

test('Codex lock refusal keeps automatic recovery in the monitor and preserves ordinary held-input behavior', async () => {
  const events: any[] = [];
  const adapter: any = {
    ensureResumed: async () => {
      throw new ThreadLocked();
    },
    emit: (e: any) => {
      events.push(e);
      return true;
    },
  };
  const item = { text: 'fix', opts: {} };
  const release = guardInput(item, () => true);
  const ref = { kind: 'codex', id: 'native' };
  assert.deepEqual(await CodexTurns.prototype.startTurn.call(adapter, 'chat', ref, item), { started: false });
  assert.equal(events.length, 0);
  release();
  assert.deepEqual(await CodexTurns.prototype.startTurn.call(adapter, 'chat', ref, item), { started: false, held: true });
  assert.equal(events[0].kind, 'locked');
});
