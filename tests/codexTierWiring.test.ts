// electron/app/agentTools.cjs: main gives the Codex tool injection what the running Codex negotiated (G2, CM-X19). A Codex
// whose app-server reports tool_search_always_defer_mcp_tools on defers MCP tools itself and keeps the full list; any
// other answer, or none yet, tiers its threads. Over a fake Electron (tests/support/electron-main-harness.ts).
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain, unloadMain } from './support/electron-main-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
after(() => unloadMain());

test("main reads a Codex thread's tiers from the negotiated feature flags of the Codex that runs it", async () => {
  const h = await loadMain();
  await h.ready();
  const defers = h.one('CodexToolInjection').opts.defersMcpTools;
  const codex = h.one('CodexAdapter');
  for (const [negotiated, want] of [
    [undefined, false],
    [{ flags: {} }, false],
    [{ flags: { 'features.tool_search_always_defer_mcp_tools': false } }, false],
    [{ flags: { 'features.tool_search_always_defer_mcp_tools': true } }, true],
  ] as const) {
    codex.negotiated = negotiated;
    assert.equal(defers(), want, JSON.stringify(negotiated));
  }
});
