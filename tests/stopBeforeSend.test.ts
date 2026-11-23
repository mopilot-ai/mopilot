// A Stop pressed after a send began and before its harness received the prompt cancels that send
// (ChatController.stopGuard): the real Claude adapter (electron/harness/claude/adapter.cjs) applying a model change to its live
// CLI or starting one, a Claude steer, an ACP prompt and a Codex turn, steer or goal, all wired to the ChatController.
// A Stop before the send began never blocks it, and the stopped message waits first in line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, tick } from './support/controller/fixture';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { ClaudeAdapter } = require('../electron/harness/claude/adapter.cjs');
const { AcpTurns } = require('../electron/harness/acpTurns.cjs');
const { CodexTurns } = require('../electron/harness/codexTurns.cjs');
const { CodexLeases } = require('../electron/harness/codexLeases.cjs');
const {
  assertInputCurrent,
  carryInputGuard,
  guardInput,
  guardSend,
  inputIsGuarded,
} = require('../electron/session/contract/inputGuard.cjs');
const { queueItem } = require('../electron/session/queueItem.cjs');

const STOPPED = 'Stopped before this message was sent';

/** A promise the test settles. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Wait until `ready` holds, failing after a bounded number of event-loop turns instead of hanging. */
async function until(ready: () => boolean, what: string) {
  await waitFor(ready, what);
  assert.ok(ready(), `timed out waiting for ${what}`);
}

/** The controller with a real Claude adapter whose live CLI takes control requests that settle when the test says. */
function claudeChat(chat: string) {
  const fx = setup();
  const events: any[] = [];
  const controls: [string, string][] = [];
  const held: (() => void)[] = [];
  const api: any = {
    isLive: () => true,
    control: (_key: string, method: string) => {
      controls.push([_key, method]);
      return method === 'interrupt' ? Promise.resolve() : new Promise<void>((resolve) => held.push(resolve));
    },
    sessionCwd: () => '/w',
    accounts: () => ({ active: 'default', accounts: [{ id: 'default', loggedIn: true }] }),
    metered: () => false,
  };
  const recorded: string[] = [];
  fx.c.onStopped = (chatId: string) => void recorded.push(chatId);
  const adapter = new ClaudeAdapter({
    api,
    state: fx.state,
    prefs: () => ({ permission: 'default' }),
    send: (chatId: string, key: string, opts: any, input: any, priority: any, meta: any) =>
      fx.c.claudeSend(chatId, key, opts, input, priority, meta),
    enqueue: () => undefined,
    interrupted: (key: string) => fx.c.onClaudeControl(key, 'interrupt'),
    chatOf: (key: string) => fx.c.chatOf(key),
    ref: (chatId: string) => fx.c.ref(chatId),
    emit: (e: any) => (events.push(e), true),
    setGoal: () => false,
  });
  fx.c.claudeTurns = adapter;
  // the CLI runs with another model than the chat now wants: the turn first changes it in place (setModel)
  adapter.live.set(chat, { ...adapter.settings(chat, {}), model: 'older-model' });
  const releaseControls = async () => {
    await until(() => held.length > 0, 'a held control request');
    for (const release of held.splice(0)) release();
  };
  return { ...fx, adapter, events, controls, recorded, releaseControls };
}

test('Claude: a Stop while the turn changes the live CLI settings sends nothing, and the message waits first in line', async () => {
  const chat = 'claude:stop1';
  const { c, s, claudeSends, events, controls, recorded, releaseControls } = claudeChat(chat);
  c.send(chat, { id: 'm1', text: 'hello', opts: { human: true } }, 1);
  c.send(chat, { id: 'm2', text: 'queued after' }, 1);
  await until(() => controls.length > 0, 'the setModel control');
  assert.deepEqual(controls, [[chat, 'setModel']]);
  assert.equal(await c.stopChat(chat), true);
  assert.deepEqual(controls.at(-1), [chat, 'interrupt']);
  await releaseControls();
  await until(() => claudeSends.length > 0 || s(chat).turn === 'idle', 'the send to settle');
  assert.deepEqual(claudeSends, []);
  assert.equal(events.at(-1).kind, 'turnFailed');
  assert.equal(events.at(-1).error, 'Stopped before this message was sent');
  assert.deepEqual(
    s(chat).queue.map((q: any) => q.id),
    ['m1', 'm2'],
  );
  // the turn's end still reads as a stop: the queue doesn't drain, and the stop is recorded
  assert.deepEqual(recorded, [chat, chat]);

  // sent again with no Stop, it goes (the guard went with the stopped attempt)
  c.sendNow(chat, 'm1', 1);
  await releaseControls();
  await until(() => claudeSends.length > 0, 'the retried send');
  assert.equal((claudeSends as any[])[0][2].content, 'hello');
});

test('Claude: a Stop before the send began never blocks it; one while its CLI starts does', async () => {
  const chat = 'claude:stop2';
  const { c, s, adapter, claudeSends } = claudeChat(chat);
  // the CLI runs with the settings the chat wants: no control step
  adapter.live.set(chat, adapter.settings(chat, {}));
  // electron/harness/claude/sessions.cjs send: it waits while a CLI starts, then checks the input right before the prompt
  let starting = gate();
  c.claude = {
    send: async (...a: any[]) => {
      await starting.promise;
      assertInputCurrent(a[4]);
      claudeSends.push(a);
      return { elsewhere: [] };
    },
  };
  c.onClaudeControl(chat, 'interrupt');
  c.send(chat, { id: 'm1', text: 'after an old stop' }, 1);
  starting.open();
  await until(() => claudeSends.length > 0, 'the send after an earlier stop');

  // the turn ends; the next one stops while its CLI starts
  c.onClaudeEvent({ key: chat, kind: 'message', msg: { type: 'result', subtype: 'success' } });
  starting = gate();
  c.send(chat, { id: 'm2', text: 'stopped while starting' }, 1);
  await tick();
  await c.stopChat(chat);
  starting.open();
  await until(() => s(chat).turn === 'idle', 'the stopped turn to end');
  assert.equal(claudeSends.length, 1);
  assert.deepEqual(
    s(chat).queue.map((q: any) => q.id),
    ['m2'],
  );
});

test('Claude: a Stop while a steer waits to be dispatched keeps the steer out and first in line', async () => {
  const chat = 'claude:stop3';
  const { c, s, adapter, claudeSends, events } = claudeChat(chat);
  adapter.live.set(chat, adapter.settings(chat, {}));
  c.send(chat, { id: 'turn', text: 'go' }, 1);
  await until(() => claudeSends.length === 1, 'the turn');
  adapter.live.set(chat, adapter.settings(chat, {}));
  const before = gate();
  c.beforeDispatch = () => before.promise;
  assert.equal(c.send(chat, { id: 'steer', text: 'also', followUp: 'steer' }, 1).action, 'steered');
  await tick();
  await c.stopChat(chat);
  before.open();
  await until(() => s(chat).queue.length > 0, 'the steer to go back to the queue');
  assert.equal(claudeSends.length, 1);
  assert.equal(events.at(-1).kind, 'steerFailed');
  assert.deepEqual(
    s(chat).queue.map((q: any) => q.id),
    ['steer'],
  );
});

test('Claude: a Stop while a switch settles or a goal command goes to the new harness reaches the copy the adapter gets', async () => {
  for (const kind of ['switch', 'goal'] as const) {
    const { c, state, s, execs } = setup({ auto: false });
    const chat = `claude:${kind}`;
    const seen: any[] = [];
    const held = gate();
    c.claudeTurns.startTurn = async (_chatId: string, _ref: any, item: any) => {
      seen.push(item);
      await held.promise;
      assertInputCurrent(item);
      return { started: true };
    };
    if (kind === 'switch') state.patch(chat, { pendingSwitch: { harness: 'claude' } });
    const item = kind === 'goal' ? { id: 'm1', text: 'ship', opts: { goal: 'ship it' } } : { id: 'm1', text: 'hi' };
    const started = c.start(chat, queueItem(item, 1));
    if (kind === 'switch') {
      await until(() => execs.length > 0, 'the handoff');
      execs[0].done({ ready: true, prefix: '<handoff>' });
    }
    await until(() => seen.length > 0, 'the adapter');
    // the adapter got a copy: the prepared handoff, or the goal as a command
    assert.equal(seen[0].text, kind === 'goal' ? '/goal ship it' : 'hi');
    if (kind === 'switch') assert.equal(seen[0].opts.prefix, '<handoff>');
    c.onClaudeControl(chat, 'interrupt');
    held.open();
    const res = await started;
    assert.equal(res.started, false);
    assert.equal(res.error, STOPPED);
    assert.equal(s(chat).turn, 'idle');
  }
});

test('ACP: a Stop before the prompt is prepared (a delivery check) means it is not sent', async () => {
  const { c, s, acpSends, acpCancels } = setup();
  const events: any[] = [];
  c.acpTurns = new AcpTurns({
    send: (chatId: string, key: string, payload: any, meta: any) => c.acpSend(chatId, key, payload, meta),
    rename: () => undefined,
    emit: (e: any) => (events.push(e), true),
    turnCheck: (chatId: string) => c.turnCheck(chatId),
  });
  const chat = 'acp:kimi:stop';
  const before = gate();
  c.beforeDispatch = () => before.promise;
  c.send(chat, { id: 'm1', text: 'hello' }, 1);
  await tick();
  assert.equal(await c.stopChat(chat), true);
  assert.deepEqual(acpCancels, [chat]);
  before.open();
  await until(() => s(chat).turn === 'idle', 'the stopped turn to end');
  assert.deepEqual(acpSends, []);
  assert.equal(events.at(-1).kind, 'turnFailed');
  assert.equal(events.at(-1).error, STOPPED);
  assert.deepEqual(
    s(chat).queue.map((q: any) => q.id),
    ['m1'],
  );
});

/** The Codex turn start (electron/harness/codexTurns.cjs) with its awaits held, and turn/start checked as the connection does. */
function codexAdapter(resume: Promise<unknown>) {
  const requests: [string, any][] = [];
  const adapter: any = {
    ensureResumed: () => resume,
    touch() {},
    nativeLifecycle: { turnEnded: () => Promise.resolve() },
    prefs: () => ({}),
    chatConfig: () => ({}),
    meta: new Map(),
    emit: () => true,
    defaults: () => Promise.resolve({}),
    // a goal applies the chat's permission first (electron/harness/codexRunPermission.cjs)
    applyPermission: CodexLeases.prototype.applyPermission,
    permissionKeys: new Map(),
    permissionCaughtUp() {},
    state: { patch() {}, get: () => ({ activeTurn: { id: 'running' } }) },
    noteGoal() {},
    autoTitle: async () => undefined,
    request: async (method: string, params: any) => {
      // electron/harness/codexConnection.cjs request: the carried guard is checked right before the call
      assertInputCurrent(params ?? {});
      requests.push([method, params]);
      return method === 'turn/start' ? { turn: { id: 'native-turn' } } : { goal: { status: 'active' } };
    },
  };
  return { adapter, requests };
}

test('Codex: a Stop while a turn is still starting means turn/start is not sent', async () => {
  const { c, s } = setup();
  const resume = gate();
  const { adapter, requests } = codexAdapter(resume.promise);
  c.codex = {
    startTurn: (...a: any[]) => CodexTurns.prototype.startTurn.apply(adapter, a),
    stopTurn: async () => true,
  };
  c.send('cx1', { id: 'm1', text: 'hello' }, 1);
  await tick();
  assert.equal(await c.stopChat('cx1'), true);
  resume.open();
  await until(() => s('cx1').turn === 'idle', 'the stopped turn to end');
  assert.deepEqual(requests, []);
  assert.deepEqual(
    s('cx1').queue.map((q: any) => q.id),
    ['m1'],
  );
});

test("Codex: a stopped steer or goal never reaches the app-server; one that wasn't stopped does", async () => {
  const { c } = setup();
  const { adapter, requests } = codexAdapter(Promise.resolve());
  const ref = { kind: 'codex', id: 'cx2', key: 'cx2' };
  for (const stopped of [true, false]) {
    const steer = queueItem({ text: 'also' }, 1);
    const goal = queueItem({ text: 'g', opts: { goal: 'ship it' } }, 1);
    const releases = [c.stopGuard('cx2', steer), c.stopGuard('cx2', goal)];
    if (stopped) c.noteStop('cx2');
    const steered = await CodexTurns.prototype.steer.call(adapter, 'cx2', ref, steer);
    const goalSet = await CodexTurns.prototype.startGoal.call(adapter, 'cx2', ref, goal);
    for (const release of releases) release();
    assert.equal(steered.started, !stopped);
    assert.equal(goalSet.started, !stopped);
    if (stopped) assert.equal(steered.error, STOPPED);
  }
  // a stopped goal sends nothing, its permission update included
  assert.deepEqual(
    requests.map(([method]) => method),
    ['turn/steer', 'thread/settings/update', 'thread/goal/set'],
  );
});

test('send checks: several per item, each released on its own, carried to copies, and never an automatic owner', () => {
  const item: any = { text: 'hi' };
  const bare = carryInputGuard(item, {});
  assert.equal(Object.getOwnPropertySymbols(bare).length, 0);
  let stopped = false;
  const first = guardSend(item, () => {
    if (stopped) throw new Error('first');
  });
  // a copy carries the guard; a check attached through the copy belongs to the original
  const copy = carryInputGuard(item, { ...item, text: 'copy' });
  const second = guardSend(copy, () => {
    throw new Error('second');
  });
  assert.equal(inputIsGuarded(item), false);
  assert.throws(() => assertInputCurrent(copy), /second/);
  second();
  assertInputCurrent(copy);
  stopped = true;
  assert.throws(() => assertInputCurrent(item), /first/);
  // releasing twice is harmless, and an owner guard added meanwhile stays
  const owner = guardInput(item, () => true);
  first();
  first();
  assertInputCurrent(copy);
  assert.equal(inputIsGuarded(copy), true);
  owner();
  assert.equal(Object.getOwnPropertySymbols(carryInputGuard(item, {})).length, 0);
  // a set emptied and replaced: the old release leaves the new one alone
  const again = guardSend(item, () => {
    throw new Error('again');
  });
  first();
  assert.throws(() => assertInputCurrent(item), /again/);
  again();
});
