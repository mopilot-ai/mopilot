// A failure with an account (an interrupted token refresh does this) offers Sign out, so the person is not stranded on a screen with no tab bar; without an account, Retry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
const appPath = '../mobile/src/MobileApp';
const recoveryPath = '../mobile/src/components/ErrorRecovery';
const { MobileApp } = await import(appPath);
const { ErrorRecovery } = await import(recoveryPath);

const base = {
  generation: 1,
  pairs: [{ pairId: 'p', macId: 'm', name: 'Studio Mac' }],
  selectedPair: null,
  safetyNumber: null,
  pendingPair: false,
  presence: {},
  reconnect: null,
  outbox: [],
  pairCleanup: false,
};
async function mount(snapshot: any) {
  const calls: string[] = [];
  const runtime: any = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    start: async () => void calls.push('start'),
    signOut: async () => void calls.push('signOut'),
    connect: async (pair: string) => void calls.push('connect:' + pair),
    request: async () => ({}),
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime })));
  await flush();
  return {
    host,
    calls,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const has = (host: HTMLElement, label: string) => [...host.querySelectorAll('button')].some((b) => b.textContent === label);

test('a failure with an account offers Sign out and no Retry (start has finished, so Retry would do nothing); Sign out leaves the account', async () => {
  const v = await mount({ ...base, phase: 'error', user: { id: 'u' }, error: 'refresh interrupted; sign in again' });
  assert.match(v.host.textContent!, /will need to pair your computers again/);
  assert.equal(has(v.host, 'Retry'), false);
  await click('Sign out to sign in again');
  assert.deepEqual(v.calls, ['start', 'signOut'], 'the app starts once at mount, then Sign out leaves');
  await v.done();
});

test('a failure with no account offers Retry only', async () => {
  const v = await mount({ ...base, phase: 'error', user: null, pairs: [], error: 'Storage unavailable' });
  assert.ok(has(v.host, 'Retry'));
  assert.equal(has(v.host, 'Sign out to sign in again'), false);
  await click('Retry');
  assert.deepEqual(v.calls, ['start', 'start'], 'once at mount, once for Retry');
  await v.done();
});

test('nothing is offered when the start did not fail, and a busy screen disables the button', async () => {
  const quiet = await mount({ ...base, phase: 'ready', user: { id: 'u' }, error: null });
  assert.equal(has(quiet.host, 'Retry'), false);
  assert.equal(has(quiet.host, 'Sign out to sign in again'), false);
  await quiet.done();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(ErrorRecovery, { failed: true, signedIn: true, busy: true, retry: () => {}, signOut: () => {} })),
  );
  assert.deepEqual(
    [...host.querySelectorAll('button')].map((b) => [b.textContent, (b as HTMLButtonElement).disabled]),
    [['Sign out to sign in again', true]],
  );
  await act(async () =>
    root.render(createElement(ErrorRecovery, { failed: true, signedIn: false, busy: true, retry: () => {}, signOut: () => {} })),
  );
  assert.deepEqual(
    [...host.querySelectorAll('button')].map((b) => [b.textContent, (b as HTMLButtonElement).disabled]),
    [['Retrying…', true]],
  );
  await act(async () => root.unmount());
  host.remove();
});

test('a service-upgrade failure keeps the account and offers reconnect instead of signing out', async () => {
  const { REFRESH_SERVICE_UPDATE } = await import('../mobile/src/accountRecovery');
  const calls: string[] = [];
  const snapshot = { ...base, phase: 'error', user: { id: 'u' }, error: REFRESH_SERVICE_UPDATE };
  const runtime: any = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    start: async () => {
      calls.push('start');
    },
    connect: async (pair: string) => {
      calls.push('connect:' + pair);
    },
    signOut: async () => {
      calls.push('signOut');
    },
    request: async () => ({}),
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime })));
  await flush();
  assert.match(host.textContent!, /computers are still saved/i);
  await click('Retry');
  assert.deepEqual(calls, ['start', 'connect:p']);
  await act(async () => root.unmount());
  host.remove();
});

test('a service-update failure without a saved computer keeps the account without a destructive or ineffective action', async () => {
  const { REFRESH_SERVICE_UPDATE } = await import('../mobile/src/accountRecovery');
  const v = await mount({ ...base, phase: 'error', user: { id: 'u' }, pairs: [], error: REFRESH_SERVICE_UPDATE });
  assert.equal(has(v.host, 'Retry'), true);
  assert.match(v.host.textContent!, /computers are still saved/);
  await v.done();
});

test('an unknown prior target with several saved computers requires an explicit computer choice', async () => {
  const { REFRESH_SERVICE_UPDATE } = await import('../mobile/src/accountRecovery');
  const v = await mount({
    ...base,
    phase: 'error',
    user: { id: 'u' },
    error: REFRESH_SERVICE_UPDATE,
    pairs: [
      { pairId: 'a', name: 'Studio' },
      { pairId: 'b', name: '' },
    ],
  });
  assert.equal(has(v.host, 'Retry'), false);
  assert.equal(has(v.host, 'Reconnect Studio'), true);
  await click('Reconnect Computer');
  assert.deepEqual(v.calls, ['start', 'connect:b']);
  await v.done();
});

test('transport, server, malformed-response and local-save failures retain account state with a working reconnect action', async () => {
  for (const error of [
    'Account service returned HTTP 503',
    'Network request failed',
    'Fetch request has been canceled',
    'invalid token response',
    'disk unavailable',
  ]) {
    const v = await mount({ ...base, phase: 'error', user: { id: 'u' }, error });
    await click('Retry');
    assert.deepEqual(v.calls, ['start', 'connect:p'], error);
    await v.done();
  }
});

test('an explicit account refusal warns that re-pairing is required before offering sign-out', async () => {
  for (const error of [
    'Account service returned HTTP 401',
    'This sign-in cannot be restored. Sign in again to continue; you will need to pair your computers again.',
  ]) {
    const v = await mount({ ...base, phase: 'error', user: { id: 'u' }, error });
    assert.equal(has(v.host, 'Retry'), false);
    assert.match(v.host.textContent!, /will need to pair your computers again/);
    await click('Sign out to sign in again');
    assert.deepEqual(v.calls, ['start', 'signOut']);
    await v.done();
  }
});

test('every signed-in failure has a way forward: Retry when it can help, and Sign out as the way out', async () => {
  const { REFRESH_SERVICE_UPDATE } = await import('../mobile/src/accountRecovery');
  // a fresh sign-in whose first calls fail leaves an account and no computer: before, nothing at all was offered
  for (const error of [
    'Account service returned HTTP 500',
    'Account service returned HTTP 403',
    'invalid relay token response',
    REFRESH_SERVICE_UPDATE,
  ]) {
    const v = await mount({ ...base, phase: 'error', user: { id: 'u' }, pairs: [], error });
    assert.equal(has(v.host, 'Retry'), true, `${error}: Retry`);
    assert.equal(has(v.host, 'Sign out to sign in again'), true, `${error}: Sign out`);
    await click('Retry');
    assert.deepEqual(v.calls, ['start', 'start'], `${error}: Retry starts again`);
    await v.done();
  }
  // with computers, Sign out stays available next to the reconnect actions
  const one = await mount({ ...base, phase: 'error', user: { id: 'u' }, error: 'Account service returned HTTP 503' });
  assert.equal(has(one.host, 'Retry'), true);
  assert.equal(has(one.host, 'Sign out to sign in again'), true);
  await click('Sign out to sign in again');
  assert.deepEqual(one.calls, ['start', 'signOut']);
  await one.done();
  const many = await mount({
    ...base,
    phase: 'error',
    user: { id: 'u' },
    error: 'Account service returned HTTP 503',
    pairs: [
      { pairId: 'a', name: 'A' },
      { pairId: 'b', name: 'B' },
    ],
  });
  assert.equal(has(many.host, 'Reconnect A'), true);
  assert.equal(has(many.host, 'Sign out to sign in again'), true);
  await many.done();
});
