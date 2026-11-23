// Output completion captures before/after ordering, deduplicates evidence and contains rejected reveal operations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockStore, autoMock, resetStore, callsTo, impl, settle } from './support/thread-kit.ts';
mockStore();
autoMock('src/store/outputReveal.ts', 'reveal');
const { outputCompletion } = await import('../src/store/outputCompletion.ts');
const file: any = {
  type: 'fileChange',
  id: 'f',
  status: 'completed',
  changes: [{ path: '/repo/site.html', kind: { type: 'add' }, diff: 'new' }],
};

test('identical completed items and snapshots do not reveal, while missing turns and changed evidence are deferred until invoked', async () => {
  resetStore({ runtime: { a: { turns: [{ id: 't', diff: 'same', items: [file] }] } } });
  impl['reveal:revealSessionOutputs'] = async () => {};
  outputCompletion('a', 't', { item: file })();
  outputCompletion('a', 't', { diff: 'same' })();
  assert.equal(callsTo('reveal:revealSessionOutputs').length, 0);
  const after = outputCompletion('a', 't', { diff: 'new' });
  assert.equal(callsTo('reveal:revealSessionOutputs').length, 0);
  after();
  await settle();
  assert.deepEqual(callsTo('reveal:revealSessionOutputs').at(-1), ['a', 't', undefined]);
  outputCompletion('missing', 'missing', { item: file })();
  await settle();
  assert.equal(callsTo('reveal:revealSessionOutputs').at(-1)?.[2]?.[0].path, '/repo/site.html');
});

test('a rejected reveal is contained and does not poison the next completion', async () => {
  resetStore({ runtime: {} });
  impl['reveal:revealSessionOutputs'] = async () => {
    throw Error('Preview unavailable');
  };
  outputCompletion('a', 't', { diff: 'new' })();
  await settle();
  impl['reveal:revealSessionOutputs'] = async () => {};
  outputCompletion('a', 't', { item: { ...file, status: 'failed' } })();
  await settle();
  assert.deepEqual(callsTo('reveal:revealSessionOutputs').at(-1), ['a', 't', []]);
});
