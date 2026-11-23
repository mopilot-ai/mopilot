// Remote kill switches in the renderer (src/lib/flags.ts): reads and re-renders on main's snapshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';

const on = new Set<string>(['harness.codex.enabled', 'harness.claude.enabled']);
const listeners = new Set<() => void>();
installNativeStub({
  flags: {
    isEnabled: (k: string) => on.has(k),
    onChanged: (cb: () => void) => (listeners.add(cb), () => listeners.delete(cb)),
  },
});
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { harnessEnabled, isEnabled, useEnabledHarnesses } = await import('../src/lib/flags.ts');

test('flags read main’s resolved snapshot', () => {
  assert.equal(isEnabled('shared.browser.extension'), false);
  assert.equal(harnessEnabled('claude'), true);
});

test('the harness list follows flag changes and unsubscribes on unmount', async () => {
  const seen: string[][] = [];
  const Probe = () => (seen.push(useEnabledHarnesses()), null);
  const root = createRoot(document.createElement('div'));
  await act(() => root.render(createElement(Probe)));
  assert.deepEqual(seen.at(-1), ['codex', 'claude']);
  on.delete('harness.codex.enabled');
  await act(() => listeners.forEach((cb) => cb()));
  assert.deepEqual(seen.at(-1), ['claude']);
  on.delete('harness.claude.enabled');
  await act(() => listeners.forEach((cb) => cb()));
  assert.deepEqual(seen.at(-1), []);
  await act(() => root.unmount());
  assert.equal(listeners.size, 0);
});
