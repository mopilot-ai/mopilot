// The phone speaks the home's intent table: every kind it can put on the wire is a key of INTENT_TABLE with the arguments the table asks for, and an intent the table has no entry for is answered on the phone and never sent.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const wirePath = '../mobile/src/momoPhone/wire';
const transportPath = '../mobile/src/momoPhone/transport';
const tablePath = '../shared/momoIntents.mjs';
const { wireOf, notYet } = await import(wirePath);
const { createRuntimeTransport, INTENT_METHOD } = await import(transportPath);
const { INTENT_TABLE, argsFit } = await import(tablePath);

const sendable = [
  { kind: 'fix', id: 'update-machine:m1' },
  { kind: 'wake' },
  { kind: 'move', toId: 'm2' },
  { kind: 'move-cancel' },
  { kind: 'move-retry' },
  { kind: 'move-stay' },
  { kind: 'reclaim' },
  { kind: 'reclaim', moveId: 'move-0001', toId: 'm2' },
  { kind: 'move-ack' },
  { kind: 'choose-home', machineId: 'm1' },
  { kind: 'update-machine', machineId: 'm1' },
  { kind: 'install-agent', agent: 'codex', machineId: 'm1' },
  { kind: 'sign-in-agent', agent: 'claude', machineId: 'm1' },
  { kind: 'send', turnId: 'turn-0001', text: 'hi' },
  { kind: 'check-turn', turnId: 'turn-0001' },
  { kind: 'stop-turn', turnId: 'turn-0001' },
  { kind: 'approval', cardId: 'c1', answer: 'send' },
  { kind: 'approval', cardId: 'c1', answer: 'edit', body: 'new' },
  { kind: 'approval', cardId: 'c1', answer: 'edit' },
  { kind: 'approval', cardId: 'c1', answer: 'deny' },
  { kind: 'approval', cardId: 'c1', answer: 'ask-again' },
  { kind: 'offer', briefDay: '2026-11-22', offerId: 'o1', action: 'start' },
  { kind: 'offer', briefDay: '2026-11-22', offerId: 'o1', action: 'hide' },
  { kind: 'rule-undo', ruleId: 'r1' },
  { kind: 'rule-set', ruleId: 'r1', on: false },
  { kind: 'task-stop', taskId: 't1' },
  { kind: 'task-stop-watching', taskId: 't1' },
  { kind: 'task-retry', taskId: 't1' },
  { kind: 'task-retry', taskId: 't1', machineId: 'm2' },
  { kind: 'note-create', title: 'a', text: 'b' },
  { kind: 'note-edit', noteId: 'n1', lineId: 'l1', text: 'x' },
  { kind: 'note-forget', noteId: 'n1', lineId: 'l1' },
  { kind: 'note-undo', noteId: 'n1', changeId: 'c1' },
  { kind: 'note-restore', noteId: 'n1' },
  { kind: 'prefs', patch: { brief: true } },
  { kind: 'notice-not-needed', noticeId: 'x1' },
  { kind: 'google', intent: 'connect' },
  { kind: 'google', intent: 'remove' },
  { kind: 'rule-set', ruleId: 'r1', on: true },
  { kind: 'task-check', taskId: 't1' },
  { kind: 'task-snooze', taskId: 't1' },
  { kind: 'notice-draft-reply', noticeId: 'x1' },
  { kind: 'notice-remind', noticeId: 'x1', at: '16:00' },
];
const local = [
  { kind: 'open-where' },
  { kind: 'open-rules' },
  { kind: 'open-settings' },
  { kind: 'pick-machine', taskId: 't1' },
  { kind: 'retry-held' },
  { kind: 'add-machine' },
  { kind: 'task-attach', taskId: 't1' },
  { kind: 'open-source', sourceId: 's1' },
];

test('every kind the phone sends is in the home table, with the arguments the table asks for', () => {
  for (const intent of sendable) {
    const wire = wireOf(intent);
    assert.ok(wire, JSON.stringify(intent));
    assert.ok(Object.hasOwn(INTENT_TABLE, wire.kind), `${wire.kind} is not in INTENT_TABLE`);
    assert.equal(argsFit(wire.kind, wire), true, JSON.stringify(wire));
  }
});

test('an intent the table has no kind for is not sent', () => {
  for (const intent of local) assert.equal(wireOf(intent), null, JSON.stringify(intent));
});

test('the table kinds carry the ids the table names', () => {
  assert.deepEqual(wireOf({ kind: 'approval', cardId: 'c1', answer: 'ask-again' }), { kind: 'approval.askAgain', id: 'c1' });
  assert.deepEqual(wireOf({ kind: 'approval', cardId: 'c1', answer: 'edit' }), { kind: 'approval.edit', id: 'c1', body: '' });
  assert.deepEqual(wireOf({ kind: 'task-retry', taskId: 't1', machineId: 'm2' }), { kind: 'task.runElsewhere', id: 't1', machineId: 'm2' });
  assert.deepEqual(wireOf({ kind: 'google', intent: 'grant-send' }), { kind: 'google', intent: 'grant-send', client: 'ios' });
  assert.deepEqual(wireOf({ kind: 'notice-not-needed', noticeId: 'x1' }), { kind: 'row.notNeeded', rowId: 'x1' });
  assert.deepEqual(wireOf({ kind: 'notice-not-needed', noticeId: 'x1', decisionId: 'd9' }), {
    kind: 'row.notNeeded',
    rowId: 'x1',
    decisionId: 'd9',
  });
});

test('snooze is an hour (the home adds it to its own clock), and a line is forgotten by its own id', () => {
  assert.deepEqual(wireOf({ kind: 'task-snooze', taskId: 't1' }), { kind: 'task.snooze', id: 't1', forMs: 3_600_000 });
  assert.deepEqual(wireOf({ kind: 'note-forget', noteId: 'n1', lineId: 'l1' }), { kind: 'note.forget', noteId: 'n1', lineId: 'l1' });
  assert.deepEqual(wireOf({ kind: 'rule-set', ruleId: 'r1', on: true }), { kind: 'rule.turnOn', id: 'r1' });
});

test('the transport sends the table kind and answers an intent it has no kind for without sending', async () => {
  const calls: [string, unknown][] = [];
  const transport = createRuntimeTransport(
    {
      async request(method: string, params: unknown) {
        calls.push([method, params]);
        return { ok: true };
      },
      onEvent: () => () => undefined,
    },
    () => 1,
  );
  assert.equal((await transport.send({ kind: 'task-stop', taskId: 't1' })).ok, true);
  assert.deepEqual(calls, [[INTENT_METHOD, { intent: { kind: 'task.stop', id: 't1' } }]]);
  assert.equal((await transport.send({ kind: 'task-stop-watching', taskId: 't1' })).ok, true);
  assert.deepEqual(calls.at(-1), [INTENT_METHOD, { intent: { kind: 'task.stopWatching', id: 't1' } }]);
  calls.length = 1;
  assert.deepEqual(await transport.send({ kind: 'task-attach', taskId: 't1' }), { ok: false, cause: notYet() });
  assert.equal(calls.length, 1);
});

test('a question answer and a result action go out under the table names', () => {
  assert.deepEqual(wireOf({ kind: 'question', id: 'ask-1', optionId: 'work' }), { kind: 'question.answer', id: 'ask-1', optionId: 'work' });
  assert.deepEqual(wireOf({ kind: 'task-act', taskId: 't1', fixId: 'review' }), { kind: 'task.act', id: 't1', fixId: 'review' });
  for (const w of [wireOf({ kind: 'question', id: 'a', optionId: 'b' }), wireOf({ kind: 'task-act', taskId: 'a', fixId: 'b' })])
    assert.equal(argsFit(w.kind, w), true);
});
