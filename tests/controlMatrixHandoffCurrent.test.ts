// Current-segment handoff contracts: channels, presented tool names and retirement while Chrome opens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/', 'shared/'];
const require = createRequire(import.meta.url);
const { chatHandoffRoute, chromeHandoff } = require('../electron/capabilities/browser/handoff.cjs');
const { ControllerPlans, planInputs } = require('../electron/session/controllerPlan.cjs');
const { continueMessage } = require('../shared/chromeHandoff.mjs');
const { EventEmitter } = require('node:events');
const { SessionMcp } = require('../electron/capabilities/channels/sessionMcp.cjs');
const { controllerPlanInputs } = require('../electron/app/controllerPlanInputs.cjs');

test('own Chrome handoffs require the current segment channel and exact tools', () => {
  const options = {
    plan: { bu: null },
    relay: { kind: 'extension', toolsOn: () => true },
    isEnabled: () => true,
    channel: 'builtin',
    channelEnabled: false,
    tools: ['chrome_tabs_context_mcp', 'chrome_navigate', 'sage_browser_snapshot'],
  };
  assert.equal(chatHandoffRoute(options), 'none');
  assert.equal(chatHandoffRoute({ ...options, channelEnabled: true }), 'extension');
  assert.equal(chatHandoffRoute({ ...options, channelEnabled: true, tools: [] }), 'none');
  assert.equal(chatHandoffRoute({ ...options, channelEnabled: true, tools: ['chrome_navigate'] }), 'none');
});

test('fresh snapshots use loaded session inventory and harness presentation instead of cached plans', () => {
  let names = ['chrome_tabs_context_mcp', 'chrome_navigate'];
  let kind = 'claude';
  const inputs = planInputs({
    tools: () => names,
    yourChrome: () => false,
    claude: { channel: () => true, nativeChromeOf: () => false, nativeChromeFor: () => false, toolsOf: () => names },
    codex: { channel: () => true, loadedPath: () => null, nativeSurfaces: () => ({}), iabAvailable: () => false },
    acp: { channel: () => true },
  });
  const plans = new ControllerPlans({
    inputs,
    ref: () => ({ kind, key: 'segment', id: 'native' }),
    chats: { record: () => ({ meta: { controllerPlan: { key: 'segment', bu: 'mopilot-chrome' } } }) },
  });
  assert.equal(plans.snapshot('chat').chromeToolName, 'mcp__mopilot_chrome__tabs_context_mcp');
  names = [];
  assert.equal(plans.snapshot('chat').plan.bu, null);
  assert.equal(plans.current('chat').bu, 'mopilot-chrome');
  kind = 'acp:opencode';
  assert.equal(plans.snapshot('chat').chromeToolName, 'chrome_tabs_context_mcp');
  kind = 'codex';
  assert.equal(plans.snapshot('chat').chromeToolName, 'chrome_tabs_context_mcp');
  kind = 'unknown';
  assert.equal(plans.snapshot('chat'), null);
});

test('ACP inventory follows the admitted session and its own visibility rule without a real transport', () => {
  const records = new Map();
  const socket = new EventEmitter();
  const channel = new SessionMcp({ sessions: { get: (key: string) => records.get(key) }, socket, command: 'fake' });
  const names = ['chrome_tabs_context_mcp', 'chrome_navigate'];
  assert.equal(channel.toolsOf('acp:key', names), null);
  records.set('acp:key', { hide: (name: string) => name === 'chrome_navigate' });
  assert.deepEqual(channel.toolsOf('acp:key', names), []);
  socket.emit('connected', { key: 'acp:key' });
  assert.deepEqual(channel.toolsOf('acp:key', names), ['chrome_tabs_context_mcp']);
});

test('live plan wiring keeps loaded inventory ahead of newly changed global channel switches', () => {
  const names = ['chrome_tabs_context_mcp', 'chrome_navigate'];
  const live: any = {
    capabilities: { list: () => names.map((name) => ({ name })) },
    codexTools: {
      hasTools: () => false,
      toolsOf: () => names,
      loadedPath: () => ({ chrome: false, computer: false, iab: false, tools: true }),
      iabAvailable: () => false,
      routedSurfaces: () => ({ surfaces: {} }),
    },
    acpTools: { toolsOf: () => [] },
    codexChromeBackends: { serves: () => false, available: () => false },
  };
  const input = controllerPlanInputs({
    live,
    isFlagEnabled: () => false,
    claude: { toolsOf: () => [], nativeChromeOf: () => false, nativeChromeFor: () => false },
    claudeTurns: { accountOf: () => 'account' },
  });
  assert.equal(input({ kind: 'codex', key: 'c', id: 'id' }, 'chat').channel, true);
  assert.deepEqual(input({ kind: 'claude', key: 'c', id: 'id' }, 'chat').tools, []);
  assert.equal(input({ kind: 'acp:kimi', key: 'c', id: 'id' }, 'chat').channel, false);
  live.codexTools.toolsOf = () => null;
  assert.equal(input({ kind: 'codex', key: 'c', id: 'id' }, 'chat').channel, true);
  live.codexTools = null;
  live.acpTools = null;
  assert.equal(input({ kind: 'acp:kimi', key: 'c', id: 'id' }, 'chat').channel, false);
  assert.throws(() => input({ kind: 'codex', key: null, id: null }, 'chat'));
});

test('own Chrome continuation uses canonical names and accepts the receiving presentation', () => {
  assert.match(continueMessage('extension', 'https://site.test'), /call chrome_tabs_context_mcp/);
  assert.match(
    continueMessage('relay', 'https://site.test', 'mcp__mopilot_chrome__tabs_context_mcp'),
    /call mcp__mopilot_chrome__tabs_context_mcp/,
  );
  assert.match(continueMessage('claude-in-chrome', 'https://site.test'), /call tabs_context_mcp/);
});

test('opening Chrome cannot publish a moved sign-in after the segment changes', async () => {
  let release: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let segment = 'one';
  const moved: unknown[] = [];
  const run = chromeHandoff({
    getPrefs: () => ({}),
    browserWindows: { owned() {} },
    route: () => 'extension',
    owner: () => segment,
    openSite: () => pending,
    signinMoved: (...args: unknown[]) => moved.push(args),
  })({ chatId: 'chat', url: 'https://site.test' });
  segment = 'two';
  release!();
  assert.equal((await run).ok, false);
  assert.deepEqual(moved, []);
});

test('prospective own Codex Chrome also requires the current native browser surface', () => {
  let chrome = false;
  const input = planInputs({
    tools: () => [],
    yourChrome: () => false,
    codex: {
      channel: () => false,
      loadedPath: () => null,
      nativeSurfaces: () => ({ chrome }),
      iabAvailable: () => false,
      chromeBackend: () => ({ available: () => true }),
    },
  });
  assert.equal(input({ kind: 'codex', id: null, key: null }, 'chat').ownChrome, false);
  chrome = true;
  assert.equal(input({ kind: 'codex', id: null, key: null }, 'chat').ownChrome, true);
});

test('handoff defaults, page ownership and overlapping open completions retain their own pending entry', async () => {
  assert.equal(
    chatHandoffRoute({
      plan: null,
      relay: null,
      isEnabled: () => true,
      channel: 'builtin',
      channelEnabled: true,
      tools: ['sage_browser_snapshot'],
    }),
    'your-chrome',
  );
  const wait: (() => void)[] = [];
  let checks = 0;
  const windows = {
    owned() {
      checks++;
    },
  };
  const handoff = chromeHandoff({
    browserWindows: windows,
    getPrefs: () => ({}),
    route: () => 'extension',
    openSite: () => new Promise<void>((resolve) => wait.push(resolve)),
  });
  const a = handoff({ chatId: 'overlap', webContentsId: 10, url: 'https://site.test' });
  const b = handoff({ chatId: 'overlap', webContentsId: 11, url: 'https://site.test' });
  wait[0]();
  assert.equal((await a).ok, true);
  const { cancelChromeHandoff } = require('../electron/capabilities/browser/handoff.cjs');
  assert.equal(cancelChromeHandoff({ browserWindows: windows, chromeChannel: {} }, { chatId: 'overlap', webContentsId: 11 }), true);
  wait[1]();
  assert.equal((await b).cancelled, true);
  assert.equal(checks, 4);
});
