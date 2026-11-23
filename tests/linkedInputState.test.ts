// A linked ACP session's pending form has the same input attention state as a native harness question.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatRowState } from '../src/session/chatRowState.ts';
import { EMPTY_SESSION } from '../src/store/session/sessionState.ts';

test('pending ACP forms keep input attention; terminal receipts cannot leave a false input badge', () => {
  for (const status of ['pending', 'sending', 'written', 'failed', 'retired', 'denied', 'cancelled']) {
    const state = chatRowState({
      thread: { id: 'child', cwd: '/repo', status: { type: 'idle' } } as any,
      session: { ...EMPTY_SESSION, rev: 1, questions: [{ id: 'question', status }] } as any,
      runtime: undefined,
      requests: [],
      adapterTasks: [],
      elsewhere: undefined,
      unread: false,
    });
    assert.equal(state, status === 'pending' ? 'input' : 'idle', status);
  }
});
