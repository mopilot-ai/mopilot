// Main's pushed MoPilot account display state supersedes the initial snapshot, including while no component is mounted.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { controlledReads } from './support/async-scenarios.ts';
import type { MoPilotStatus } from '../src/lib/native';
import { installNativeStub } from './support/ports/native.ts';

const empty: MoPilotStatus = {
  signedIn: false,
  signingIn: false,
  user: null,
  balanceMicros: null,
  shareUsageData: null,
  modelCaps: null,
};
let reads = controlledReads<MoPilotStatus>();
let push: (value: MoPilotStatus) => void;
const failures: unknown[][] = [];
installNativeStub({
  mopilot: {
    status: () => reads.read(),
    onEvent: (cb: typeof push) => {
      push = cb;
    },
    refresh: async () => {},
  },
});
mock.module('../src/lib/ignored.ts', {
  namedExports: {
    ignoring: (context: string) => (error: unknown) => failures.push([context, error]),
  },
});
const { createElement, act, StrictMode } = await import('react');
const { createRoot } = await import('react-dom/client');

let sequence = 0;
async function mount() {
  reads = controlledReads<MoPilotStatus>();
  failures.length = 0;
  const api = await import(`../src/lib/mopilot.ts?ordering=${++sequence}`);
  const seen: MoPilotStatus[] = [];
  const Probe = () => (seen.push(api.useMoPilot()), null);
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(createElement(StrictMode, null, createElement(Probe), createElement(Probe))));
  assert.equal(reads.requests.length, 1, 'one window-owned reader, including Strict Mode and concurrent consumers');
  return { api, seen, unmount: () => act(async () => root.unmount()) };
}

for (const outcome of ['success', 'failure'] as const) {
  test(`a live account replacement wins over a late initial ${outcome}`, async () => {
    const p = await mount();
    const replacement = {
      ...empty,
      signedIn: true,
      balanceMicros: 2_000_000,
      user: { id: 'new-account', email: 'new@example.test' },
    };
    await act(async () => push(replacement));
    await act(async () => {
      if (outcome === 'success') reads.requests[0].resolve({ ...empty, balanceMicros: 100 });
      else reads.requests[0].reject(new Error('obsolete account snapshot'));
    });
    assert.equal(p.api.getMoPilot(), replacement);
    assert.equal(p.seen.at(-1), replacement);
    assert.deepEqual(failures, []);
    await p.unmount();
    // This owner deliberately outlives individual subscribers. Sign-out still replaces the cached state.
    const signedOut = { ...empty };
    push(signedOut);
    assert.equal(p.api.getMoPilot(), signedOut);
  });
}

test('a current account snapshot succeeds, and pushed sign-out replaces all account fields', async () => {
  const p = await mount();
  const snapshot = { ...empty, signedIn: true, balanceMicros: 5_000_000 };
  await act(async () => reads.requests[0].resolve(snapshot));
  assert.equal(p.api.getMoPilot(), snapshot);
  const signedOut = { ...empty };
  await act(async () => push(signedOut));
  assert.equal(p.api.getMoPilot(), signedOut);
  assert.equal(p.seen.at(-1), signedOut);
  await p.unmount();
});

test('a current account snapshot failure is diagnosed, then an event recovers', async () => {
  const p = await mount();
  const error = new Error('account snapshot unavailable');
  await act(async () => reads.requests[0].reject(error));
  assert.deepEqual(failures, [['read the MoPilot account status', error]]);
  assert.equal(p.api.getMoPilot().signedIn, false);
  const recovered = { ...empty, signedIn: true };
  await act(async () => push(recovered));
  assert.equal(p.api.getMoPilot(), recovered);
  await p.unmount();
});
