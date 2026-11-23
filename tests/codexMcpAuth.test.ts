// Codex OAuth lifecycle: completion, recovery, notification validation, deadlines and retired async results.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount, click, flush, byText, popoverStubs, reactProps } from './support/harness-ui-kit.ts';
import { iconStubs } from './support/stubs.ts';
import { deferred } from './support/async-scenarios.ts';
import { installNativeStub } from './support/ports/native.ts';
const { createElement: h, act } = await import('react');
const calls: any[] = [];
const listeners = new Set<(m: string, p: unknown) => void>();
let request: (method?: string) => Promise<any>;
let verifiedAuth = 'notLoggedIn';
let open: (url: string) => Promise<any>;
mock.module('../src/harness/adapters/codex.ts', {
  namedExports: {
    codexRequest: (...a: any[]) => {
      calls.push(['request', ...a]);
      return request(a[0]);
    },
    onCodexNotification: (f: any) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
  },
});
installNativeStub({ shell: { openExternal: (url: string) => open(url) } });
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverStubs });
mock.module('../src/components/ui/icons.tsx', { namedExports: iconStubs() });
const { McpAuth } = await import('../src/components/harness/codex/pluginSettings/McpAuth.tsx');
const done = () => {
  calls.push(['done']);
};
const notify = (p: unknown, m = 'mcpServer/oauthLogin/completed') => act(async () => listeners.forEach((f) => f(m, p)));
async function setup(signedIn = false) {
  calls.length = 0;
  verifiedAuth = 'notLoggedIn';
  request = async (method) =>
    method === 'mcpServerStatus/list'
      ? { data: [{ name: 'server', authStatus: verifiedAuth }] }
      : { authorizationUrl: 'https://auth.example/start' };
  open = async (url) => {
    calls.push(['open', url]);
  };
  return mount(h(McpAuth, { name: 'server', signedIn, onDone: done }));
}

test('OAuth options, duplicate starts, validated matching completion and manual connection checks', async () => {
  const r = await setup();
  const start = reactProps(byText(r.host, 'button', 'Authenticate')!).onClick;
  await act(async () => {
    start();
    start();
  });
  assert.equal(calls.filter((c) => c[0] === 'request').length, 1);
  assert.deepEqual(calls[0], ['request', 'mcpServer/oauth/login', { name: 'server', clientRegistration: null }]);
  assert.ok(byText(r.host, 'button', 'Waiting for sign-in…')!.hasAttribute('disabled'));
  for (const p of [
    null,
    {},
    { name: 'other', success: true },
    { name: 'server', success: 'true' },
    { name: 'server', threadId: 'chat', success: true },
  ])
    await notify(p);
  await notify({ name: 'server', success: true }, 'other');
  assert.equal(
    calls.some((c) => c[0] === 'done'),
    false,
  );
  window.dispatchEvent(new Event('focus'));
  await flush();
  assert.deepEqual(calls.at(-1), ['done']);
  await click(byText(r.host, 'button', 'Open sign-in page'));
  await notify({ name: 'server', threadId: null, success: false });
  assert.equal(r.host.querySelector('[role=alert]'), null);
  assert.ok(byText(r.host, 'button', 'Waiting for sign-in…'));
  await click(byText(r.host, 'button', 'Check connection'));
  verifiedAuth = 'oAuth';
  for (const mode of ['CIMD', 'DCR', 'Automatic']) {
    await click(r.host.querySelector('[aria-label="OAuth registration options"]'));
    await click(byText(r.host, '[role=menuitem]', new RegExp(mode)));
    await click(byText(r.host, 'button', 'Authenticate'));
    assert.equal(calls.findLast((c) => c[0] === 'request')[2].clientRegistration, mode === 'Automatic' ? null : mode.toLowerCase());
    await notify({ name: 'server', success: true });
  }
  await click(byText(r.host, 'button', 'Authenticate'));
  await click(byText(r.host, 'button', 'Check connection'));
  assert.equal(byText(r.host, 'button', 'Open sign-in page'), undefined);
  await r.unmount();
  assert.equal(listeners.size, 0);
});

test('invalid or missing authorization pages and request failures are retryable', async () => {
  const r = await setup(true);
  for (const response of [null, {}, { authorizationUrl: 12 }, { authorizationUrl: 'file:///private' }]) {
    request = async () => response;
    await click(byText(r.host, 'button', 'Reauthenticate'));
    assert.match(r.host.querySelector('[role=alert]')!.textContent!, /valid sign-in page/);
  }
  request = async () => {
    throw new Error('offline');
  };
  await click(byText(r.host, 'button', 'Reauthenticate'));
  assert.match(r.host.querySelector('[role=alert]')!.textContent!, /offline/);
  await click(byText(r.host, 'button', 'Check connection'));
  await r.unmount();
});

test('browser failures keep the URL available to retry, and a deadline exits waiting', async () => {
  const r = await setup();
  open = async () => {
    throw new Error('browser unavailable');
  };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await click(byText(r.host, 'button', 'Authenticate'));
    assert.match(r.host.querySelector('[role=alert]')!.textContent!, /Couldn't open.*browser unavailable/);
    assert.ok(byText(r.host, 'button', 'Open sign-in page'));
    await act(async () => mock.timers.tick(120_000));
    assert.ok(byText(r.host, 'button', 'Authenticate'));
    assert.equal(byText(r.host, 'button', 'Open sign-in page'), undefined);
    assert.match(r.host.querySelector('[role=alert]')!.textContent!, /has not completed/);
  } finally {
    mock.timers.reset();
  }
  await r.unmount();
});

test('late request and browser results cannot affect a replacement or a closed row', async () => {
  for (const failure of [false, true]) {
    const r = await setup();
    const pending = deferred();
    request = () => pending.promise;
    await click(byText(r.host, 'button', 'Authenticate'));
    await click(byText(r.host, 'button', 'Check connection'));
    request = async () => ({ authorizationUrl: 'https://new' });
    await click(byText(r.host, 'button', 'Authenticate'));
    if (failure) pending.reject(new Error('old failure'));
    else pending.resolve({ authorizationUrl: 'https://old' });
    await flush();
    assert.equal(r.host.querySelector('[role=alert]'), null);
    assert.equal(
      calls.some((c) => c[0] === 'open' && c[1] === 'https://old'),
      false,
    );
    await r.unmount();
  }
  const r = await setup();
  const pending = deferred();
  open = () => pending.promise;
  await click(byText(r.host, 'button', 'Authenticate'));
  await click(byText(r.host, 'button', 'Check connection'));
  open = async () => {};
  await click(byText(r.host, 'button', 'Authenticate'));
  pending.reject(new Error('old browser failure'));
  await flush();
  assert.equal(r.host.querySelector('[role=alert]'), null);
  await r.unmount();
  for (const failure of [false, true]) {
    const r = await setup();
    const pending = deferred();
    request = () => pending.promise;
    await click(byText(r.host, 'button', 'Authenticate'));
    await r.unmount();
    if (failure) pending.reject(new Error('retired'));
    else pending.resolve({ authorizationUrl: 'https://old' });
    await flush();
    assert.equal(
      calls.some((c) => c[0] === 'open'),
      false,
    );
  }
});

test('a queued deadline from a retired attempt cannot clear a pending replacement', async (t) => {
  const timers: (() => void)[] = [];
  const timeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn: () => void, ms: number, ...args: any[]) => {
    if (ms === 120_000) timers.push(fn);
    return timeout(fn, ms, ...args);
  });
  const r = await setup();
  await click(byText(r.host, 'button', 'Authenticate'));
  await click(byText(r.host, 'button', 'Check connection'));
  await click(byText(r.host, 'button', 'Authenticate'));
  await act(async () => timers[0]());
  assert.ok(byText(r.host, 'button', 'Waiting for sign-in…'));
  assert.equal(r.host.querySelector('[role=alert]'), null);
  await r.unmount();
});

test('obsolete completion events only refresh current credentials; reauthentication finishes on verified status', async () => {
  const r = await setup(true);
  await click(byText(r.host, 'button', 'Reauthenticate'));
  await click(byText(r.host, 'button', 'Check connection'));
  const pending = deferred();
  request = (method) =>
    method === 'mcpServerStatus/list' ? Promise.resolve({ data: [{ name: 'server', authStatus: 'oAuth' }] }) : pending.promise;
  await click(byText(r.host, 'button', 'Reauthenticate'));
  await notify({ name: 'server', success: false });
  assert.ok(byText(r.host, 'button', 'Waiting for sign-in…'));
  assert.equal(r.host.querySelector('[role=alert]'), null);
  pending.resolve({ authorizationUrl: 'https://new-login' });
  await flush();
  assert.ok(byText(r.host, 'button', 'Open sign-in page'));
  request = async () => ({ data: [{ name: 'server', authStatus: 'oAuth' }] });
  await notify({ name: 'server', success: true });
  assert.ok(byText(r.host, 'button', 'Waiting for sign-in…'));
  assert.match(r.host.querySelector('[role=status]')!.textContent!, /Finish in your browser/);
  await click(byText(r.host, 'button', 'Check connection'));
  assert.ok(byText(r.host, 'button', 'Reauthenticate'));
  await r.unmount();
});

test('verification reads are latest-wins and ignore obsolete successes and failures', async () => {
  for (const failure of [false, true]) {
    const r = await setup();
    await click(byText(r.host, 'button', 'Authenticate'));
    const first = deferred(),
      second = deferred();
    let reads = 0;
    request = () => (++reads === 1 ? first.promise : second.promise);
    await notify({ name: 'server', success: true });
    await notify({ name: 'server', success: true });
    second.resolve({ data: [] });
    await flush();
    if (failure) first.reject(new Error('obsolete'));
    else first.resolve({ data: [{ name: 'server', authStatus: 'oAuth' }] });
    await flush();
    assert.ok(byText(r.host, 'button', 'Waiting for sign-in…'));
    assert.equal(r.host.querySelector('[role=alert]'), null);
    await r.unmount();
  }
  const r = await setup();
  await click(byText(r.host, 'button', 'Authenticate'));
  for (const result of [null, { data: null }]) {
    request = async () => result;
    await notify({ name: 'server', success: true });
    assert.match(r.host.querySelector('[role=alert]')!.textContent!, /invalid connection status/);
  }
  request = async () => {
    throw new Error('status offline');
  };
  await notify({ name: 'server', success: true });
  assert.match(r.host.querySelector('[role=alert]')!.textContent!, /status offline/);
  const pending = deferred();
  request = () => pending.promise;
  await notify({ name: 'server', success: true });
  await r.unmount();
  pending.resolve({ data: [{ name: 'server', authStatus: 'oAuth' }] });
  await flush();
});
