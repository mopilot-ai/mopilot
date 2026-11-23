// Which of Claude's MoPilot tools are loaded up front and which wait behind ToolSearch
// (electron/capabilities/mcp/toolLoading.cjs, sdkMcp.cjs): a fresh chat carried ~190 tool schemas (~130k tokens).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/capabilities/channels/'];

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { sdkMcpServers } = require('../electron/capabilities/mcp/sdkMcp.cjs');
const { isCoreTool, CORE_HOST, CORE_SAGE } = require('../electron/capabilities/mcp/toolLoading.cjs');
const { HOST_SERVERS, HOST_SERVER_NAMES } = require('../electron/capabilities/contract/hostServers.cjs');

const SAGE = 'sage_aaaaaaaaaaaa';
const sdk = {
  tool: (name: string, description: string, schema: unknown, handler: unknown, options: any) => ({ name, options }),
  createSdkMcpServer: (options: any) => options,
};
const z = { fromJSONSchema: (schema: unknown) => schema };

test('isCoreTool: host servers by presented name, the sage server by Registry name', () => {
  assert.equal(isCoreTool('mopilot_browser', 'navigate', true), true);
  assert.equal(isCoreTool('mopilot_browser', 'tabs_mark', true), false);
  assert.equal(isCoreTool('unknown_host', 'navigate', true), false);
  // the task list, wrap-up and request_access wait behind ToolSearch (G11)
  assert.equal(isCoreTool(SAGE, 'update_task_list', false), false);
  assert.equal(isCoreTool(SAGE, 'wrap_up', false), false);
  assert.equal(isCoreTool(SAGE, 'sage_debug_echo', false), true);
  assert.equal(isCoreTool('mopilot_computer', 'request_access', true), false);
  assert.equal(isCoreTool(SAGE, 'clean_up_worktrees', false), false);
});

test('sdkMcp: core tools are always loaded, the rest are deferred, and no server loads all of its tools', () => {
  const registry = new Registry();
  for (const name of [
    'update_task_list',
    'clean_up_worktrees',
    'browser_navigate',
    'browser_tabs_mark',
    'desktop_request_access',
    'desktop_screenshot',
    'desktop_hold_key',
    'start_session',
  ])
    registry.register({
      name,
      description: name,
      schema: { type: 'object', properties: {} },
      policy: 'observe',
      handler: async () => 'ok',
    });
  const servers = sdkMcpServers({ sdk, z, registry, serverName: SAGE, owner: { chatId: 'c', segmentId: 's' } });
  const loaded = new Map<string, boolean>();
  for (const [server, config] of servers as Map<string, any>) {
    assert.equal(config.alwaysLoad, undefined, `${server} loads every tool of the server`);
    for (const t of config.tools) loaded.set(`${server}/${t.name}`, t.options.alwaysLoad);
  }
  assert.deepEqual(Object.fromEntries(loaded), {
    [`${SAGE}/update_task_list`]: false,
    [`${SAGE}/clean_up_worktrees`]: false,
    'mopilot_browser/navigate': true,
    'mopilot_browser/tabs_mark': false,
    [`${SAGE}/start_session`]: false,
    // a turn that has not used the desktop carries none of it, request_access included (G10, G11)
    'mopilot_computer/request_access': false,
    'mopilot_computer/screenshot': false,
    'mopilot_computer/hold_key': false,
  });
});

test('the always-loaded set stays small: a budget, with every host entry on a real host server', () => {
  const core = Object.values(CORE_HOST).flat().length + CORE_SAGE.length;
  assert.ok(core <= 50, `${core} always-loaded tools: each costs ~600 tokens on every turn; defer one before adding`);
  for (const server of Object.keys(CORE_HOST)) assert.ok(HOST_SERVER_NAMES.includes(server), `${server} is not a host server`);
  assert.deepEqual(HOST_SERVERS.length > 0, true);
});
