// Where MoMo's MCP proxy gets its servers and how it starts them (#2999 C0): the read-only catalog (electron/gateway/catalog.cjs) over plugin servers, Claude Code's .claude.json and Codex's config.toml (SSE and malformed entries left out, missing or broken files listing nothing); main's sources for it (electron/app/momoMcpSources.cjs); the sealed allowlist (allowlist.cjs) and its damaged-file shape; and the client (client.cjs) starting a real stdio server with only its declared env, PATH and HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe, scratch } from './support/momo-fixtures.ts';

const require = createRequire(import.meta.url);
const { readCatalog, launchOf } = require('../electron/gateway/catalog.cjs');
const { momoMcpSources } = require('../electron/app/momoMcpSources.cjs');
const { McpAllowlist, toolOn } = require('../electron/momo/mcp/allowlist.cjs');
const { connectServer, serverEnv } = require('../electron/gateway/client.cjs');

const SERVER = path.resolve('tests/fixtures/mcp/notes-server.cjs');

test('catalog: plugin servers, then Claude Code, then Codex; SSE and malformed entries left out', async () => {
  const dir = scratch();
  fs.mkdirSync(dir, { recursive: true });
  const claudeConfig = path.join(dir, '.claude.json');
  const codexConfig = path.join(dir, 'config.toml');
  fs.writeFileSync(
    claudeConfig,
    JSON.stringify({
      mcpServers: {
        notes: { command: 'node', args: ['s.js', 1], env: { A: 'x', N: 2 } },
        web: { type: 'http', url: 'https://mcp.example/x', headers: { Authorization: 'Bearer ${T}' } },
        old: { type: 'sse', url: 'https://mcp.example/sse' },
        broken: { type: 'http' },
        ftp: { url: 'ftp://x' },
      },
    }),
  );
  fs.writeFileSync(
    codexConfig,
    '[mcp_servers.docs]\ncommand = "docs"\n\n[mcp_servers.remote]\nurl = "https://r.example/mcp"\nhttp_headers = { X = "1" }\n',
  );
  const plugins = async () => [{ id: 'kit@local', servers: { kit: { type: 'stdio', command: 'kit' } } }];
  const all = await readCatalog({ plugins, claudeConfig, codexConfig });
  assert.deepEqual(
    all.map((e: any) => [e.key, e.from, e.launch]),
    [
      ['plugin:kit@local/kit', 'the kit@local plugin', { type: 'stdio', command: 'kit', args: [], env: {} }],
      ['claude:notes', 'Claude Code', { type: 'stdio', command: 'node', args: ['s.js', '1'], env: { A: 'x' } }],
      ['claude:web', 'Claude Code', { type: 'http', url: 'https://mcp.example/x', headers: { Authorization: 'Bearer ${T}' } }],
      ['codex:docs', 'Codex', { type: 'stdio', command: 'docs', args: [], env: {} }],
      ['codex:remote', 'Codex', { type: 'http', url: 'https://r.example/mcp', headers: { X: '1' } }],
    ],
  );
  assert.equal(launchOf(null), null);
  // missing files list nothing; a file that doesn't parse lists nothing
  // a plugin store that can't be read hides only the plugins' servers
  const noPlugins = await readCatalog({
    plugins: async () => {
      throw new Error('store gone');
    },
    claudeConfig,
    codexConfig,
  });
  assert.equal(noPlugins[0].key, 'claude:notes');
  const none = await readCatalog({
    plugins: async () => [],
    claudeConfig: path.join(dir, 'nope.json'),
    codexConfig: path.join(dir, 'nope.toml'),
  });
  assert.deepEqual(none, []);
  fs.writeFileSync(claudeConfig, '{ not json');
  assert.deepEqual(await readCatalog({ plugins: async () => [], claudeConfig, codexConfig: dir }), []);
});

test("main's sources: plugin store servers (the ACP plan's, else the spec's), CLAUDE_CONFIG_DIR and CODEX_HOME", async () => {
  const store = {
    enabledFor: async (f: string) => {
      assert.equal(f, 'acp');
      return {
        deliver: [
          { id: 'a', spec: { execution: { plans: { acp: { mcpServers: { x: {} } } } } } },
          { id: 'b', spec: { mcpServers: { y: {} } } },
          { id: 'c', spec: {} },
          { id: 'd', spec: { execution: {}, mcpServers: { z: {} } } },
        ],
      };
    },
  };
  const s = momoMcpSources({ env: { CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/x' }, home: '/h', store });
  assert.deepEqual(await s.plugins(), [
    { id: 'a', servers: { x: {} } },
    { id: 'b', servers: { y: {} } },
    { id: 'c', servers: {} },
    { id: 'd', servers: { z: {} } },
  ]);
  assert.equal(s.claudeConfig, path.join('/c', '.claude.json'));
  assert.equal(s.codexConfig, path.join('/x', 'config.toml'));
  const home = scratch();
  const d = momoMcpSources({ env: {}, home });
  assert.equal(d.claudeConfig, path.join(home, '.claude.json'));
  assert.equal(d.codexConfig, path.join(home, '.codex', 'config.toml'));
  // with no store given, the plugin store under that home: none installed
  assert.deepEqual(await d.plugins(), []);
});

test('allowlist: allow keeps choices, setTool, remove, erase; a damaged file keeps only what is whole', async () => {
  const dir = scratch();
  const a = new McpAllowlist({ dir, safeStorage: fakeSafe(), now: () => 7 });
  assert.deepEqual(a.list(), {});
  await a.setTool('k', 't', true);
  assert.equal(a.get('k'), null);
  await a.allow('k', [
    { key: 't#1', readOnly: true },
    { key: 'u#1', readOnly: false },
  ]);
  assert.deepEqual(a.get('k'), { allowedAt: 7, baseline: { 't#1': { readOnly: true }, 'u#1': { readOnly: false } }, choices: {} });
  await a.setTool('k', 'u#1', true);
  await a.allow('k', [{ key: 't#1', readOnly: true }]);
  assert.deepEqual(a.get('k').choices, { 'u#1': true });
  assert.throws(() => a.setTool('k', 'u#1', 'yes'), /turned on or off/);
  const e = a.get('k');
  assert.equal(toolOn(e, { key: 't#1', readOnly: true }), true);
  assert.equal(toolOn(e, { key: 't#1', readOnly: false }), false);
  assert.equal(toolOn(e, { key: 'u#1', readOnly: false }), true);
  assert.equal(toolOn(e, { key: 'new#1', readOnly: true }), false);
  await a.remove('k');
  assert.equal(a.get('k'), null);
  await a.allow('k', []);
  await a.erase();
  assert.deepEqual(new McpAllowlist({ dir, safeStorage: fakeSafe() }).list(), {});
  // damaged parts: dropped, not guessed at
  const b = new McpAllowlist({ dir: scratch(), safeStorage: fakeSafe() });
  await b.store.change((all: any) => {
    all.ok = { allowedAt: 1, baseline: { a: { readOnly: true }, b: { readOnly: 'yes' } }, choices: { a: false, b: 'no' } };
    all.bad = { baseline: {} };
    all.junk = 'x';
  });
  assert.deepEqual(b.list(), { ok: { allowedAt: 1, baseline: { a: { readOnly: true } }, choices: { a: false } } });
});

test('client: a stdio server runs with only its declared env (filled from ${VAR}), PATH and HOME; never our secrets', async () => {
  const env = serverEnv({ A: '${X}', B: '${MISSING:-dflt}', C: '${MISSING}', D: 'plain' }, { X: 'x', PATH: '/bin', SECRET_KEY: 's' });
  assert.equal(env.A, 'x');
  assert.equal(env.B, 'dflt');
  assert.equal(env.C, '');
  assert.equal(env.D, 'plain');
  assert.equal(env.PATH, '/bin');
  assert.equal('SECRET_KEY' in env, false);
  assert.equal(serverEnv({}, {}).PATH, '');
  process.env.MOMO_TEST_PROVIDER_KEY = 'sk-should-not-pass';
  process.env.MOMO_TEST_TOKEN = 'tok';
  try {
    const client = await connectServer({ type: 'stdio', command: process.execPath, args: [SERVER], env: { TOKEN: '${MOMO_TEST_TOKEN}' } });
    const r = await client.callTool({ name: 'env_keys', arguments: {} });
    const seen = JSON.parse(r.content[0].text);
    await client.close();
    assert.equal(seen.TOKEN, 'tok');
    assert.equal(seen.keys.includes('MOMO_TEST_PROVIDER_KEY'), false);
    assert.equal(seen.keys.includes('MOMO_TEST_TOKEN'), false);
    assert.ok(seen.keys.includes('PATH') && seen.keys.includes('HOME'));
  } finally {
    delete process.env.MOMO_TEST_PROVIDER_KEY;
    delete process.env.MOMO_TEST_TOKEN;
  }
});

test('client: a streamable HTTP server is reached with its configured headers', async () => {
  const http = await import('node:http');
  const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
  const seen: string[] = [];
  const srv = http.createServer(async (req, res) => {
    seen.push(String(req.headers['x-key']));
    const server = new Server({ name: 'h', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'ping', inputSchema: { type: 'object' } }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as any).port;
  process.env.MOMO_TEST_HEADER = 'k1';
  try {
    const client = await connectServer({ type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { 'x-key': '${MOMO_TEST_HEADER}' } });
    assert.deepEqual(
      (await client.listTools()).tools.map((t: any) => t.name),
      ['ping'],
    );
    await client.close();
    assert.ok(seen.includes('k1'));
  } finally {
    delete process.env.MOMO_TEST_HEADER;
    srv.close();
  }
});
