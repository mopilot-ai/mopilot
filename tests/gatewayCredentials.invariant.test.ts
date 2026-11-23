// The gateway's credentials stay in main's own process (#2999 C2): no harness's env, arguments or config, no model-facing tool text, and no window ever carries one. Structurally, only the gateway and the composition that opens it can reach the vault (the import graph of electron/, type imports included), so no harness launch, channel, plugin or capability module can read a credential; behaviorally, a credential saved for one server and present while every surface is built shows up only in that server's own HTTP request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { treeFiles } from '../scripts/source-tree.mjs';
import { gatewayWorld, fakeServer, tick, READ, http } from './support/gatewayWorld.ts';

// the folder it scans, for the guards in tests/invariantGuards.invariant.test.ts
export const GUARDS = ['electron/'];

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..');
/** The modules that keep or read the saved credentials (auth.cjs only turns one it is handed into a header). */
const HOLDERS = [
  'electron/gateway/credentials.cjs',
  'electron/gateway/oauthTokens.cjs',
  'electron/gateway/upstream.cjs',
  'electron/gateway/service.cjs',
];
/** Outside the gateway, the only modules that may reach them: the composition that opens it and its IPC (no harness, channel or capability). */
const COMPOSITION = [
  'electron/app/gatewayWiring.cjs',
  'electron/app/ipc/gateway.cjs',
  'electron/app/startup.cjs',
  'electron/main.cjs',
  'electron/boot.cjs',
];

/** A file's runtime requires of repository files (a JSDoc type import reads no data, so it is no reach). */
function requiresOf(file: string) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    const to = path
      .relative(ROOT, path.resolve(path.dirname(path.join(ROOT, file)), m[1]))
      .split(path.sep)
      .join('/');
    out.push(to);
  }
  return out;
}

function reachers() {
  const files = treeFiles(path.join(ROOT, 'electron'), /\.c?js$/).map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
  const edges = new Map(files.map((f) => [f, requiresOf(f)]));
  const reach = new Set<string>(HOLDERS);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [f, to] of edges) if (!reach.has(f) && to.some((t) => reach.has(t))) reach.add(f), (grew = true);
  }
  return [...reach].filter((f) => !f.startsWith('electron/gateway/')).sort();
}

test('only the gateway and the composition that opens it reach the credential vault: no harness, channel or capability module does', () => {
  const outside = reachers();
  for (const f of outside)
    assert.ok(COMPOSITION.includes(f), `${f} reaches the gateway's credentials; keep credentials in electron/gateway`);
  // the scan sees the real wiring (a scan that found nothing would pass anything)
  assert.ok(outside.includes('electron/app/gatewayWiring.cjs'));
  assert.ok(!outside.some((f) => /^electron\/(harness|capabilities|plugins|session|identity|momo)\//.test(f)));
});

test('a saved credential is in its server’s own request only: never a stdio server’s env or argv, a tool’s text, a Claude session’s options or a window’s list', async () => {
  const SECRET = 'SENTINEL-c2-credential-7f3a';
  const tool = { name: 'post', description: 'Post.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } };
  const w = gatewayWorld({ servers: { local: fakeServer([tool]), 'https://h.example/mcp': fakeServer([{ ...tool, inputSchema: READ }]) } });
  const remote = await w.gateway.add(http('remote', 'https://h.example/mcp', 'bearer'));
  await w.gateway.connect(remote.key, { type: 'bearer', token: SECRET });
  await w.gateway.add({ name: 'local', launch: { type: 'stdio', command: 'local', args: ['--flag'], env: { TOKEN_NAME: 'x' } } });
  for (let i = 0; i < 20; i++) await tick();
  const local = w.s.connects.find((c: any) => c.launch.type === 'stdio');
  assert.ok(local, 'the stdio server started');
  assert.doesNotMatch(JSON.stringify(local), new RegExp(SECRET));
  const http1 = w.s.connects.find((c: any) => c.launch.type === 'http' && c.auth.headers.Authorization);
  assert.equal(http1.auth.headers.Authorization, `Bearer ${SECRET}`, 'the remote server got it');
  assert.doesNotMatch(JSON.stringify(http1.launch), new RegExp(SECRET), 'never written into the launch');
  // what the harnesses are told about the tools
  assert.equal(w.names().length, 2);
  assert.doesNotMatch(JSON.stringify(w.registry.list({ chatId: 'chat-1' })), new RegExp(SECRET));
  // a Claude Code session built now
  const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
  const { prepareSessionTools } = require('../electron/harness/claude/sessionTools.cjs');
  const sdk = {
    tool: (name: string, description: string, schema: any) => ({ name, description, schema }),
    createSdkMcpServer: (o: any) => o,
  };
  const options: any = {};
  await prepareSessionTools(
    { sdk: async () => sdk, sageTools: { registry: w.registry, sessions: new ToolSessions(), enabled: () => true } },
    { takesPluginDirs: () => false },
    '/cli',
    options,
    {},
    { chatId: 'chat-1', sessionId: 's1' },
    'claude:s1',
    () => 'chat-1',
  );
  assert.doesNotMatch(JSON.stringify(options), new RegExp(SECRET));
  assert.doesNotMatch(JSON.stringify(w.gateway.view()), new RegExp(SECRET));
  // the files on disk are sealed
  for (const f of fs.readdirSync(w.dir))
    if (fs.statSync(path.join(w.dir, f)).isFile()) assert.doesNotMatch(fs.readFileSync(path.join(w.dir, f), 'utf8'), new RegExp(SECRET), f);
  // nor this process's own env, which every harness inherits a copy of
  assert.doesNotMatch(JSON.stringify(process.env), new RegExp(SECRET));
  w.gateway.close();
});

test('switching off a harness’s own copies (C4) hands it names and identities only: no credential in a Codex thread’s config, an ACP process’s env or Claude’s options', async () => {
  const SECRET = 'SENTINEL-c4-credential-9b2e';
  const { Gateway } = require('../electron/gateway/service.cjs');
  const { fakeSafe } = await import('./support/momo-fixtures.ts');
  const { gatewayDir } = await import('./support/gatewayWorld.ts');
  const g = new Gateway({ dir: gatewayDir(), safeStorage: fakeSafe() });
  const { key } = await g.servers.add({
    name: 'docs',
    launch: { type: 'http', url: 'https://docs.example/mcp', headers: {} },
    auth: 'bearer',
  });
  await g.credentials.put(key, { type: 'bearer', token: SECRET });
  // a stdio server's declared env and an HTTP server's headers stay the gateway's too
  await g.servers.add({ name: 'gh', launch: { type: 'stdio', command: 'npx', args: ['-y', 'gh'], env: { GH_TOKEN: SECRET } } });
  await g.servers.add({ name: 'wiki', launch: { type: 'http', url: 'https://wiki.example/mcp', headers: { 'X-Key': SECRET } } });
  const managed = (entry: unknown) => g.isManagedNative(entry);
  const entry = { url: 'https://docs.example/mcp' };
  // Codex
  const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
  const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
  const inj = new CodexToolInjection({
    sessions: new ToolSessions(),
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => 1,
    hasTools: () => true,
  });
  inj.setUserServers({ docs: entry });
  inj.managedServer = managed;
  const thread = inj.outgoing({ id: 1, method: 'thread/start', params: {} });
  assert.deepEqual(thread.params.config.mcp_servers.docs, { enabled: false });
  assert.doesNotMatch(JSON.stringify(thread), new RegExp(SECRET));
  // a basic harness
  const { OwnMcp } = require('../electron/harness/acp/ownMcp.cjs');
  const own = new OwnMcp({
    quirksOf: () => ({
      mcp: { servers: () => [{ name: 'docs', enabled: true, config: entry }], off: (n: string[]) => ({ OFF: JSON.stringify(n) }) },
    }),
    prefs: () => ({}),
    env: () => ({}),
  });
  own.managed = managed;
  const env = own.envFor('opencode', {});
  assert.deepEqual(env, { OFF: '["docs"]' });
  assert.doesNotMatch(JSON.stringify([env, own.status('opencode')]), new RegExp(SECRET));
  // Claude Code
  const { denyManaged } = require('../electron/harness/claude/gatewayNative.cjs');
  const options: any = {};
  denyManaged(options, g.nativeDenials());
  assert.equal(options.settings.deniedMcpServers.length, 5);
  assert.doesNotMatch(JSON.stringify(options), new RegExp(SECRET));
});
