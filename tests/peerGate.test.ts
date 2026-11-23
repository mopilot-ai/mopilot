import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createPeerGate } = require('../electron/session/peerGate.cjs');

test('shared gate retains deleted, archived, external, crashed and paused requests before contacting adapters', async () => {
  let record: any = { id: 'B', meta: { archived: null } };
  let state: any = { turn: 'idle' };
  let contacted = 0;
  const gate = createPeerGate({
    record: () => record,
    state: () => state,
    goalStatus: () => state.goal?.status ?? null,
    ref: () => ({ kind: 'receiver' }),
    availability: () => {
      contacted++;
      return null;
    },
  });
  record = null;
  assert.equal(await gate('B'), 'chat_deleted');
  record = { id: 'B', meta: { archived: 0 } };
  assert.equal(await gate('B'), 'chat_archived');
  record.meta.archived = null;
  state = { runningElsewhere: true };
  assert.equal(await gate('B'), 'running_elsewhere');
  state = { turn: 'crashed' };
  assert.equal(await gate('B'), 'harness_crashed');
  for (const status of ['paused', 'budgetLimited']) {
    state = { goal: { status } };
    assert.equal(await gate('B'), 'target_goal_paused');
  }
  assert.equal(contacted, 0);
  state = { turn: 'awaitingUser' };
  assert.equal(await gate('B'), null);
  assert.equal(contacted, 1); // Approval-waiting inputs may queue, never answer that approval.
});
test('all receiving adapter families propagate unavailability rather than silently switching accounts', async () => {
  for (const kind of ['codex', 'claude', 'acp:test']) {
    const chat = { id: 'stable-B', meta: {} };
    let status: string | null = 'login_required';
    const gate = createPeerGate({
      record: () => chat,
      state: () => ({ turn: 'idle' }),
      goalStatus: () => null,
      ref: () => ({ kind, id: 'native-B' }),
      availability: (ref: any, record: any) => {
        assert.equal(ref.kind, kind);
        assert.equal(record, chat);
        return status;
      },
    });
    assert.equal(await gate('stable-B'), 'login_required');
    // the kill switch's sentence becomes a code the windows have a line for (#1863)
    status = 'Turned off by MoPilot for now';
    assert.equal(await gate('stable-B'), 'harness_turned_off');
    status = null;
    assert.equal(await gate('stable-B'), null);
  }
});

test('a chat that runs on another machine is running elsewhere for a peer message (#4738)', async () => {
  const gate = createPeerGate({
    record: () => ({ id: 'B', meta: { archived: null } }),
    state: () => ({ turn: 'idle' }),
    goalStatus: () => null,
    ref: () => ({ kind: 'receiver' }),
    availability: () => null,
    remote: { owns: (id: string) => id === 'B' },
  });
  assert.equal(await gate('B'), 'running_elsewhere');
  assert.equal(await gate('C'), null);
});
