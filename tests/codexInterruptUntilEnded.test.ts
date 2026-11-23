// An interrupt the app-server accepts but does not act on (a live Host trace: Stop 18 ms after the turn began, the model started streaming 2.2 s later and the turn ran to its end, `stopped: true` had been answered) is repeated while the turn is still the chat's running one (CodexAdapter.interruptTurn, electron/harness/codexConnection.cjs). The app-server here is a fake that becomes interruptible only after a delay, as the real one does: before that it answers a turn/interrupt with success and does nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useFakeClock as fakeClockFor } from './support/ports/clock.ts';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { CodexAdapter } = require('../electron/harness/codex.cjs');
const { SessionStore } = require('../electron/session/state.cjs');

const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};

/** A Codex adapter on a plain (not native) thread whose app-server honours a turn/interrupt only `interruptibleAfter` ms after the turn began; `onInterrupt` hears each one. */
function setup(
  t: any,
  o: { interruptibleAfter?: number; failEvery?: boolean; failRepeats?: boolean; refuseBefore?: number; native?: boolean } = {},
) {
  const clock = fakeClockFor(t, 1000);
  const state = new SessionStore();
  const interrupts: { at: number; honoured: boolean }[] = [];
  const logs: string[] = [];
  const emitted: any[] = [];
  const began = clock.now();
  const server: any = {
    listeners: new Set<(e: any) => void>(),
    proc: {},
    start() {},
    send(m: any) {
      if (m.id == null || !m.method) return;
      setImmediate(() => {
        if (m.method === 'turn/interrupt') {
          const honoured = clock.now() - began >= (o.interruptibleAfter ?? 0);
          interrupts.push({ at: clock.now() - began, honoured });
          // the real app-server's refusal of an interrupt for a turn whose run has not begun
          if (
            o.failEvery ||
            (o.failRepeats && interrupts.length > 1) ||
            (o.refuseBefore && !honoured && clock.now() - began < o.refuseBefore)
          )
            return server.emit({
              kind: 'message',
              msg: { id: m.id, error: { code: -32600, message: o.refuseBefore ? 'no active turn to interrupt' : 'no such turn' } },
            });
          // an interruptible turn ends: its chat is idle
          if (honoured) state.patch('plain', { turn: 'idle', activeTurn: null });
        }
        server.emit({ kind: 'message', msg: { id: m.id, result: {} } });
      });
    },
    emit(e: any) {
      for (const l of server.listeners) l(e);
    },
  };
  const adapter = new CodexAdapter({
    server,
    state,
    nativeOf: (chat: string) => ({ kind: 'codex', id: chat, key: chat }),
    chatOf: (nid: string) => nid,
    prefs: () => ({ model: null, effort: null, permission: 'default', serviceTier: null }),
    emit: (e: any) => (emitted.push(e), true),
    tools: { outgoing: (m: any) => m, observe() {}, exited() {}, setUserServers() {}, isNativeThread: () => Boolean(o.native) },
    probe: null,
    stopLog: (line: string) => logs.push(line),
    now: () => clock.now(),
  });
  state.patch('plain', { turn: 'running', activeTurn: { id: 'T1', human: true } });
  return { adapter, state, clock, interrupts, logs, emitted };
}

test('an interrupt the app-server ignores is repeated until the turn ends, and then no more are sent', async (t) => {
  const { adapter, state, clock, interrupts, logs } = setup(t, { interruptibleAfter: 1500 });
  assert.equal(await adapter.stopTurn('plain'), true);
  await settle();
  assert.deepEqual(interrupts, [{ at: 0, honoured: false }]);
  assert.equal(state.get('plain').turn, 'running');
  for (let i = 0; i < 4; i++) {
    clock.advance(500);
    await settle();
  }
  // the repeats at 500, 1000 and 1500 ms: the third one was acted on, the turn ended, and nothing was sent after it
  assert.deepEqual(
    interrupts.map((x) => [x.at, x.honoured]),
    [
      [0, false],
      [500, false],
      [1000, false],
      [1500, true],
    ],
  );
  assert.equal(state.get('plain').turn, 'idle');
  assert.equal(clock.pending, 0);
  // the log tells each step by chat, thread and turn, and the end
  assert.match(logs[0], /^\[codex-stop\] chat=plain thread=plain turn=T1$/);
  assert.ok(logs.includes('[codex-stop] chat=plain thread=plain turn=T1 interrupt sent'));
  assert.ok(logs.includes('[codex-stop] chat=plain thread=plain turn=T1 interrupt answered by the app-server'));
  assert.ok(logs.includes('[codex-stop] chat=plain thread=plain turn=T1 repeat 3 answered'));
  assert.match(logs.at(-1)!, /is no longer the running turn \(ended or replaced\) after 3 repeat\(s\)$/);
});

test('a turn that ended on its own is not interrupted again, and one replaced by the next turn is left alone', async (t) => {
  const { adapter, state, clock, interrupts } = setup(t, { interruptibleAfter: 10_000 });
  await adapter.stopTurn('plain');
  await settle();
  state.patch('plain', { turn: 'running', activeTurn: { id: 'T2', human: true } });
  clock.advance(500);
  await settle();
  assert.equal(interrupts.length, 1);
  state.patch('plain', { turn: 'idle', activeTurn: null });
  clock.advance(2000);
  await settle();
  assert.equal(interrupts.length, 1);
});

test('an interrupt the app-server refuses is carried on by repeats, and a Stop that is never carried out is said', async (t) => {
  const { adapter, clock, interrupts, logs, emitted } = setup(t, { interruptibleAfter: 0, failEvery: true });
  await assert.rejects(() => adapter.request('turn/interrupt', { threadId: 'plain', turnId: 'T1' }), /no such turn/);
  assert.ok(logs.some((l) => / interrupt refused: no such turn$/.test(l)));
  for (let i = 0; i < 60; i++) {
    clock.advance(500);
    await settle();
  }
  assert.equal(interrupts.length, 1 + 40, 'a refused first interrupt is repeated like an ignored one');
  assert.match(logs.at(-1)!, /still running after 40 repeats: giving up \(the last answer: no such turn\)$/);
  assert.deepEqual(
    emitted.filter((e) => e.kind === 'toast').map((e) => [e.kind, e.text]),
    [['toast', "Couldn't stop the turn: no such turn"]],
  );
});

test('a Stop refused because the turn has not begun is pending, then carried out when the turn can be interrupted; a second Stop adds no second chain', async (t) => {
  const { adapter, state, clock, interrupts, emitted } = setup(t, { interruptibleAfter: 2300, refuseBefore: 2300 });
  // the real app-server refused at once ("no active turn to interrupt"): the Stop is pending, not done
  assert.equal(await adapter.stopTurn('plain'), 'pending');
  assert.equal(await adapter.stopTurn('plain'), 'pending');
  await settle();
  assert.equal(clock.pending, 1, 'one chain of repeats, whatever the number of Stops');
  for (let i = 0; i < 6; i++) {
    clock.advance(500);
    await settle();
  }
  assert.equal(state.get('plain').turn, 'idle');
  assert.ok(interrupts.at(-1)!.honoured);
  assert.deepEqual(
    emitted.filter((e) => e.kind === 'toast'),
    [],
  );
  assert.equal(clock.pending, 0);
});

test('a Stop the app-server answers is done, not pending', async (t) => {
  const { adapter } = setup(t, { interruptibleAfter: 0 });
  assert.equal(await adapter.stopTurn('plain'), true);
});

test('a Stop that never takes effect is repeated only so many times', async (t) => {
  const { adapter, clock, interrupts, logs } = setup(t, { interruptibleAfter: 10 ** 9 });
  await adapter.stopTurn('plain');
  for (let i = 0; i < 60; i++) {
    clock.advance(500);
    await settle();
  }
  assert.equal(interrupts.length, 1 + 40);
  assert.equal(clock.pending, 0);
  assert.match(logs.at(-1)!, /still running after 40 repeats: giving up$/);
});

test('a repeated interrupt the app-server refuses is noted, and the later repeats go on', async (t) => {
  const { adapter, clock, interrupts, logs } = setup(t, { interruptibleAfter: 10 ** 9, failRepeats: true });
  await adapter.stopTurn('plain');
  for (let i = 0; i < 3; i++) {
    clock.advance(500);
    await settle();
  }
  assert.equal(interrupts.length, 4);
  assert.ok(logs.some((l) => / repeat 1 refused: no such turn$/.test(l)));
});

test('a Stop with no thread for the chat, or a turn that is still only a token, says so in the log and sends nothing', async (t) => {
  const { adapter, state, interrupts, logs } = setup(t);
  state.patch('plain', { activeTurn: { id: 'pending-m1', human: true } });
  assert.equal(await adapter.stopTurn('plain'), true);
  assert.match(logs[0], /^\[codex-stop\] chat=plain thread=plain turn=pending-m1 \(a token: no interrupt can be sent yet\)$/);
  assert.deepEqual(interrupts, []);
  adapter.codexThread = () => null;
  assert.equal(await adapter.stopTurn('plain'), false);
  assert.match(logs.at(-1)!, /^\[codex-stop\] chat=plain no Codex thread is known for it: nothing to interrupt$/);
});

test('a Stop that is honoured by the last repeat ends the chain without a give-up toast', async (t) => {
  const { adapter, state, clock, interrupts, emitted, logs } = setup(t, { interruptibleAfter: 20_000 });
  await adapter.stopTurn('plain');
  for (let i = 0; i < 41; i++) {
    clock.advance(500);
    await settle();
  }
  assert.equal(state.get('plain').turn, 'idle');
  assert.equal(interrupts.length, 41);
  assert.deepEqual(
    emitted.filter((e) => e.kind === 'toast'),
    [],
  );
  assert.ok(!logs.some((l) => /giving up/.test(l)));
  assert.equal(clock.pending, 0);
});

test('on a native thread a refused Stop is shown at once and is not repeated', async (t) => {
  const { adapter, clock, interrupts, emitted } = setup(t, { failEvery: true, native: true });
  assert.equal(await adapter.stopTurn('plain'), true);
  assert.deepEqual(
    emitted.filter((e) => e.kind === 'toast').map((e) => e.text),
    ["Couldn't stop: no such turn"],
  );
  clock.advance(60_000);
  await settle();
  assert.equal(interrupts.length, 1);
});
