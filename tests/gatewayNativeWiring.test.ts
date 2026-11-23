// Main hands Claude Code the MCP gateway's deny entries through the tools object agentTools.cjs passes every session (gatewayDenials), read from main's gateway at each session's start (#2999 C4): before the gateway opens, or without one, there are none and every session keeps its own servers. Codex, a basic harness and the plugin delivery get theirs from gatewayWiring.cjs (tests/gatewayIpc.test.ts). Over a fake Electron (tests/support/electron-main-harness.ts).
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain, unloadMain } from './support/electron-main-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
after(() => unloadMain());

test('main gives Claude Code’s sessions the gateway’s deny entries; with no gateway open, there are none', async () => {
  const h = await loadMain();
  await h.ready();
  const tools = h.claude.setTools.mock.calls.at(-1).arguments[0];
  assert.equal(typeof tools.gatewayDenials, 'function');
  assert.deepEqual(tools.gatewayDenials(), []);
});
