// A development build that talks to a dev host shows it on the home screen and under Settings > About; a normal build shows nothing new.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
const appPath = '../mobile/src/MobileApp';
const endpointsPath = '../mobile/src/endpoints';
const { MobileApp } = await import(appPath);
const { resolveEndpoints, devEndpointsOf } = await import(endpointsPath);

const state: any = {
  phase: 'ready',
  generation: 1,
  user: { id: 'u', name: 'Dev' },
  pairs: [],
  presence: {},
  outbox: [],
  selectedPair: null,
  pendingPair: false,
  pairingCommit: false,
  pairCleanup: false,
  safetyNumber: null,
  error: null,
};
const DEV = 'http://192.168.86.228:8787';

async function show(devEndpoints: unknown) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const runtime: any = { snapshot: () => state, subscribe: () => () => {}, start: async () => {}, request: async () => ({}) };
  await act(async () => root.render(createElement(MobileApp, { runtime, version: '0.1.0', devEndpoints })));
  await flush();
  const home = host.textContent!;
  await click('Settings');
  await click('About');
  const about = host.textContent!;
  await act(async () => root.unmount());
  host.remove();
  return { home, about };
}

test('a build with the dev override shows the dev host on the home screen and both endpoints under About', async () => {
  const { home, about } = await show(devEndpointsOf(resolveEndpoints(DEV, true)));
  assert.match(home, /Dev host: 192\.168\.86\.228:8787/);
  assert.match(about, /Relayws:\/\/192\.168\.86\.228:8787\/v1\/ws/);
  assert.match(about, /Accounthttp:\/\/192\.168\.86\.228:8787/);
});

test('a normal or production build shows nothing new, even when a dev host is configured but ignored', async () => {
  for (const chosen of [
    resolveEndpoints(undefined, false),
    resolveEndpoints(DEV, false),
    resolveEndpoints(undefined, true),
    resolveEndpoints('https://evil.example', true),
  ]) {
    assert.equal(devEndpointsOf(chosen), undefined);
    const { home, about } = await show(devEndpointsOf(chosen));
    for (const text of [home, about]) assert.doesNotMatch(text, /Dev host|Relay:|Account: |192\.168/);
  }
});
