// The goal gates read main's own record of a chat's goal (SessionStore goalStatus, electron/session/goalStatus.cjs): the Codex adapter's, else the session state's (#2759).
import { test, assert, setup, thread } from './support/codex-adapter/fixture.ts';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chatGoalStatus, goalHolds } = require('../electron/session/goalStatus.cjs');
const { createPeerGate } = require('../electron/session/peerGate.cjs');
const { SessionStore } = require('../electron/session/state.cjs');

test("the adapter's record wins over the state's goal, a cleared one included; without one the state's goal is read, an unread status counting as active", () => {
  assert.equal(chatGoalStatus('paused', { status: 'active' }), 'paused');
  assert.equal(chatGoalStatus(null, { status: 'active' }), null);
  assert.equal(chatGoalStatus(undefined, { status: 'budgetLimited' }), 'budgetLimited');
  assert.equal(chatGoalStatus(undefined, {}), 'active');
  assert.equal(chatGoalStatus(undefined, null), null);
  assert.deepEqual(['active', 'paused', 'budgetLimited', 'complete', null].map(goalHolds), [true, true, true, false, false]);
});

test("the session store answers from the adapter's record first, and from its own goal for a chat no adapter keeps one for", () => {
  const own: Record<string, string | null | undefined> = { codex: 'active', cleared: null };
  const store = new SessionStore({ ownGoal: (id: string) => own[id] });
  store.patch('codex', { goal: { objective: 'x', status: 'complete' } });
  store.patch('cleared', { goal: { objective: 'x', status: 'paused' } });
  store.patch('claude', { goal: { objective: 'x', status: 'usageLimited' } });
  assert.equal(store.goalStatus('codex'), 'active');
  assert.equal(store.goalStatus('cleared'), null);
  assert.equal(store.goalStatus('claude'), 'usageLimited');
  assert.equal(store.goalStatus('unknown'), null);
  assert.equal(new SessionStore().goalStatus('claude'), null);
});

test("Codex's own goal status is its record of the chat's current thread: null once cleared, undefined without a record or a Codex thread", () => {
  const f = setup({}, { segments: { chat1: 'seg2' } });
  f.a.hold('seg2', thread('seg2'));
  assert.equal(f.a.ownGoalStatus('chat1'), undefined);
  f.a.noteGoal('seg2', { status: 'paused' });
  assert.equal(f.a.ownGoalStatus('chat1'), 'paused');
  f.a.noteGoal('seg2', null);
  assert.equal(f.a.ownGoalStatus('chat1'), null);
  // a chat on another harness, or none: no record, and no throw
  f.a.nativeOf = () => ({ kind: 'claude', id: 'x', key: 'claude:x' });
  assert.equal(f.a.ownGoalStatus('claude:x'), undefined);
  f.a.nativeOf = () => null;
  assert.equal(f.a.ownGoalStatus('gone'), undefined);
});

test('a peer message waits for a paused Codex goal that no window reported, and goes to one a stale report still calls paused (#2759)', async () => {
  const own: Record<string, string | null | undefined> = {};
  const store = new SessionStore({ ownGoal: (id: string) => own[id] });
  const gate = createPeerGate({
    record: () => ({ id: 'B', meta: { archived: null } }),
    state: (id: string) => store.get(id),
    goalStatus: (id: string) => store.goalStatus(id),
    ref: () => ({ kind: 'codex' }),
    availability: () => null,
  });
  own.B = 'paused';
  assert.equal(await gate('B'), 'target_goal_paused');
  own.B = 'budgetLimited';
  assert.equal(await gate('B'), 'target_goal_paused');
  store.patch('B', { goal: { objective: 'x', status: 'paused' } });
  own.B = 'active';
  assert.equal(await gate('B'), null);
  own.B = null;
  assert.equal(await gate('B'), null, 'a goal the adapter saw cleared is not paused, whatever the window last reported');
  // a chat no adapter keeps a record for (Claude: main writes the state's goal) is read from the state
  own.B = undefined;
  assert.equal(await gate('B'), 'target_goal_paused');
});
