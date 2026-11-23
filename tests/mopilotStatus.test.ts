// The MoPilot account in the renderer (src/lib/mopilot.ts): one subscription, pushed updates, focus refresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';

let push: (s: any) => void = () => {};
let statusCalls = 0;
let refreshes = 0;
installNativeStub({
  mopilot: {
    status: async () => (
      statusCalls++, { signedIn: false, signingIn: false, user: null, balanceMicros: null, shareUsageData: null, modelCaps: null }
    ),
    onEvent: (cb: (s: any) => void) => {
      push = cb;
    },
    refresh: () => {
      refreshes++;
    },
  },
});
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { formatCredits, getMoPilot, useMoPilot } = await import('../src/lib/mopilot.ts');

test('the hook starts once, follows pushed status, and refreshes on focus only when signed in', async () => {
  const seen: any[] = [];
  const Probe = () => (seen.push(useMoPilot()), null);
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(() => root.render(createElement('div', null, createElement(Probe), createElement(Probe))));
  assert.equal(statusCalls, 1);
  assert.equal(seen.at(-1).signedIn, false);
  window.dispatchEvent(new window.Event('focus'));
  assert.equal(refreshes, 0);
  await act(() => push({ ...getMoPilot(), signedIn: true, balanceMicros: 2_500_000 }));
  assert.equal(seen.at(-1).balanceMicros, 2_500_000);
  window.dispatchEvent(new window.Event('focus'));
  assert.equal(refreshes, 1);
  await act(() => root.unmount());
  assert.equal(formatCredits(getMoPilot().balanceMicros), '$2.50');
});
