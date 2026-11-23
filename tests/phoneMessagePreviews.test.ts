// Optimistic-to-record previews remain bounded and disappear when their account/pair/chat owner changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';
const { useMessagePreviews } = await import('../mobile/src/presentation/useMessagePreviews');

test('a record keeps its local image after acknowledgment, never borrows a different id, and owner teardown clears it', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  let output: any[] = [];
  function Probe({ owner, rows, sent, queued }: any) {
    output = useMessagePreviews(owner, rows, sent, queued);
    return null;
  }
  const rows = [
    { role: 'user', text: '', clientId: 'own' },
    { role: 'user', text: '', clientId: 'another' },
  ];
  const render = async (owner: string, sent: any[] = [], queued: any[] = []) =>
    act(async () => root.render(createElement(Probe, { owner, rows, sent, queued })));
  try {
    await render('account/pair/chat', [{ nativeId: 'own', pictures: ['file:///own.jpg'] }]);
    assert.deepEqual(output[0].pictures, ['file:///own.jpg']);
    assert.equal(output[1].pictures, undefined);
    await render('account/pair/chat');
    assert.deepEqual(output[0].pictures, ['file:///own.jpg']);
    await render('another-account/pair/chat');
    assert.equal(output[0].pictures, undefined);
    await render('account/pair/chat');
    assert.equal(output[0].pictures, undefined, 'returning to a retired owner does not resurrect private preview bytes');
    await render(
      'account/pair/chat',
      [],
      Array.from({ length: 101 }, (_, i) => ({ nativeId: i === 0 ? 'own' : `next-${i}`, pictures: [`file:///${i}`] })),
    );
    assert.equal(output[0].pictures, undefined, 'the oldest of more than 100 entries is evicted');
  } finally {
    await act(async () => root.unmount());
  }
});
