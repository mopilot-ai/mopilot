// Codex per-thread plugin configuration composes with tool injection and helper-thread policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { ToolSessions } = createRequire(import.meta.url)('../electron/capabilities/contract/session.cjs');
const { CodexToolInjection } = createRequire(import.meta.url)('../electron/capabilities/channels/codexConfig.cjs');

test("the plugin store's part of a thread's config goes on every path, a helper's included", () => {
  const off = { plugins: { 'tidy@mopilot-acme': { enabled: false } } };
  let plugins: object = off;
  const make = (o: object) =>
    new CodexToolInjection({
      sessions: new ToolSessions(),
      command: '/bin/sage-mcp',
      socketPath: '/tmp/s.sock',
      harnessPid: () => 1,
      pluginConfig: () => plugins,
      ...o,
    });
  // with tools
  const tools = make({ hasTools: () => true }).outgoing({ id: 1, method: 'thread/start', params: {} });
  assert.deepEqual(tools.params.config.plugins['tidy@mopilot-acme'], { enabled: false });
  assert.ok(tools.params.config.mcp_servers);
  // without tools, a native thread
  const nativeInj = make({ hasTools: () => false, nativeEnabled: () => true });
  const native = nativeInj.outgoing({ id: 2, method: 'thread/start', params: {} });
  assert.deepEqual(native.params.config.plugins, {
    'unified-computer-use@openai-bundled': { enabled: true },
    'tidy@mopilot-acme': { enabled: false },
  });
  // without tools and not native: only the plugin part, and nothing at all when there is none
  const plain = make({ hasTools: () => false });
  const msg = { id: 3, method: 'thread/start', params: { config: { model: 'm' } } };
  assert.deepEqual(plain.outgoing(msg).params.config, { model: 'm', ...off });
  plugins = {};
  assert.equal(plain.outgoing(msg), msg);
  // a helper thread asks as a helper: the mirror switches the plugin store's plugins off there
  const asked: unknown[] = [];
  const helperInj = make({ hasTools: () => true, pluginConfig: (o: unknown) => (asked.push(o), off) });
  const helper = helperInj.outgoing({ id: 4, method: 'thread/start', params: {} }, { helper: true });
  assert.deepEqual(helper.params.config.plugins['tidy@mopilot-acme'], { enabled: false });
  assert.deepEqual(asked, [{ helper: true }]);
});
