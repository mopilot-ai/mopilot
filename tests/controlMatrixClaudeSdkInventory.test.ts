// Claude's exact SDK server inventory follows the shared Chrome defaults and controller ownership without starting a provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/capabilities/', 'electron/platform/flags.cjs', 'shared/'];

const require = createRequire(import.meta.url);
const { DEFAULTS } = require('../electron/platform/flags.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { ToolVisibility } = require('../electron/capabilities/visibility.cjs');
const { injectSdkMcpServers, autoAllow } = require('../electron/capabilities/mcp/sdkMcp.cjs');

const SAGE = 'sage_aaaaaaaaaaaa';
// The SDK boundary is inert: no provider, subprocess, socket or app is started.
const sdk = {
  tool: (name: string, description: string, schema: unknown, handler: unknown, options: unknown) => ({
    name,
    description,
    schema,
    handler,
    options,
  }),
  createSdkMcpServer: (options: unknown) => options,
};
const z = { fromJSONSchema: (schema: unknown) => schema };

function inventory({ shipped = true, nativeChrome = false, yourChrome = false, over = {} as Record<string, boolean> } = {}) {
  const registry = new Registry();
  for (const name of ['sage_debug_echo', 'browser_navigate', 'desktop_screenshot', 'chrome_navigate']) {
    registry.register({
      name,
      description: name,
      policy: 'observe',
      schema: { type: 'object', properties: {} },
      handler: () => assert.fail('inventory checks must not execute a tool'),
    });
  }
  const visibility = new ToolVisibility({
    registry,
    isEnabled: (key: string) => over[key] ?? DEFAULTS[key] ?? false,
    chromeShipped: shipped,
    drivesUserChrome: () => yourChrome,
  });
  const options: any = {};
  const result = injectSdkMcpServers(options, {
    sdk,
    z,
    registry,
    serverName: SAGE,
    owner: { chatId: 'chat', segmentId: 'segment' },
    hide: visibility.forHost({ nativeChrome }),
  });
  return { ...result, options };
}

test('CM-Z32: default Claude SDK inventory includes Chrome beside sage, browser and computer (#1544)', () => {
  const result = inventory();
  const expected = [SAGE, 'mopilot_browser', 'mopilot_computer', 'mopilot_chrome'];
  assert.deepEqual(result.servers, expected);
  assert.deepEqual(Object.keys(result.options.mcpServers), expected);
  // a server-level alwaysLoad would load every tool of the server: the core tools carry the flag one by one
  for (const server of Object.values(result.options.mcpServers) as any[]) assert.equal(server.alwaysLoad, undefined);
  assert.deepEqual(
    [...result.tools],
    [
      `mcp__${SAGE}__sage_debug_echo`,
      'mcp__mopilot_browser__navigate',
      'mcp__mopilot_computer__screenshot',
      'mcp__mopilot_chrome__navigate',
    ],
  );
  assert.deepEqual(autoAllow(result.tools, `mcp__${SAGE}__sage_debug_echo`, {}), { behavior: 'allow', updatedInput: {} });
  assert.equal(autoAllow(result.tools, 'mcp__sage__sage_debug_echo', {}), null, 'a repository sage server still needs approval');
  assert.equal(autoAllow(result.tools, 'mcp__mopilot_chrome__unregistered', {}), null, 'only injected tools are auto-allowed');
});

for (const [name, mode] of [
  ['default off', { over: { 'shared.browser.chromeExtensionByDefault': false } }],
  ['extension not shipped', { shipped: false }],
  ['native Chrome controller', { nativeChrome: true }],
  ['Your Chrome channel', { yourChrome: true }],
] as const) {
  test(`CM-Z32: Claude SDK inventory leaves Chrome out for ${name}`, () => {
    const result = inventory(mode);
    const expected = [SAGE, 'mopilot_browser', 'mopilot_computer'];
    assert.deepEqual(result.servers, expected);
    assert.deepEqual(Object.keys(result.options.mcpServers), expected);
    assert.equal(autoAllow(result.tools, 'mcp__mopilot_chrome__navigate', {}), null);
    assert.equal(autoAllow(result.tools, 'mcp__sage__sage_debug_echo', {}), null);
  });
}

test('CM-Z32: an explicit Chrome switch serves its SDK channel even with the default off and extension unshipped', () => {
  const result = inventory({
    shipped: false,
    over: { 'shared.browser.chromeExtensionByDefault': false, 'shared.browser.chromeRelay': true },
  });
  assert.deepEqual(result.servers, [SAGE, 'mopilot_browser', 'mopilot_computer', 'mopilot_chrome']);
});
