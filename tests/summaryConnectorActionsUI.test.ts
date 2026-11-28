// A session rail connector row's click on each harness (src/components/panels/SummaryConnectorRows.tsx): Connect signs
// in and opens the page, the row then offers Reconnect; Reconnect reaches the harness (Claude Code may hold it for the
// turn); a healthy row opens management; the order is Claude Desktop's and holds still under the pointer.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { act, createElement as h } from 'react';
import './support/dom.ts';
import { tick } from './support/async-scenarios.ts';
import { fakeStore, one, render } from './support/shell-panels-kit.ts';
import { stubStore } from './support/stubs.ts';
import { installNative } from '../src/lib/native.ts';
import { fakeNative } from './support/ports/native.ts';

const store = fakeStore({});
const routes: unknown[] = [];
stubStore({ ...store.exports, navigate: (route: unknown) => routes.push(route) });
const { SummaryConnectors } = await import('../src/components/panels/SummaryConnectors.tsx');
const actions = await import('../src/session/harness/connectorActions.ts');
const order = await import('../src/session/harness/connectorOrder.ts');
const ONE = { chatId: 'chat', cwd: '/project', location: 'local' as const };
const rowsOf = (host: HTMLElement) =>
  [...host.querySelectorAll('.summary-connector')].map((row) => [
    row.querySelector('.summary-label')?.textContent,
    row.querySelector('.summary-hint')?.textContent ?? null,
  ]);
const row = (host: HTMLElement, name: string) => one(host, '.summary-connector', name) as HTMLElement;
const toasts = () => store.calls.filter((c) => c[0] === 'toast').map((c) => c[1]);

async function open(host: HTMLElement) {
  await act(() => {
    const details = one(host, 'details') as HTMLDetailsElement;
    // the fold follows the saved layout: open it as a click on its header does
    if (!details.open) (details.querySelector('summary') as HTMLElement).click();
  });
}

beforeEach(() => {
  routes.length = 0;
  store.calls.length = 0;
  store.set({ segments: {}, accounts: {}, claudeChats: {}, prefs: {}, runtime: {}, conn: 'ready' });
});

test('Claude Code: Connect opens the sign-in page; the CLI finishes it, or a claude.ai page is finished with Reconnect', async () => {
  store.set({ segments: { chat: [{ harness: 'claude', nativeId: 'cc' }] } });
  let servers: unknown[] = [
    { name: 'stripe', status: 'needs-auth' },
    { name: 'gmail', status: 'needs-auth' },
    { name: 'broken', status: 'failed' },
  ];
  let held: unknown = { waiting: [], reconnecting: [] };
  let signIn: (value: unknown) => void = () => {};
  const answers: Record<string, () => unknown> = {
    mcpStatus: () => servers,
    mcpQueued: () => held,
    authenticateMcp: () => new Promise((resolve) => (signIn = resolve)),
    reconnectMcp: () => ({ queued: true }),
  };
  const port = fakeNative({ claude: { control: async (_id: string, method: string) => answers[method]() } });
  installNative(port);
  const signIns = () => port.callsTo('claude.control').filter((c) => c[1] === 'authenticateMcp').length;
  const r = await render(h(SummaryConnectors, ONE));
  await open(r.host);
  assert.deepEqual(rowsOf(r.host), [
    ['stripe', 'Connect'],
    ['gmail', 'Connect'],
    ['broken', 'Reconnect'],
  ]);
  assert.equal(row(r.host, 'stripe').getAttribute('aria-label'), 'stripe, Connect');

  await act(() => row(r.host, 'stripe').click());
  assert.deepEqual(rowsOf(r.host)[0], ['stripe', 'Opening sign-in…']);
  await act(() => row(r.host, 'stripe').click());
  assert.equal(signIns(), 1, 'a second click waits');
  await act(async () => signIn({ authUrl: 'https://auth.stripe.example/a', callbackExpected: true }));
  assert.deepEqual(port.callsTo('shell.openExternal'), [['https://auth.stripe.example/a']]);
  // the CLI takes the browser's answer itself; pressing again starts the sign-in over
  assert.deepEqual(rowsOf(r.host)[0], ['stripe', 'Finish in browser']);
  assert.match(row(r.host, 'stripe').title, /Click to start again/);
  await act(() => row(r.host, 'stripe').click());
  assert.equal(signIns(), 2);
  await act(async () => signIn({ authUrl: 'https://auth.stripe.example/b', callbackExpected: true }));

  // a claude.ai connector's page has no callback to this app: the row then reconnects
  await act(() => row(r.host, 'gmail').click());
  await act(async () => signIn({ authUrl: 'https://claude.ai/connect/gmail' }));
  assert.deepEqual(rowsOf(r.host)[1], ['gmail', 'Reconnect']);
  assert.match(row(r.host, 'gmail').title, /then click to reconnect/);
  // coming back from the browser reads the status again; rows still signing in keep their place
  await act(() => window.dispatchEvent(new Event('focus')));
  await tick();
  assert.deepEqual(rowsOf(r.host).slice(0, 2), [
    ['stripe', 'Finish in browser'],
    ['gmail', 'Reconnect'],
  ]);
  held = { waiting: ['gmail'], reconnecting: [] };
  await act(() => row(r.host, 'gmail').click());
  await tick();
  assert.deepEqual(
    port.callsTo('claude.control').filter((c) => c[1] === 'reconnectMcp'),
    [['cc', 'reconnectMcp', { name: 'gmail', afterTurn: true }]],
  );
  assert.deepEqual(rowsOf(r.host)[1], ['gmail', 'Reconnects when this turn finishes']);
  await act(() => row(r.host, 'gmail').click());
  assert.equal(port.callsTo('claude.control').filter((c) => c[1] === 'reconnectMcp').length, 1, 'a held reconnect waits');
  // after the turn main says it is reconnecting, then that it finished
  held = { waiting: [], reconnecting: ['gmail'] };
  await act(() => port.emit('claude.onEvent', { key: 'cc', kind: 'mcpChanged' }));
  await tick();
  assert.deepEqual(rowsOf(r.host)[1], ['gmail', 'Reconnecting…']);

  // a row that connected drops what its click started: when it needs sign-in again, it starts with Connect
  held = { waiting: [], reconnecting: [] };
  servers = [{ name: 'stripe', status: 'connected' }];
  await act(() => window.dispatchEvent(new Event('focus')));
  await tick();
  assert.deepEqual(rowsOf(r.host), [['stripe', null]]);
  servers = [{ name: 'stripe', status: 'needs-auth' }];
  await act(() => window.dispatchEvent(new Event('focus')));
  await tick();
  assert.deepEqual(rowsOf(r.host), [['stripe', 'Connect']]);

  // a server that turns out to need no sign-in just reads its status again
  const reads = port.callsTo('claude.control').filter((c) => c[1] === 'mcpStatus').length;
  answers.authenticateMcp = () => ({ callbackExpected: false });
  await act(() => row(r.host, 'stripe').click());
  await tick();
  assert.ok(port.callsTo('claude.control').filter((c) => c[1] === 'mcpStatus').length > reads);
  assert.equal(port.callsTo('shell.openExternal').length, 3);
  assert.deepEqual(routes, []);
  await r.unmount();
});

test('Claude Code: a session that stopped, or a refused reconnect, says why and the row can be pressed again', async () => {
  store.set({ segments: { chat: [{ harness: 'claude', nativeId: 'cc' }] } });
  const answers: Record<string, () => unknown> = {
    mcpStatus: () => [
      { name: 'a', status: 'needs-auth' },
      { name: 'b', status: 'failed' },
    ],
    mcpQueued: () => Promise.reject(new Error('old main')),
    authenticateMcp: () => null,
    reconnectMcp: () => Promise.reject(new Error('busy')),
  };
  installNative(fakeNative({ claude: { control: async (_id: string, method: string) => answers[method]() } }));
  const r = await render(h(SummaryConnectors, ONE));
  await open(r.host);
  assert.equal(one(r.host, '.summary-connector-hint').textContent, '2 to reconnect', 'not knowing what waits is not a failed read');
  await act(() => row(r.host, 'a').click());
  await tick();
  await act(() => row(r.host, 'b').click());
  await tick();
  assert.deepEqual(toasts(), ["Couldn't sign in to a: This session's agent isn't running.", "Couldn't reconnect b: busy"]);
  assert.deepEqual(rowsOf(r.host), [
    ['a', 'Connect'],
    ['b', 'Reconnect'],
  ]);
  await r.unmount();
});

test('Codex: Connect signs in for this thread, a failed sign-in is said, and Reconnect reloads the servers', async () => {
  store.set({ segments: { chat: [{ harness: 'codex', nativeId: 'thread-1' }] } });
  let data: unknown[] = [
    { name: 'linear', runtimeStatus: 'authenticationRequired' },
    { name: 'down', runtimeStatus: 'failed' },
    { name: 'docs', runtimeStatus: 'connected' },
  ];
  let login: unknown = { authorizationUrl: 'https://linear.example/oauth' };
  const port = fakeNative({
    codex: {
      api: async () => ({ data, nextCursor: null }),
      request: async (method: string) => (method === 'mcpServer/oauth/login' ? login : null),
    },
  });
  installNative(port);
  const r = await render(h(SummaryConnectors, ONE));
  await open(r.host);
  const done = (params: unknown) =>
    act(() => port.emit('codex.onItem', { kind: 'notification', method: 'mcpServer/oauthLogin/completed', params }));
  await act(() => row(r.host, 'linear').click());
  await tick();
  assert.deepEqual(port.callsTo('codex.request')[0], ['mcpServer/oauth/login', { name: 'linear', threadId: 'thread-1' }]);
  assert.deepEqual(port.callsTo('shell.openExternal'), [['https://linear.example/oauth']]);
  assert.deepEqual(rowsOf(r.host)[0], ['linear', 'Finish in browser']);

  // the end of another thread's sign-in, or of a server this rail didn't start, changes nothing here
  await done({ name: 'linear', threadId: 'another-thread', success: false });
  await done({ name: 'down', success: false });
  await done(null);
  await act(() => port.emit('codex.onItem', { kind: 'notification', method: 'thread/tokenUsage/updated', params: { name: 'linear' } }));
  assert.deepEqual(toasts(), []);
  await done({ name: 'linear', threadId: 'thread-1', success: false, error: 'access denied' });
  await tick();
  assert.deepEqual(toasts(), ["Couldn't sign in to linear: access denied"]);
  assert.deepEqual(rowsOf(r.host)[0], ['linear', 'Connect']);
  await act(() => row(r.host, 'linear').click());
  await tick();
  await done({ name: 'linear', success: false });
  await tick();
  assert.deepEqual(toasts().at(-1), "Couldn't sign in to linear: the sign-in did not finish");
  await act(() => row(r.host, 'linear').click());
  await tick();
  const reads = port.callsTo('codex.api').length;
  data = [{ name: 'linear', runtimeStatus: 'connected' }];
  await done({ name: 'linear', threadId: 'thread-1', success: true });
  await tick();
  assert.equal(port.callsTo('codex.api').length, reads + 1, 'a finished sign-in reads the list again');
  assert.deepEqual(rowsOf(r.host), [['linear', null]]);

  data = [{ name: 'down', runtimeStatus: 'failed' }];
  await act(() => window.dispatchEvent(new Event('focus')));
  await tick();
  await act(() => row(r.host, 'down').click());
  await tick();
  assert.deepEqual(port.callsTo('codex.request').at(-1), ['config/mcpServer/reload', {}]);

  data = [{ name: 'bad', authStatus: 'notLoggedIn' }];
  login = { authorizationUrl: 'javascript:alert(1)' };
  await act(() => window.dispatchEvent(new Event('focus')));
  await tick();
  await act(() => row(r.host, 'bad').click());
  await tick();
  assert.deepEqual(toasts().at(-1), "Couldn't sign in to bad: The server did not provide a valid sign-in page.");
  assert.equal(port.callsTo('shell.openExternal').length, 3);
  await r.unmount();
});

test('a harness without live state opens its settings from any row', async () => {
  store.set({ segments: { chat: [{ harness: 'acp:opencode', nativeId: 'acp:opencode:x' }] } });
  installNative(
    fakeNative({
      acp: {
        ownMcp: async () => ({ harness: 'opencode', supported: true, load: true, servers: [{ name: 'one', enabled: true, off: false }] }),
      },
    }),
  );
  const r = await render(h(SummaryConnectors, ONE));
  await open(r.host);
  await act(() => row(r.host, 'one').click());
  assert.deepEqual(routes, [{ name: 'settings', section: 'other-harnesses', tab: 'harness:opencode' }]);
  await assert.rejects(actions.signInConnector('acp', 'acp:opencode:x', 'one'), /can't sign in/);
  await assert.rejects(actions.reconnectConnector('acp', 'acp:opencode:x', 'one'), /can't reconnect/);
  assert.deepEqual(await actions.heldReconnects('codex', 'thread'), { waiting: [], reconnecting: [] });
  await r.unmount();
});

test('used servers come first, a failing one is always shown, and the order holds under the pointer', async () => {
  const used = [
    { type: 'dynamicToolCall', tool: 'mcp__claude_ai_Gmail__search' },
    { type: 'mcpToolCall', server: 'github' },
    { type: 'other' },
  ];
  store.set({
    segments: { chat: [{ harness: 'claude', nativeId: 'cc' }] },
    runtime: { chat: { turns: [{ items: used }] } },
  });
  let servers: unknown[] = [
    { name: 'a', status: 'connected' },
    { name: 'b', status: 'connected' },
    { name: 'off', status: 'disabled' },
    { name: 'github', status: 'connected' },
    { name: 'claude.ai Gmail', status: 'connected' },
    { name: 'late', status: 'failed' },
  ];
  installNative(fakeNative({ claude: { control: async (_id: string, method: string) => (method === 'mcpStatus' ? servers : []) } }));
  const r = await render(h(SummaryConnectors, ONE));
  await open(r.host);
  // Gmail and github were used, in that order; the failing server moves up into the third place
  assert.deepEqual(
    rowsOf(r.host).map(([name]) => name),
    ['claude.ai Gmail', 'github', 'late'],
  );
  const list = one(r.host, '.summary-connector-list') as HTMLElement;
  await act(() => list.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true })));
  await act(() => list.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true })));
  servers = [{ name: 'new', status: 'needs-auth' }, ...servers];
  await act(() => window.dispatchEvent(new Event('focus')));
  await tick();
  assert.deepEqual(
    rowsOf(r.host).map(([name]) => name),
    ['claude.ai Gmail', 'github', 'late'],
    'a row the pointer is over stays where it is',
  );
  await act(() => list.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true, relatedTarget: row(r.host, 'github') })));
  assert.equal(rowsOf(r.host)[0][0], 'claude.ai Gmail', 'focus moving inside the list keeps the order');
  await act(() => list.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })));
  await act(() => list.dispatchEvent(new window.PointerEvent('pointerout', { bubbles: true })));
  assert.deepEqual(
    rowsOf(r.host).map(([name]) => name),
    ['claude.ai Gmail', 'github', 'new'],
  );
  await r.unmount();
});

test('the order rules on their own', () => {
  const row = (name: string, state: string) => ({ name, status: state, state }) as never;
  assert.equal(order.toolPrefix('claude.ai Google Drive'), 'claude_ai_Google_Drive');
  assert.deepEqual(
    order.usedServers([
      {
        items: [
          { type: 'dynamicToolCall', tool: 'Read' },
          { type: 'mcpToolCall', server: 'a b', tool: 't' },
        ],
      },
      {},
    ] as never),
    ['a_b__t'],
  );
  const rows = [row('h1', 'connected'), row('h2', 'connected'), row('h3', 'connected'), row('x', 'unavailable'), row('f', 'attention')];
  assert.deepEqual(
    order.orderConnectors(rows, []).map((r: { name: string }) => r.name),
    ['f', 'h1', 'h2', 'h3', 'x'],
  );
  assert.deepEqual(
    order.orderConnectors(rows, ['h3__t', 'h2__t', 'h1__t']).map((r: { name: string }) => r.name),
    ['h3', 'h2', 'f', 'h1', 'x'],
  );
  // a server whose own name holds `__` still matches its calls
  assert.deepEqual(
    order.orderConnectors([row('x', 'connected'), row('a__b', 'connected')], ['a__b__tool']).map((r: { name: string }) => r.name),
    ['a__b', 'x'],
  );
});

test('a stopped session, an odd waiting list and an unknown status are said plainly', async () => {
  store.set({ segments: { chat: [{ harness: 'claude', nativeId: 'cc' }] } });
  const answers: Record<string, () => unknown> = {
    mcpStatus: () => [
      { name: 'gone', status: 'failed' },
      { name: 'new-cli', status: 'rebooting' },
    ],
    mcpQueued: () => ({ not: 'a list' }),
    reconnectMcp: () => null,
  };
  installNative(fakeNative({ claude: { control: async (_id: string, method: string) => answers[method]() } }));
  const r = await render(h(SummaryConnectors, ONE));
  await open(r.host);
  assert.deepEqual(rowsOf(r.host), [
    ['gone', 'Reconnect'],
    ['new-cli', 'Unavailable'],
  ]);
  await act(() => row(r.host, 'gone').click());
  await tick();
  assert.deepEqual(toasts(), ["Couldn't reconnect gone: This session's agent isn't running."]);
  assert.deepEqual(await actions.heldReconnects('claude', 'cc'), { waiting: [], reconnecting: [] });
  await r.unmount();
});
