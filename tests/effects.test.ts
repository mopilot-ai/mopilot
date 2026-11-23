// Effects with named triggers and window listeners that read the latest render (src/lib/effects.ts): when they run,
// what they read, and that every run and listener is cleaned up.
import { render } from './support/thread-kit.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement as h } from 'react';
import { useEffectOn, useWindowListener } from '../src/lib/effects.ts';

test('useEffectOn runs on mount and on a trigger change, with the latest values, cleaning up each run', async () => {
  const log: string[] = [];
  function Probe({ chat, note }: { chat: string; note: string }) {
    useEffectOn([chat], () => {
      log.push(`run ${chat} ${note}`);
      return () => log.push(`clean ${chat}`);
    });
    return null;
  }
  const v = await render(h(Probe, { chat: 'a', note: 'first' }));
  assert.deepEqual(log, ['run a first']);
  // a value that is not a trigger does not run it again
  await v.rerender(h(Probe, { chat: 'a', note: 'second' }));
  assert.deepEqual(log, ['run a first']);
  // a trigger change cleans up the last run, then runs with what this render has, not what the first one had
  await v.rerender(h(Probe, { chat: 'b', note: 'third' }));
  assert.deepEqual(log, ['run a first', 'clean a', 'run b third']);
  await v.unmount();
  assert.deepEqual(log, ['run a first', 'clean a', 'run b third', 'clean b']);
});

test('useEffectOn compares each trigger like a dependency list: NaN equals NaN, a new object is a change', async () => {
  const runs: unknown[][] = [];
  function Probe({ a, b }: { a: unknown; b?: unknown }) {
    useEffectOn(b === undefined ? [a] : [a, b], () => {
      runs.push(b === undefined ? [a] : [a, b]);
      return undefined;
    });
    return null;
  }
  const v = await render(h(Probe, { a: Number.NaN }));
  await v.rerender(h(Probe, { a: Number.NaN }));
  assert.equal(runs.length, 1);
  const same = {};
  await v.rerender(h(Probe, { a: same }));
  await v.rerender(h(Probe, { a: same }));
  await v.rerender(h(Probe, { a: {} }));
  assert.equal(runs.length, 3);
  // a different number of triggers is a change too
  await v.rerender(h(Probe, { a: 1, b: 2 }));
  assert.equal(runs.length, 4);
  await v.unmount();
});

test('useEffectOn with no triggers runs once, and a run without a cleanup is fine', async () => {
  let runs = 0;
  function Probe({ n }: { n: number }) {
    useEffectOn([], () => {
      runs += n;
      return undefined;
    });
    return null;
  }
  const v = await render(h(Probe, { n: 1 }));
  await v.rerender(h(Probe, { n: 10 }));
  await v.rerender(h(Probe, { n: 100 }));
  assert.equal(runs, 1);
  await v.unmount();
});

test('useWindowListener subscribes once and calls the handler of the latest render', async () => {
  const seen: string[] = [];
  const added: string[] = [];
  const add = window.addEventListener;
  window.addEventListener = ((type: string, ...rest: any[]) => {
    added.push(type);
    return (add as any).call(window, type, ...rest);
  }) as typeof window.addEventListener;
  function Probe({ label }: { label: string }) {
    useWindowListener('keydown', (e) => seen.push(`${label}:${e.key}`));
    return null;
  }
  try {
    const v = await render(h(Probe, { label: 'one' }));
    await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' })));
    await v.rerender(h(Probe, { label: 'two' }));
    await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'b' })));
    assert.deepEqual(seen, ['one:a', 'two:b']);
    assert.equal(added.filter((t) => t === 'keydown').length, 1, 'a new handler does not subscribe again');
    await v.unmount();
    await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'c' })));
    assert.deepEqual(seen, ['one:a', 'two:b'], 'unmounting stops listening');
  } finally {
    window.addEventListener = add;
  }
});
