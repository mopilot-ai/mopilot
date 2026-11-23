// A queued compaction is removable while busy and explicitly retryable when the chat becomes idle.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mockSource, stubStore } from './support/stubs.ts';
import { render, one } from './support/shell-panels-kit.ts';
import { createElement as h, act } from 'react';

let turn = 'running';
const queue = [{ id: 'compact', text: '/compact', attachments: [], opts: { compact: { args: '' } }, origin: null, queuedAt: 0 }];
const calls: unknown[][] = [];
mockSource('src/components/pages/settings/Connections.tsx', {
  openSshTerminal: () => {
    throw new Error('The compaction queue must not open a terminal.');
  },
});
mock.module('../src/store/session/useSession.ts', {
  namedExports: { useSessionField: (_id: string, pick: any) => pick({ queue, turn }) },
});
stubStore({
  removeQueued: async (id: string, qid: string) => (calls.push(['remove', id, qid]), true),
  sendQueuedNow: async (id: string, qid: string) => (calls.push(['send', id, qid]), { status: 'sent' }),
  toast: () => {},
  useStore: (pick: any) => pick({ authoredInputs: {} }),
});
const { QueuedList } = await import('../src/components/composer/QueuedList.tsx');

test('a busy queued compaction cannot be steered and can be removed', async (t) => {
  turn = 'running';
  calls.length = 0;
  const r = await render(h(QueuedList, { threadId: 'chat' }));
  t.after(() => r.unmount());
  const action = one(r.host, '.queue-steer') as HTMLButtonElement;
  assert.equal(action.textContent, 'After turn');
  assert.equal(action.disabled, true);
  await act(() => action.click());
  assert.deepEqual(calls, []);
  await act(() => one(r.host, '[aria-label="Remove from queue"]').click());
  assert.deepEqual(calls, [['remove', 'chat', 'compact']]);
});

test('an idle queued compaction can be retried explicitly', async (t) => {
  turn = 'idle';
  calls.length = 0;
  const r = await render(h(QueuedList, { threadId: 'chat' }));
  t.after(() => r.unmount());
  const action = one(r.host, '.queue-steer') as HTMLButtonElement;
  assert.equal(action.disabled, false);
  assert.equal(action.textContent, 'Send');
  await act(() => action.click());
  assert.deepEqual(calls, [['send', 'chat', 'compact']]);
});
