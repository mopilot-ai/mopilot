// Optional canonical-identity polling coalesces pending reads and leaves other navigation callers one-shot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, act } from 'react';
import { fx, reset, render } from './support/shell-sidebar-kit.ts';
import { useProjectPaths } from '../src/lib/useProjectPaths.ts';
import { pollKeyCount } from '../src/lib/visiblePoll.ts';
import { controlledReads } from './support/async-scenarios.ts';

test('only opted-in callers refresh on focus, coalesce while pending, and retry a failed canonical refresh', async () => {
  reset();
  const reads = controlledReads<Record<string, string>>();
  fx.canonicalPaths = () => reads.read();
  let result!: ReturnType<typeof useProjectPaths>;
  function Probe({ ms }: { ms?: number }) {
    result = useProjectPaths(['/alias'], ms);
    return null;
  }
  const view = await render(h(Probe));
  const focus = () =>
    act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
  try {
    await act(async () => reads.requests[0].resolve({ '/alias': '/first' }));
    await focus();
    assert.equal(reads.requests.length, 1, 'ordinary callers do not acquire periodic work');
    await act(async () => view.root.render(h(Probe, { ms: 60_000 })));
    await focus();
    assert.equal(reads.requests.length, 2, 'focus coalesces with the pending refresh');
    assert.equal(result.resolve('/alias'), '/first');
    await act(async () => reads.requests[1].reject(new Error('temporary lookup failure')));
    assert.equal(result.ready, false);
    assert.equal(result.resolve('/alias'), '/first');
    await focus();
    await act(async () => reads.requests[2].resolve({ '/alias': '/restored' }));
    assert.equal(result.ready, true);
    assert.equal(result.resolve('/alias'), '/restored');
  } finally {
    await view.unmount();
  }
  assert.equal(pollKeyCount(), 0);
});
