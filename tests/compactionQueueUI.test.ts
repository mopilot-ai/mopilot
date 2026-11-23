// Rendered queue timing and recovery: compaction holds remain editable/removable and receipts never claim delivery.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { act, createElement as h } from 'react';
import { iconStubs, mockSource, popoverStubs, stubStore } from './support/stubs.ts';

const f: any = { queue: [], calls: [], result: { status: 'sent' } };
mockSource('src/components/pages/settings/Connections.tsx', {
  openSshTerminal: () => {
    throw new Error('The queue renderer must not open a terminal.');
  },
});
mockSource('src/store/session/useSession.ts', {
  useSession: () => ({ queue: f.queue }),
  useSessionField: (id: any, pick: any) => pick(((() => ({ queue: f.queue })) as (id: any) => any)(id)),
});
stubStore({
  sendQueuedNow: async (...args: any[]) => {
    f.calls.push(['send', ...args]);
    if (f.error) throw f.error;
    return f.result;
  },
  removeQueued: async (...args: any[]) => {
    f.calls.push(['remove', ...args]);
    return true;
  },
  toast: (...args: any[]) => f.calls.push(['toast', ...args]),
  useStore: (sel: (s: any) => unknown) => sel({ authoredInputs: {} }),
});
mockSource('src/session/clipboard.ts', { copyText: (...args: any[]) => f.calls.push(['copy', ...args]) });
mockSource('src/components/ui/Popover.tsx', popoverStubs());
mockSource('src/components/ui/icons.tsx', iconStubs());
const { createRoot } = await import('react-dom/client');
const { QueuedList } = await import('../src/components/composer/QueuedList.tsx');
let root: ReturnType<typeof createRoot> | null = null;
let el: HTMLElement;
async function render(waitingFor?: string) {
  f.calls = [];
  f.error = null;
  f.queue = [
    {
      id: 'held',
      text: 'keep full text',
      attachments: [{ name: 'image.png', path: '/image.png' }],
      opts: { effort: 'high' },
      ...(waitingFor ? { waitingFor } : {}),
    },
  ];
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(h(QueuedList, { threadId: 'stable', onEdit: (q: any) => f.calls.push(['edit', q]) })));
}
const click = async (label: string) =>
  act(async () => {
    const b = [...el.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label || b.textContent === label)!;
    b.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as any);
  });
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  el?.remove();
});

test('the waiting row shows timing and retains full editable/removable input', async () => {
  await render('compaction');
  assert.match(el.textContent!, /Will send after compaction/);
  // the timing comes before the ellipsized message, so a long message cannot clip it away
  assert.equal(el.querySelector('.queue-text')!.firstElementChild!.textContent, 'Will send after compaction · ');
  assert.equal(el.querySelector('.queue-text')!.textContent, 'Will send after compaction · keep full text');
  assert.equal(el.querySelector('button')!.disabled, false);
  await click('Queued message actions');
  await click('Edit message');
  assert.deepEqual(f.calls.slice(0, 2), [
    ['remove', 'stable', 'held'],
    ['edit', f.queue[0]],
  ]);
  await click('Remove from queue');
  assert.deepEqual(f.calls.at(-1), ['remove', 'stable', 'held']);
});

test('retry timing is explicit and ordinary queued messages have no compaction label', async () => {
  await render('compactionRetry');
  assert.equal(el.querySelector('.queue-text')!.textContent, 'Retry when ready · keep full text');
  f.queue = [{ ...f.queue[0], waitingFor: undefined }];
  await act(async () => root!.render(h(QueuedList, { threadId: 'stable' })));
  assert.doesNotMatch(el.textContent!, /compaction|Retry/);
});

for (const [result, copy] of [
  [{ status: 'queued', waitingFor: 'compaction' }, 'Message queued. It will send after compaction finishes.'],
  [{ status: 'queued', waitingFor: 'compactionRetry' }, 'Message kept in the queue. Retry when you’re ready.'],
  [{ status: 'queued' }, 'Message moved to the front of the queue. It will send after the current turn.'],
  [{ status: 'queued', error: 'Unavailable' }, 'Message kept in queue: Unavailable.'],
  [{ status: 'missing' }, 'This message is no longer in the queue.'],
  [{ status: 'failed' }, 'Could not send queued message: The harness did not accept the message.'],
  [{ status: 'failed', error: 'Refused' }, 'Could not send queued message: Refused.'],
  [{ status: 'sent' }, null],
  [{ status: 'held' }, null],
] as const)
  test(`a ${JSON.stringify(result)} receipt shows only its honest timing`, async () => {
    await render('compaction');
    f.result = result;
    await click('Steer');
    assert.deepEqual(
      f.calls.filter((c: any[]) => c[0] === 'toast').map((c: any[]) => c[1]),
      copy ? [copy] : [],
    );
  });
