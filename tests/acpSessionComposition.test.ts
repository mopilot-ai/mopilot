// ACP questions and native compaction keep independent main ownership through shared session snapshots and patches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EMPTY_SESSION, applySessionPatch, takeSnapshot, type SessionPatch, type SessionState } from '../src/store/session/sessionState.ts';
import type { AcpQuestion } from '../shared/acpForm.mjs';

const require = createRequire(import.meta.url);
const { SessionStore } = require('../electron/session/state.cjs');

test('questions and compaction retain separate main ownership across default, patch, and snapshot paths', () => {
  const patches: SessionPatch[] = [];
  const state = new SessionStore({ publish: (patch: SessionPatch) => patches.push(patch) });
  const question: AcpQuestion = {
    id: 'question-owner',
    kind: 'question',
    status: 'pending',
    harness: 'Fake',
    message: 'Choose',
    toolCallId: null,
    form: { fields: [] },
  };
  assert.deepEqual(state.snapshot('chat'), EMPTY_SESSION);
  assert.equal(state.clientPatch('chat', { questions: [question], compaction: 'active' }), false);
  assert.deepEqual(state.snapshot('chat'), EMPTY_SESSION);

  state.patch('chat', { questions: [question] });
  const older = state.snapshot('chat');
  state.patch('chat', { compaction: 'active' });
  state.patch('chat', { questions: [{ ...question, status: 'cancelled' }] });
  const snapshot: SessionState = state.snapshot('chat');
  assert.equal(snapshot.compaction, 'active');
  assert.equal(snapshot.questions[0].status, 'cancelled');
  assert.equal(snapshot.turn, 'idle');
  assert.deepEqual(snapshot.approvals, []);

  let rendered: SessionState = EMPTY_SESSION;
  for (const patch of patches) {
    const next = applySessionPatch(rendered, patch);
    assert.ok(next && next !== 'gap');
    rendered = next;
  }
  assert.deepEqual(rendered, snapshot);
  assert.equal(takeSnapshot(rendered, older), rendered);
  assert.deepEqual(takeSnapshot(undefined, snapshot), rendered);
  assert.equal(state.clientPatch('chat', { questions: [], compaction: null }), false);
  assert.deepEqual(state.snapshot('chat'), snapshot);
});
