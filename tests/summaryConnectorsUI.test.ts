// Connector disclosure through the real harness readers, with controlled native replies and owner changes.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { beforeEach, test } from 'node:test';
import { act, createElement as h, StrictMode } from 'react';
import './support/dom.ts';
import { controlledReads, tick } from './support/async-scenarios.ts';
import { fakeStore, one, render } from './support/shell-panels-kit.ts';
import { stubStore } from './support/stubs.ts';
import { installNative } from '../src/lib/native.ts';
import { fakeNative } from './support/ports/native.ts';

const store = fakeStore({});
const routes: unknown[] = [];
stubStore({ ...store.exports, navigate: (route: unknown) => routes.push(route) });
const { SummaryConnectors } = await import('../src/components/panels/SummaryConnectors.tsx');
const { loadSessionConnectors } = await import('../src/session/harness/mcpRows.ts');
const { CodexEvents } = createRequire(import.meta.url)('../electron/harness/codexEvents.cjs');
const ONE = { chatId: 'chat', cwd: '/project', location: 'local' as const };
const segment = (harness: string, nativeId: string, chatId = 'chat') => ({ [chatId]: [{ harness, nativeId }] });
const hint = (host: HTMLElement) => one(host, '.summary-connector-hint').textContent;
const page = (data: unknown[], nextCursor: unknown = null) => ({ data, nextCursor });
const acpConfig = (harness: string, servers: unknown[] = []) => ({ harness, load: true, supported: true, servers });

async function open(host: HTMLElement) {
  await act(() => {
    const details = one(host, 'details') as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new window.Event('toggle'));
  });
}

beforeEach(() => {
  routes.length = 0;
  store.set({ segments: {}, accounts: {}, claudeChats: {}, prefs: {}, runtime: {}, conn: 'ready' });
});

test('Codex paginates the same session and shows live status with a reconnect count', async () => {
  store.set({
    segments: segment('codex', 'codex:native'),
    accounts: { active: 'default', chatAccounts: { 'codex:native': { id: 'pinned' } } },
  });
  const port = fakeNative({
    codex: {
      api: async (_method: string, [scope]: [{ cursor: string | null }]) =>
        scope.cursor
          ? page([
              { name: 'off', runtimeStatus: 'disabled', authStatus: 'notLoggedIn' },
              { name: 'waiting', runtimeStatus: 'starting' },
              { name: 'cancelled', runtimeStatus: 'cancelled' },
              { name: 'refused', runtimeStatus: 'failed' },
              { name: 'pending', runtimeStatus: 'notStarted', authStatus: 'notLoggedIn' },
              { name: 'old-cli' },
            ])
          : page(
              [
                { name: 'server:docs', runtimeStatus: 'connected' },
                { name: 'server:auth', runtimeStatus: 'authenticationRequired' },
              ],
              'opaque:cursor',
            ),
    },
  });
  installNative(port);
  const r = await render(h(SummaryConnectors, ONE));
  assert.equal(hint(r.host), '2 to reconnect');
  assert.equal(r.host.querySelectorAll('.summary-connector').length, 0);
  await open(r.host);
  assert.deepEqual(
    [...r.host.querySelectorAll('.summary-connector')].map((row) => [
      row.querySelector('.summary-label')?.textContent,
      row.querySelector('.summary-hint')?.textContent,
    ]),
    [
      ['server:docs', 'Connected'],
      ['server:auth', 'Sign-in required'],
      ['off', 'Disabled'],
      ['waiting', 'Connecting…'],
      ['cancelled', 'Connection cancelled'],
      ['refused', 'Connection failed'],
      ['pending', 'Sign-in required'],
      ['old-cli', 'Status unavailable'],
    ],
  );
  assert.deepEqual(
    port.callsTo('codex.api'),
    [null, 'opaque:cursor'].map((cursor) => ['mcpStatus', [{ chatId: 'chat', nativeId: 'codex:native', cursor }]]),
  );
  await act(() => store.set({ accounts: { active: 'other', chatAccounts: { 'codex:native': { id: 'pinned' } } } }));
  assert.equal(port.callsTo('codex.api').length, 2, 'changing the default leaves a pinned session alone');
  await act(() => one(r.host, 'button', 'Manage connectors').click());
  assert.deepEqual(routes, [{ name: 'settings', section: 'codex', tab: 'extensions:mcps' }]);
  await r.unmount();
});

test('Claude Code reports the current session through a turn, with no false empty state while its process is down', async () => {
  store.set({ segments: segment('claude', 'claude:native'), claudeChats: { chat: { id: 'first' } } });
  let servers: unknown = null;
  const port = fakeNative({ claude: { control: async () => servers } });
  installNative(port);
  const r = await render(h(SummaryConnectors, ONE));
  await open(r.host);
  assert.equal(hint(r.host), 'Unavailable');
  assert.match(r.host.textContent!, /no connector status available/);
  servers = [
    { name: 'calendar', status: 'needs-auth', scope: 'claudeai' },
    { name: 'local', status: 'connected' },
  ];
  await act(() => store.set({ runtime: { chat: { turns: [{ status: 'inProgress' }] } } }));
  assert.equal(hint(r.host), '1 to reconnect');
  assert.match(r.host.textContent!, /calendarSign-in required/);
  assert.match(r.host.textContent!, /localConnected/);
  servers = [{ name: 'other-account', status: 'disabled' }];
  await act(() => store.set({ claudeChats: { chat: { id: 'first', serving: 'second' } } }));
  assert.match(r.host.textContent!, /other-accountDisabled/);
  servers = [{ name: 'default-account', status: 'connected' }];
  await act(() => store.set({ claudeChats: {}, claudeAccounts: { active: 'default' } }));
  assert.match(r.host.textContent!, /default-accountConnected/);
  servers = [];
  await act(() => store.set({ runtime: { chat: { turns: [{ status: 'completed' }] } } }));
  assert.equal(hint(r.host), 'None');
  assert.match(r.host.textContent!, /No MCP connectors in this session/);
  assert.deepEqual(
    port.callsTo('claude.control'),
    Array.from({ length: 5 }, () => ['claude:native', 'mcpStatus']),
  );
  await act(() => one(r.host, 'button', 'Manage connectors').click());
  assert.deepEqual(routes, [{ name: 'settings', section: 'claude', tab: 'extensions:mcps', connectorChatId: 'chat' }]);
  await r.unmount();
});

test('ACP distinguishes configuration from live status and opens settings for the current agent', async () => {
  store.set({ segments: segment('acp:opencode', 'acp:opencode:one') });
  let load = true;
  let managed = true;
  const port = fakeNative({
    acp: {
      ownMcp: async (harness: string) =>
        harness === 'opencode'
          ? {
              ...acpConfig(harness, [
                { name: 'active', enabled: true, off: false },
                { name: 'off', enabled: true, off: true },
                { name: 'gateway', enabled: true, off: false, managed },
              ]),
              load,
            }
          : { ...acpConfig(harness), supported: false },
    },
  });
  installNative(port);
  const r = await render(h(SummaryConnectors, ONE));
  await open(r.host);
  assert.equal(hint(r.host), 'Configuration only');
  assert.match(r.host.textContent!, /Showing global settings/);
  assert.match(r.host.textContent!, /activeConfigured/);
  assert.match(r.host.textContent!, /offDisabled in settings/);
  assert.match(r.host.textContent!, /gatewayManaged by gateway/);
  managed = false;
  await act(() => port.emit('gateway.onChanged'));
  assert.match(r.host.textContent!, /gatewayConfigured/);
  assert.deepEqual(port.callsTo('acp.ownMcp'), [
    ['opencode', true],
    ['opencode', true],
  ]);
  load = false;
  await act(() => store.set({ prefs: { acpMcp: { opencode: { load } } } }));
  assert.match(r.host.textContent!, /activeDisabled in settings/);
  await act(() => store.set({ segments: segment('acp:kimi', 'acp:kimi:two') }));
  assert.equal(hint(r.host), 'Unavailable');
  assert.equal(r.host.querySelector('.summary-connector'), null);
  await act(() => one(r.host, 'button', 'Manage connectors').click());
  assert.deepEqual(routes, [{ name: 'settings', section: 'other-harnesses', tab: 'harness:kimi' }]);
  await r.unmount();
});

test('pending ownership and a Host chat never query local connectors or settings', async () => {
  const port = fakeNative();
  installNative(port);
  const r = await render(h(SummaryConnectors, { ...ONE, location: 'pending' }));
  await open(r.host);
  assert.equal(hint(r.host), 'Reading…');
  assert.equal(r.host.querySelector('button'), null);
  assert.match(r.host.textContent!, /Locating workspace…/);
  await r.rerender(h(SummaryConnectors, { ...ONE, location: 'workspaceUnavailable' }));
  assert.equal(hint(r.host), 'Unavailable');
  assert.match(r.host.textContent!, /Could not confirm which computer/);
  assert.equal(r.host.querySelector('button'), null);
  await r.rerender(h(SummaryConnectors, { ...ONE, location: 'remote' }));
  await act(() => window.dispatchEvent(new Event('focus')));
  assert.equal(hint(r.host), 'On Host');
  assert.match(r.host.textContent!, /computer running this chat/);
  assert.equal(r.host.querySelector('button'), null);
  assert.deepEqual(port.calls, []);
  await r.unmount();
});

test('Claude process exit retires cached and pending reads; a replacement gets its own status after initialization', async () => {
  store.set({ segments: segment('claude', 'native') });
  const read = controlledReads<unknown>();
  const port = fakeNative({ claude: { control: read.read } });
  installNative(port);
  const r = await render(h(SummaryConnectors, ONE));
  await open(r.host);
  const event = async (event: unknown) => act(() => port.emit('claude.onEvent', event));
  await act(() => read.requests[0].resolve([{ name: 'old', status: 'connected' }]));
  assert.match(r.host.textContent!, /oldConnected/);
  for (const ignored of [
    { kind: 'toast' },
    { key: 'other', kind: 'closed' },
    { key: 'native', kind: 'message', msg: { type: 'assistant' } },
    { key: 'native', kind: 'message', msg: { type: 'system', subtype: 'other' } },
  ])
    await event(ignored);
  assert.match(r.host.textContent!, /oldConnected/);
  await event({ key: 'native', kind: 'closed' });
  assert.equal(hint(r.host), 'Unavailable');
  assert.doesNotMatch(r.host.textContent!, /oldConnected/);
  await event({ key: 'native', kind: 'processStarted' });
  assert.equal(hint(r.host), 'Reading…');
  await event({ key: 'native', kind: 'message', msg: { type: 'system', subtype: 'init' } });
  await act(() => read.requests[1].resolve([{ name: 'old', status: 'connected' }]));
  assert.equal(hint(r.host), 'Reading…');
  await act(() => read.requests[2].resolve([{ name: 'current', status: 'needs-auth' }]));
  assert.equal(hint(r.host), '1 to reconnect');
  await event({ key: 'native', kind: 'processRetired' });
  assert.equal(hint(r.host), 'Unavailable');
  await event({ key: 'native', kind: 'processStarted' });
  await event({ key: 'native', kind: 'error' });
  await act(() => read.requests[3].resolve([{ name: 'late', status: 'connected' }]));
  assert.equal(hint(r.host), 'Unavailable');
  await r.unmount();
});

test('a Codex close invalidates only that thread and a later start refreshes its inventory', async () => {
  const read = controlledReads<unknown>();
  const port = fakeNative({ codex: { api: read.read } });
  installNative(port);
  const r = await render(h(SummaryConnectors, ONE));
  const notice = async (method: string, params: unknown) => act(() => port.emit('codex.onItem', { kind: 'notification', method, params }));
  for (const params of [null, { threadId: 'other' }]) await notice('thread/closed', params);
  assert.equal(hint(r.host), 'Reading…');
  await notice('thread/closed', { threadId: 'chat' });
  await act(() => read.requests[0].resolve(page([{ name: 'previous', authStatus: 'notLoggedIn' }])));
  assert.equal(hint(r.host), 'Unavailable');
  for (const params of [null, {}, { thread: { id: 'other' } }]) await notice('thread/started', params);
  assert.equal(read.requests.length, 1);
  await notice('thread/started', { thread: { id: 'chat' } });
  await act(() => read.requests[1].resolve(page([])));
  assert.equal(hint(r.host), 'None');
  await act(() => port.emit('codex.onStatus', { kind: 'restarting' }));
  assert.equal(hint(r.host), 'None');
  await act(() => port.emit('codex.onStatus', { kind: 'exit', restarting: true }));
  assert.equal(hint(r.host), 'Unavailable');
  assert.equal(read.requests.length, 2);
  await act(() => port.emit('codex.onStatus', { kind: 'ready' }));
  assert.equal(hint(r.host), 'Reading…');
  await act(() => port.emit('codex.onStatus', { kind: 'error' }));
  await act(() => read.requests[2].resolve(page([])));
  assert.equal(hint(r.host), 'Unavailable');
  await r.unmount();
});

test('Codex switched chats use the native identity from the mapping and lease producer', async () => {
  const nativeId = 'opaque:current';
  store.set({ segments: segment('codex', nativeId) });
  const adapter = Object.create(CodexEvents.prototype);
  Object.assign(adapter, {
    chatOf: () => 'chat',
    prewarmed: new Set(),
    manualCompactions: new Set(),
    hostDeclined: new Set(),
    turnCommands: { stopping: new Set() },
  });
  const read = controlledReads<unknown>();
  const port = fakeNative({ codex: { api: read.read } });
  installNative(port);
  const r = await render(h(SummaryConnectors, ONE));
  const closed = 'thread/closed';
  const close = (id: string) =>
    act(() => port.emit('codex.onItem', { kind: 'notification', method: closed, ...adapter.mapped(closed, { threadId: id }) }));
  await close('older-segment');
  assert.equal(hint(r.host), 'Reading…');
  await close(nativeId);
  await act(() => read.requests[0].resolve(page([{ name: 'previous', authStatus: 'notLoggedIn' }])));
  assert.equal(hint(r.host), 'Unavailable');
  const lease = (id: string, held: boolean) => act(() => port.emit('codex.onItem', { kind: 'lease', threadId: id, chatId: 'chat', held }));
  await lease('older-segment', true);
  assert.equal(read.requests.length, 1);
  await lease(nativeId, true);
  await act(() => read.requests[1].resolve(page([{ name: 'current', runtimeStatus: 'connected' }])));
  assert.equal(hint(r.host), '');
  const startup = 'mcpServer/startupStatus/updated';
  const update = (id: string, status: string) =>
    act(() =>
      port.emit('codex.onItem', {
        kind: 'notification',
        method: startup,
        ...adapter.mapped(startup, { threadId: id, name: 'current', status }),
      }),
    );
  await update('older-segment', 'ready');
  await update(nativeId, 'starting');
  assert.equal(read.requests.length, 2);
  for (const [status, expected] of [
    ['ready', 'Connected'],
    ['failed', 'Connection failed'],
    ['cancelled', 'Connection cancelled'],
  ]) {
    await update(nativeId, status);
    assert.equal(hint(r.host), 'Reading…');
    await act(() => read.requests.at(-1)!.resolve(page([{ name: 'current', runtimeStatus: status === 'ready' ? 'connected' : status }])));
    await open(r.host);
    assert.equal(one(r.host, '.summary-connector .summary-hint').textContent, expected);
  }
  await lease(nativeId, false);
  assert.equal(hint(r.host), 'Unavailable');
  await r.unmount();
});

test('retired successes and failures cannot publish or fetch a page across refresh, account, harness or chat changes', async () => {
  const codex = controlledReads<unknown>();
  const claude = controlledReads<unknown>();
  const port = fakeNative({ codex: { api: codex.read }, claude: { control: claude.read } });
  installNative(port);
  store.set({ segments: segment('codex', 'same:id'), accounts: { active: 'one' } });
  const r = await render(h(StrictMode, null, h(SummaryConnectors, ONE)));
  assert.equal(codex.requests.length, 2);
  await act(() => window.dispatchEvent(new Event('focus')));
  await act(() => store.set({ accounts: { active: 'two' } }));
  await act(() => codex.requests[2].resolve(page([{ name: 'old' }], 'cursor')));
  assert.equal(codex.requests.length, 4);
  assert.equal(hint(r.host), 'Reading…');
  await act(() => codex.requests[3].resolve(page([{ name: 'fresh', authStatus: 'notLoggedIn' }])));
  await act(() => codex.requests[1].reject(Error('obsolete')));
  await act(() => codex.requests[0].resolve(page([])));
  assert.equal(hint(r.host), '1 to reconnect');
  await act(() => window.dispatchEvent(new Event('focus')));
  await act(() => store.set({ segments: segment('claude', 'same:id') }));
  await act(() => codex.requests[4].resolve(page([{ name: 'gone' }], 'cursor')));
  assert.equal(codex.requests.length, 5);
  assert.equal(hint(r.host), 'Reading…');
  await r.rerender(h(SummaryConnectors, { ...ONE, chatId: 'other' }));
  await act(() => codex.requests[5].resolve(page([])));
  await act(() => claude.requests[0].reject(Error('other chat')));
  assert.equal(hint(r.host), 'None');
  await r.unmount();
});

test('a silent read expires, permits a retry, and a late completion cannot replace the retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const read = controlledReads<unknown>();
  installNative(fakeNative({ codex: { api: read.read } }));
  const r = await render(h(SummaryConnectors, ONE));
  await open(r.host);
  await act(() => t.mock.timers.tick(12_000));
  assert.equal(hint(r.host), 'Unavailable');
  await act(() => one(r.host, 'button', 'Retry').click());
  await act(() => read.requests[0].resolve(page([{ name: 'late' }], 'another-page')));
  assert.equal(read.requests.length, 2);
  assert.equal(hint(r.host), 'Reading…');
  await act(() => read.requests[1].reject(Error('offline')));
  assert.equal(hint(r.host), 'Unavailable');
  await act(() => one(r.host, 'button', 'Retry').click());
  await act(() => read.requests[2].resolve(page([])));
  assert.equal(hint(r.host), 'None');
  await act(() => one(r.host, 'button', 'Refresh').click());
  await r.unmount();
  read.requests[3].resolve(page([], 'another-page'));
  await tick();
  assert.equal(read.requests.length, 4);
});

test('malformed inventories and cursors reject, while valid empty responses and optional fields remain usable', async () => {
  const signal = new AbortController().signal;
  for (const value of [null, [], page([null]), page([{ name: 7 }]), page([], 42), page([], 'repeated')]) {
    installNative(fakeNative({ codex: { api: async () => value } }));
    await assert.rejects(loadSessionConnectors('codex', 'chat', 'native', signal), /Invalid connector (status response|pagination cursor)/);
  }
  for (const value of [{}, [null], [{ name: 'missing-status' }]]) {
    installNative(fakeNative({ claude: { control: async () => value } }));
    await assert.rejects(loadSessionConnectors('claude', 'chat', 'native', signal), /Invalid connector status response/);
  }
  for (const value of [
    { ...acpConfig('opencode'), supported: null },
    { ...acpConfig('opencode'), load: 1 },
    { ...acpConfig('opencode'), servers: {} },
    acpConfig('opencode', [null]),
    acpConfig('opencode', [{ name: 'bad' }]),
    acpConfig('opencode', [{ name: 'bad', enabled: true }]),
  ]) {
    installNative(fakeNative({ acp: { ownMcp: async () => value } }));
    await assert.rejects(loadSessionConnectors('acp', 'chat', 'acp:opencode:native', signal), /Invalid harness connector/);
  }
  installNative(
    fakeNative({
      acp: { ownMcp: async () => ({ ...acpConfig('opencode'), load: false, servers: [{ name: 'off', enabled: true, off: false }] }) },
    }),
  );
  assert.deepEqual(await loadSessionConnectors('acp', 'chat', 'wrong', signal), { scope: 'unavailable' });
  assert.deepEqual(await loadSessionConnectors('acp', 'chat', 'acp:other:native', signal), { scope: 'unavailable' });
  assert.deepEqual(await loadSessionConnectors('acp', 'chat', 'acp:opencode:native', signal), {
    scope: 'configuration',
    rows: [{ name: 'off', status: 'Disabled in settings' }],
  });
});
