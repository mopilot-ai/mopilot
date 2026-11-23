// A title-only offer remains one proposal while its brief is written; the final fill does not create a second card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionToolCall, turnProposals } from '../src/lib/sessionToolCall.ts';

const item = (status: string, extra: object = {}) => ({
  type: 'mcpToolCall',
  server: 'sage_test',
  tool: 'start_session',
  status: 'completed',
  result: { content: [{ type: 'text', text: JSON.stringify({ status, task_id: 'offer', chat_id: 'reserved', title: 'Task', ...extra }) }] },
});
test('briefing and its final proposal result keep one proposal id across all accepted states', () => {
  const offer = item('briefing');
  assert.deepEqual(sessionToolCall(offer), { kind: 'proposed', taskId: 'offer', title: 'Task', offer: true });
  for (const status of ['started', 'queued', 'waiting', 'held']) {
    const filled = item(status);
    assert.deepEqual(turnProposals([offer, filled]), [{ kind: 'proposed', taskId: 'offer', title: 'Task', offer: true }]);
    assert.equal(sessionToolCall(filled)?.kind, 'proposed');
  }
  assert.equal(sessionToolCall(item('briefing', { task_id: null })), null);
});
