// MCP settings actions: provenance, account/folder ownership, cancellation and recoverable failures.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount, click, flush, byText, settingsStubs } from './support/harness-ui-kit.ts';
import { mockSource, iconStubs, stubStore } from './support/stubs.ts';
import { claudeMcpCapabilities, mcpConnectionStatus, CLAUDE_CONNECTORS } from '../src/harness/mcpConnection.ts';
import { deferred } from './support/async-scenarios.ts';
import { installNativeStub } from './support/ports/native.ts';

const { createElement: h, act } = await import('react');
let launch: (...args: any[]) => Promise<any>;
let open: (url: string) => Promise<any>;
const calls: any[] = [];
let term: any;
installNativeStub({
  claude: {
    mcpLoginCommand: (...a: any[]) => launch(...a),
    mcp: async (...a: any[]) => {
      calls.push(['remove', ...a]);
    },
  },
  shell: { openExternal: (url: string) => open(url) },
});
stubStore({ toast: () => {} });
mock.module('../src/components/pages/Settings.tsx', { namedExports: settingsStubs });
mockSource('src/components/panels/TerminalPanel.tsx', {
  TermView: (props: any) => {
    term = props;
    return h('div', { 'data-terminal': props.tab.id });
  },
});
mockSource('src/components/ui/icons.tsx', iconStubs());
const { ClaudeMcp } = await import('../src/components/harness/claude/ClaudeMcp.tsx');
const base = {
  bin: '/bin/claude',
  cwd: '/project',
  account: 'account-a',
  mode: 'subscription' as const,
  loaded: true,
  err: null,
  reload: () => calls.push(['reload']),
  servers: [{ name: 'stripe', status: 'needs-auth', source: 'plugin' }],
};
async function setup(props = {}) {
  calls.length = 0;
  term = null;
  launch = async (...a) => {
    calls.push(['launch', ...a]);
    return { command: ['/cli', 'mcp', 'login', 'stripe'], env: { CLAUDE_CONFIG_DIR: '/a' } };
  };
  open = async (url) => {
    calls.push(['open', url]);
  };
  return mount(h(ClaudeMcp, { ...base, ...props }));
}

test('connection status and provenance use explicit capabilities, with safe fallbacks for older CLIs', () => {
  assert.deepEqual(
    ['connected', 'needs-auth', 'failed', 'pending', 'disabled', 'new-status'].map((s) => mcpConnectionStatus(s).label),
    ['Connected', 'Sign-in required', 'Connection failed', 'Connecting…', 'Disabled', 'Unknown status'],
  );
  for (const scope of ['user', 'local', 'project']) {
    const cap = claudeMcpCapabilities({ name: 'claude.ai spoof', status: 'needs-auth', scope });
    assert.equal(cap.removeScope, scope);
    assert.equal(cap.connector, false);
    assert.equal(cap.signIn, true);
  }
  const legacy = claudeMcpCapabilities({ name: 'plugin:foo', status: 'connected' });
  assert.equal(legacy.removeScope, undefined);
  assert.equal(legacy.plugin, false);
  assert.match(legacy.description, /Managed by Claude Code/);
  assert.equal(claudeMcpCapabilities({ name: 'x', status: 'needs-auth', scope: 'user', source: 'sdk' }).removeScope, undefined);
  assert.equal(claudeMcpCapabilities({ name: 'x', status: 'needs-auth', source: 'claudeai' }).signIn, false);
});

test('sign-in pins opaque names and account, embeds the CLI, refreshes on exit, and can be cancelled', async () => {
  const name = 'plugin:stripe:"a:b\\c"';
  const r = await setup({ servers: [{ ...base.servers[0], name }] });
  await click(byText(r.host, 'button', 'Sign in'));
  assert.deepEqual(calls, [['launch', '/bin/claude', name, 'account-a', 'subscription']]);
  assert.deepEqual(term.tab.env, { CLAUDE_CONFIG_DIR: '/a' });
  assert.equal(term.tab.cwd, '/project');
  assert.equal(term.tab.signIn, true);
  assert.equal(byText(r.host, 'button', 'Sign in')!.hasAttribute('disabled'), true);
  await act(async () => term.onExit(0));
  await flush();
  assert.equal(r.host.querySelector('[data-terminal]'), null);
  assert.deepEqual(calls.at(-1), ['reload']);
  assert.equal(r.host.querySelector('[role=alert]'), null);
  await click(byText(r.host, 'button', 'Sign in'));
  await act(async () => term.onExit(1));
  await flush();
  assert.match(r.host.querySelector('[role=alert]')!.textContent!, /did not finish/);
  await click(byText(r.host, 'button', 'Sign in'));
  await click(byText(r.host, 'button', 'Cancel sign-in'));
  assert.equal(r.host.querySelector('[data-terminal]'), null);
  await click(byText(r.host, 'button', 'Sign in'));
  await act(async () => term.onError('Could not launch CLI'));
  await flush();
  assert.match(r.host.querySelector('[role=alert]')!.textContent!, /Could not launch CLI/);
  await r.unmount();
});

test('duplicate sign-in preparation coalesces; failures allow retry and retired results cannot start a terminal', async () => {
  for (const failed of [false, true]) {
    const r = await setup();
    const pending = deferred();
    let starts = 0;
    launch = () => {
      starts++;
      return pending.promise;
    };
    const { reactProps } = await import('./support/harness-ui-kit.ts');
    const action = reactProps(byText(r.host, 'button', 'Sign in')!).onClick;
    await act(async () => {
      action();
      action();
    });
    await flush();
    assert.equal(starts, 1);
    assert.ok(byText(r.host, 'button', 'Starting sign-in…'));
    await r.unmount();
    if (failed) pending.reject(new Error('old error'));
    else pending.resolve({ command: ['/old'] });
    await flush();
    assert.equal(term, null);
  }
  const r = await setup();
  launch = async () => {
    throw new Error('missing CLI');
  };
  await click(byText(r.host, 'button', 'Sign in'));
  assert.match(r.host.querySelector('[role=alert]')!.textContent!, /missing CLI/);
  launch = async () => ({ command: ['/new'] });
  await click(byText(r.host, 'button', 'Sign in'));
  assert.equal(term.tab.env, undefined);
  await r.unmount();
});

test('Claude connectors open their account settings, refresh on return, and show browser failures', async () => {
  const r = await setup({
    servers: [
      { name: 'Gmail', status: 'needs-auth', source: 'claudeai' },
      { name: 'Docs', status: 'connected', scope: 'claudeai' },
    ],
  });
  window.dispatchEvent(new Event('focus'));
  await flush();
  assert.deepEqual(calls, []);
  await click(byText(r.host, 'button', 'Connect in Claude'));
  assert.deepEqual(calls, [['open', CLAUDE_CONNECTORS]]);
  assert.match(r.host.textContent!, /same account/);
  window.dispatchEvent(new Event('focus'));
  await flush();
  assert.deepEqual(calls.at(-1), ['reload']);
  await click(byText(r.host, 'button', 'Refresh status'));
  open = async () => {
    throw new Error('browser blocked');
  };
  await click(byText(r.host, 'button', 'Manage in Claude'));
  assert.match(r.host.querySelector('[role=alert]')!.textContent!, /browser blocked/);
  await r.unmount();
  for (const fail of [false, true]) {
    const r = await setup({ servers: [{ name: 'Gmail', status: 'needs-auth', source: 'claudeai' }] });
    const pending = deferred();
    open = () => pending.promise;
    await click(byText(r.host, 'button', 'Connect in Claude'));
    await r.unmount();
    if (fail) pending.reject(new Error('late browser failure'));
    else pending.resolve();
    await flush();
  }
});
