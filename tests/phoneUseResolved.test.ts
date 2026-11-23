// useResolved: a promise the app is handed (a cache opened at launch) as state — null until it resolves, null after a failure, and never set after unmount.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
const hookPath = '../mobile/src/useResolved';
const { useResolved } = await import(hookPath);

async function probe(setup: Promise<any> | undefined) {
  const seen: any[] = [];
  const Probe = () => {
    seen.push(useResolved(setup));
    return null;
  };
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
  return { seen, root };
}

test('a resolved setup becomes the value; none or a failed one stays null', async () => {
  const ok = await probe(Promise.resolve({ cache: 1 }));
  await flush();
  assert.deepEqual(ok.seen.at(-1), { cache: 1 });
  assert.equal(ok.seen[0], null, 'null until it resolves');

  const none = await probe(undefined);
  await flush();
  assert.equal(none.seen.at(-1), null);

  const failed = await probe(Promise.reject(new Error('disk')));
  await flush();
  assert.equal(failed.seen.at(-1), null);
  for (const p of [ok, none, failed]) await act(async () => p.root.unmount());
});

test('a setup that resolves after the screen is gone sets nothing', async () => {
  let resolve!: (v: any) => void;
  const late = await probe(new Promise((r) => (resolve = r)));
  await act(async () => late.root.unmount());
  const renders = late.seen.length;
  resolve({ cache: 2 });
  await flush();
  assert.equal(late.seen.length, renders);
});
