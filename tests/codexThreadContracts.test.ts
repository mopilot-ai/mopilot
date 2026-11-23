// Pure thread configuration contracts, their public re-exports and platform environment stay separate from injection lifecycle tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { codexThreadConfig, mergeConfig } = require('../electron/capabilities/channels/codexConfig.cjs');
const { sageMcpEnv } = require('../electron/capabilities/channels/sessionMcp.cjs');

test('thread entrypoint retains contract identities and an explicitly enabled user node_repl', () => {
  const entry = require('../electron/capabilities/channels/codexConfig.cjs');
  const contracts = require('../electron/capabilities/channels/codexThreadContracts.cjs');
  for (const [name, value] of Object.entries(contracts)) assert.equal(entry[name], value, name);
  assert.deepEqual(entry.nativeControlOff({ userServers: ['node_repl'], disableUserNodeRepl: false }), {
    mcp_servers: {},
    plugins: { [entry.NATIVE_CUA_PLUGIN]: { enabled: false } },
  });
});

test('the fragment adds sage_<nonce>, approves its tools and turns off native cua_repl', () => {
  assert.deepEqual(
    codexThreadConfig({ serverName: 'sage_0123456789ab', command: '/bin/sage-mcp', socketPath: '/tmp/s.sock', token: 'tok' }),
    {
      mcp_servers: {
        sage_0123456789ab: {
          command: '/bin/sage-mcp',
          args: [],
          env: sageMcpEnv({ socketPath: '/tmp/s.sock', token: 'tok' }),
          default_tools_approval_mode: 'approve',
          tool_timeout_sec: 900,
        },
      },
      plugins: { 'unified-computer-use@openai-bundled': { enabled: false } },
    },
  );
});

test("node_repl is turned off only where the user's config defines it (X14)", () => {
  const args = { serverName: 'sage_0123456789ab', command: '/bin/sage-mcp', socketPath: '/tmp/s.sock', token: 'tok' };
  assert.deepEqual(codexThreadConfig({ ...args, userServers: ['node_repl', 'mine'] }).mcp_servers.node_repl, { enabled: false });
  // without a server to switch off, Codex rejects the override ("invalid transport")
  assert.equal('node_repl' in codexThreadConfig({ ...args, userServers: ['mine'] }).mcp_servers, false);
  assert.equal('node_repl' in codexThreadConfig(args).mcp_servers, false);
});

test('merging keeps the config a window already sends', () => {
  const base = { model: 'm', mcp_servers: { mine: { command: 'x' } }, plugins: { other: { enabled: true } } };
  const out = mergeConfig(base, { mcp_servers: { sage_x: { command: 'y' } }, plugins: { p: { enabled: false } } });
  assert.deepEqual(out, {
    model: 'm',
    mcp_servers: { mine: { command: 'x' }, sage_x: { command: 'y' } },
    plugins: { other: { enabled: true }, p: { enabled: false } },
  });
  assert.deepEqual(base.mcp_servers, { mine: { command: 'x' } });
  assert.deepEqual(mergeConfig(undefined, { a: 1 }), { a: 1 });
});

test('the fragment never pre-approves or switches off codex_apps; node_repl goes off only where configured (X14)', () => {
  const { CODEX_APPS_SERVER } = require('../electron/capabilities/channels/codexConfig.cjs');
  const f = codexThreadConfig({ serverName: 'sage_0123456789ab', command: '/bin/sage-mcp', socketPath: '/tmp/s.sock', token: 'tok' });
  assert.deepEqual(Object.keys(f.mcp_servers), ['sage_0123456789ab']);
  assert.equal(JSON.stringify(f).includes(CODEX_APPS_SERVER), false);
});
