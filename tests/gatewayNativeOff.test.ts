// Each harness's own copies of the servers MoPilot's MCP gateway runs are switched off in MoPilot's chats (#2999 C4), never by editing the user's files: the gateway's identity of a server entry from any harness's config (gateway/native.cjs: command and arguments, or URL; never its name, env or headers); Claude Code's session denies them by identity in its flag settings (deniedMcpServers; harness/claude/gatewayNative.cjs, through the real session over a fake SDK), never by a toggle, which Claude Code saves in the user's .claude.json; Codex starts each chat thread with them `enabled: false` (codexConfig.cjs, codexThreadContracts.cjs); a basic harness's process starts with them off and restarts when the managed set changes (acp/ownMcp.cjs); a plugin's server an ACP session would get is withheld (plugins/delivery.cjs). A gateway whose list can't be opened manages none: the harnesses keep theirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe } from './support/momo-fixtures.ts';
import { gatewayDir } from './support/gatewayWorld.ts';
import { fakes, load, fakeBin, flush, lastQuery, tmp } from './support/electron-claude.ts';

const require = createRequire(import.meta.url);
const { nativeKey, managedNames, denialsOf } = require('../electron/gateway/native.cjs');
const { Gateway } = require('../electron/gateway/service.cjs');
const { denyManaged } = require('../electron/harness/claude/gatewayNative.cjs');
const { gatewayThreadOff } = require('../electron/capabilities/channels/codexThreadContracts.cjs');
const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { OwnMcp } = require('../electron/harness/acp/ownMcp.cjs');
const { PluginDelivery } = require('../electron/plugins/delivery.cjs');

async function managedGateway() {
  const g = new Gateway({ dir: gatewayDir(), safeStorage: fakeSafe() });
  await g.servers.add({
    name: 'gh',
    launch: { type: 'stdio', command: 'npx', args: ['-y', '@acme/github-mcp'], env: { GITHUB_TOKEN: '${GH}' } },
  });
  await g.servers.add({ name: 'docs', launch: { type: 'http', url: 'https://docs.example/mcp', headers: {} }, auth: 'bearer' });
  return g;
}

test('a server entry from any harness has the gateway’s identity by its command and arguments, or its URL', () => {
  const key = nativeKey({ command: 'npx', args: ['-y', 'x'] });
  // Claude Code's and Codex's shapes, a session status's, a plugin's: env, headers and type don't change it
  assert.equal(nativeKey({ type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { A: '1' } }), key);
  assert.notEqual(nativeKey({ command: 'npx', args: ['-y', 'y'] }), key);
  assert.equal(
    nativeKey({ url: 'https://h/mcp#frag', headers: { Authorization: 'x' } }),
    nativeKey({ type: 'http', url: 'https://h/mcp' }),
  );
  assert.equal(nativeKey({ url: 'https://h/mcp', http_headers: {} }), nativeKey({ url: 'https://h/mcp' }));
  // an SSE server, a plain-http remote one, or no server at all is never the gateway's
  for (const entry of [{ type: 'sse', url: 'https://h/sse' }, { url: 'http://remote.example/mcp' }, {}, null, 'npx'])
    assert.equal(nativeKey(entry), null, JSON.stringify(entry));
  assert.deepEqual(
    managedNames(
      [
        { name: 'z', config: 1 },
        { name: 'a', config: 2 },
        { name: 'b', config: 3 },
      ],
      (c: number) => c !== 3,
    ),
    ['a', 'z'],
  );
});

test('the gateway manages what its list holds; a list that can’t be opened manages none (the harnesses keep theirs)', async () => {
  const g = await managedGateway();
  assert.equal(g.managedKeys().size, 2);
  assert.equal(g.isManagedNative({ command: 'npx', args: ['-y', '@acme/github-mcp'] }), true);
  assert.equal(g.isManagedNative({ type: 'http', url: 'https://docs.example/mcp' }), true);
  assert.equal(g.isManagedNative({ command: 'npx', args: ['-y', 'other'] }), false);
  assert.equal(g.isManagedNative({ type: 'sse', url: 'https://docs.example/mcp' }), false);
  // read once per change: a check per server entry doesn't open the sealed list again
  let reads = 0;
  const list = g.servers.list.bind(g.servers);
  g.servers.list = () => (reads++, list());
  g.isManagedNative({ command: 'a' });
  g.nativeDenials();
  assert.equal(reads, 0);
  (g.servers.store.safe as any).available = false;
  g.emit('changed');
  assert.equal(g.managedKeys().size, 0);
  assert.equal(g.managedKeys().size, 0);
  assert.equal(reads, 2, 'a list that couldn’t be opened is tried again');
  assert.equal(g.isManagedNative({ command: 'npx', args: ['-y', '@acme/github-mcp'] }), false);
});

test('Claude Code’s deny entries: a stdio server by its command and arguments, an HTTP one by its URL with and without its closing /', async () => {
  assert.deepEqual(
    denialsOf([
      { launch: { type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { TOKEN: 'secret' } } },
      { launch: { type: 'stdio', command: 'solo' } },
      { launch: { type: 'http', url: 'https://h/mcp', headers: { Authorization: 'secret' } } },
      { launch: { type: 'http', url: 'https://h' } },
      { launch: { type: 'http', url: 'https://h/a/' } },
      { launch: { type: 'http', url: 'https://h/mcp?team=1' } },
      { launch: { type: 'http', url: 'http://remote.example/mcp' } },
      { launch: { type: 'stdio' } },
      { launch: { type: 'sse', url: 'https://h/sse' } },
    ]),
    [
      { serverCommand: ['npx', '-y', 'x'] },
      { serverCommand: ['solo'] },
      { serverUrl: 'https://h/mcp' },
      { serverUrl: 'https://h/mcp/' },
      { serverUrl: 'https://h/' },
      { serverUrl: 'https://h/a/' },
      { serverUrl: 'https://h/a' },
      { serverUrl: 'https://h/mcp?team=1' },
    ],
  );
  const g = await managedGateway();
  assert.deepEqual(g.nativeDenials(), [
    { serverCommand: ['npx', '-y', '@acme/github-mcp'] },
    { serverUrl: 'https://docs.example/mcp' },
    { serverUrl: 'https://docs.example/mcp/' },
  ]);
  assert.doesNotMatch(JSON.stringify(g.nativeDenials()), /GITHUB_TOKEN|\$\{GH\}/, 'never a server’s env');
});

test('Claude Code: the deny entries go after any the session’s flag settings have, and nothing is added without one', () => {
  const options: any = { settings: { fastMode: true, deniedMcpServers: [{ serverName: 'theirs' }] } };
  const denials = [{ serverCommand: ['npx', '-y', 'x'] }];
  assert.deepEqual(denyManaged(options, denials), denials);
  assert.deepEqual(options.settings, {
    fastMode: true,
    deniedMcpServers: [{ serverName: 'theirs' }, { serverCommand: ['npx', '-y', 'x'] }],
  });
  const bare: any = {};
  denyManaged(bare, denials);
  assert.deepEqual(bare.settings, { deniedMcpServers: denials });
  for (const none of [[], null]) {
    const o: any = { settings: { fastMode: true } };
    assert.deepEqual(denyManaged(o, none as any), []);
    assert.deepEqual(o.settings, { fastMode: true });
  }
});

test('Claude Code, through a real session: its flag settings deny the servers the gateway runs; a chat kept apart and no gateway add none', async () => {
  const t = load();
  const dir = fs.mkdtempSync(path.join(tmp, 'claude-session-'));
  const g = await managedGateway();
  t.claude.setTools({ enabled: () => false, gatewayDenials: () => g.nativeDenials() });
  fakes.onQuery = (q: any) => {
    q.reply = null;
  };
  await t.claude.send('claude:gw-native', { bin: fakeBin('gw/claude'), sessionId: 'gw-native', cwd: dir }, { role: 'user', content: 'hi' });
  const q = lastQuery();
  assert.deepEqual(q.options.settings.deniedMcpServers, g.nativeDenials());
  assert.ok(q.options.settings.skillOverrides, 'the session’s own flag settings stay');
  assert.ok(!q.calls.some((c: any[]) => c[0] === 'toggleMcpServer'), 'nothing toggled: a toggle would be saved in the user’s .claude.json');
  // without the gateway's entries (no gateway), nothing is denied
  t.claude.setTools({ enabled: () => false });
  await t.claude.send('claude:gw-plain', { bin: fakeBin('gw/claude'), sessionId: 'gw-plain', cwd: dir }, { role: 'user', content: 'hi' });
  const p = lastQuery();
  assert.equal(p.options.settings.deniedMcpServers, undefined);
  q.end();
  p.end();
  await flush();
});

test('Codex: each chat thread starts with the user’s servers the gateway runs off; a helper’s are all off; none without a gateway', async () => {
  const g = await managedGateway();
  const inj = new CodexToolInjection({
    sessions: new ToolSessions(),
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => 1,
    hasTools: () => true,
  });
  inj.setUserServers({
    github: { command: 'npx', args: ['-y', '@acme/github-mcp'] },
    mine: { command: 'mine' },
    docs: { url: 'https://docs.example/mcp' },
  });
  assert.deepEqual(inj.userServers, ['github', 'mine', 'docs']);
  const before = inj.outgoing({ id: 1, method: 'thread/start', params: {} });
  assert.equal(before.params.config.mcp_servers.github, undefined, 'no gateway yet: the user’s servers load');
  inj.managedServer = (c: unknown) => g.isManagedNative(c);
  const after = inj.outgoing({ id: 2, method: 'thread/start', params: {} });
  assert.deepEqual(after.params.config.mcp_servers.github, { enabled: false });
  assert.deepEqual(after.params.config.mcp_servers.docs, { enabled: false });
  assert.equal(after.params.config.mcp_servers.mine, undefined);
  // names only (an older read), or nothing: none matched
  assert.deepEqual(
    gatewayThreadOff(['github'], {}, () => false),
    {},
  );
  assert.deepEqual(
    gatewayThreadOff([], {}, () => true),
    {},
  );
  assert.deepEqual(gatewayThreadOff(['a'], { a: 1 }, null), {});
  inj.setUserServers(['github']);
  assert.deepEqual(inj.userServerConfigs, {});
  inj.setUserServers('junk' as any);
  assert.deepEqual(inj.userServers, []);
});

test('a basic harness: its process starts with the gateway’s servers off whatever the choice, Settings sees which, and a change restarts it', async () => {
  const g = await managedGateway();
  const layers: string[][] = [];
  const servers = [
    { name: 'gh', enabled: true, config: { command: 'npx', args: ['-y', '@acme/github-mcp'] } },
    { name: 'rea', enabled: true, config: { command: 'rea' } },
  ];
  const quirk = {
    label: 'opencode',
    mcp: { servers: () => servers, off: (names: string[]) => (layers.push(names), { LAYER: names.join(',') }) },
  };
  const own = new OwnMcp({ quirksOf: () => quirk, prefs: () => ({ acpMcp: {} }), env: () => ({}) });
  assert.deepEqual(own.envFor('opencode', {}), {}, 'no gateway: nothing off');
  own.managed = (c: unknown) => g.isManagedNative(c);
  assert.deepEqual(own.envFor('opencode', {}), { LAYER: 'gh' });
  const status = own.status('opencode');
  assert.deepEqual(status.servers, [
    { name: 'gh', enabled: true, off: false, managed: true },
    { name: 'rea', enabled: true, off: false, managed: false },
  ]);
  assert.doesNotMatch(JSON.stringify(status), /acme|npx/, 'a server’s entry stays in main');
  // a change of the managed set restarts a running process whose servers it changes; the same set again does nothing
  const killed: string[] = [];
  const host: any = {
    chats: new Map(),
    starting: new Set(),
    on: () => {},
    close: () => {},
    agents: new Map([['opencode', Promise.resolve({ kill: () => void killed.push('opencode') })]]),
  };
  own.attach(host);
  own.changed('["k1"]');
  own.envFor('opencode', {});
  own.managed = () => false;
  own.changed('["k2"]');
  await flush();
  assert.deepEqual(killed, ['opencode']);
  host.agents.set('opencode', Promise.resolve({ kill: () => void killed.push('again') }));
  own.envFor('opencode', {});
  own.changed('["k2"]');
  await flush();
  assert.deepEqual(killed, ['opencode'], 'the same set: no restart');
  // a pref change keeps the managed set it last saw
  own.changed();
  assert.equal(own.gateway, '["k2"]');
});

test('plugins: a server the gateway runs isn’t handed to an ACP session, and the Plugins page says why', async () => {
  const deliver = [
    {
      id: 'tools@acme',
      path: '/p',
      spec: {
        name: 'tools',
        mcpServers: {
          gh: { type: 'stdio', command: 'npx', args: ['-y', '@acme/github-mcp'], env: {} },
          own: { type: 'stdio', command: 'own', args: [], env: {} },
        },
      },
    },
  ];
  const store = {
    reserveFor: async () => ({ deliver, withheld: [], error: null }),
    enabledFor: async () => ({}),
    hold: () => {},
    release: async () => {},
  };
  const d = new PluginDelivery({ store });
  const g = await managedGateway();
  d.managed = (s: unknown) => g.isManagedNative(s);
  const out = await d.forAcp();
  assert.equal(out.mcpServers.length, 1);
  assert.equal(out.mcpServers[0].command, 'own');
  assert.deepEqual(out.withheld, [
    { id: 'tools@acme', why: "gh: MoPilot's MCP gateway runs this server for every chat, under your rules." },
  ]);
  await out.release();
});

test('the renderer’s types name each field main reports for a harness’s server, `managed` included', async () => {
  await import('../src/lib/native/acp.ts');
  const text = fs.readFileSync(path.join(import.meta.dirname, '../src/lib/native/acp.ts'), 'utf8');
  const line = text.split('\n').find((l) => l.trim().startsWith('servers: {'))!;
  for (const field of ['name', 'enabled', 'off', 'managed']) assert.match(line, new RegExp(`\\b${field}\\??:`), field);
});

test('opencode: each server’s entry as the gateway reads it (a local command array, a remote URL), nothing for anything else', () => {
  const { opencodeServers } = require('../electron/harness/quirks/opencodeMcp.cjs');
  const body = JSON.stringify({
    mcp: {
      gh: { type: 'local', command: ['npx', '-y', '@acme/github-mcp'], environment: { GH: 'x' } },
      docs: { type: 'remote', url: 'https://docs.example/mcp', headers: { A: 'b' } },
      empty: { type: 'local', command: [] },
      blank: { type: 'local', command: [''] },
      odd: { type: 'websocket', url: 'wss://x' },
    },
  });
  const listed = opencodeServers({ HOME: '/nowhere', OPENCODE_CONFIG: '/c.json' }, (f: string) => (f === '/c.json' ? body : '{}'));
  assert.deepEqual(Object.fromEntries(listed.map((s: any) => [s.name, s.config])), {
    blank: null,
    docs: { url: 'https://docs.example/mcp' },
    empty: null,
    gh: { command: 'npx', args: ['-y', '@acme/github-mcp'] },
    odd: null,
  });
  assert.equal(nativeKey(listed.find((s: any) => s.name === 'gh').config), nativeKey({ command: 'npx', args: ['-y', '@acme/github-mcp'] }));
});

test('opencode: a later file that only turns a server on or off keeps where an earlier one said it runs, or none', () => {
  const { opencodeServers } = require('../electron/harness/quirks/opencodeMcp.cjs');
  const files: Record<string, string> = {
    '/a.json': JSON.stringify({ mcp: { gh: { type: 'local', command: ['gh-mcp'] }, bare: { type: 'local' } } }),
    '/b.json': JSON.stringify({ mcp: { gh: { enabled: false }, bare: { enabled: false } } }),
  };
  const read = (f: string) => files[f] ?? '{}';
  const one = opencodeServers({ HOME: '/nowhere', OPENCODE_CONFIG: '/a.json' }, read);
  assert.deepEqual(one.find((s: any) => s.name === 'gh').config, { command: 'gh-mcp', args: [] });
  // the settings folder's own file first, then OPENCODE_CONFIG: both read in order
  const both = opencodeServers({ HOME: '/nowhere', XDG_CONFIG_HOME: '/x', OPENCODE_CONFIG: '/b.json' }, (f: string) =>
    f === '/x/opencode/config.json' ? files['/a.json'] : read(f),
  );
  assert.deepEqual(
    both.map((s: any) => [s.name, s.enabled, s.config]),
    [
      ['bare', false, null],
      ['gh', false, { command: 'gh-mcp', args: [] }],
    ],
  );
});

test('Codex: the user’s servers go to the tool injection with their entries; a config with none, or a read that fails, gives none (read again next time)', async () => {
  const { CodexConnection } = require('../electron/harness/codexConnection.cjs');
  const read = CodexConnection.prototype.userServers;
  const given: unknown[] = [];
  const adapter = (answer: () => Promise<any>) => ({ call: answer, tools: { setUserServers: (s: unknown) => void given.push(s) } }) as any;
  const withServers = adapter(async () => ({ config: { mcp_servers: { gh: { command: 'npx' } } } }));
  await read.call(withServers);
  const empty = adapter(async () => ({ config: {} }));
  await read.call(empty);
  const failing = adapter(async () => Promise.reject(new Error('down')));
  await read.call(failing);
  assert.deepEqual(given, [{ gh: { command: 'npx' } }, {}, {}]);
  assert.equal(failing.userServersP, null, 'a failed read is read again at the next thread start');
});

test('opencode: a later file that names where a server runs but not whether it is on keeps the earlier file’s on or off', () => {
  const { opencodeServers } = require('../electron/harness/quirks/opencodeMcp.cjs');
  const files: Record<string, string> = {
    '/x/opencode/config.json': JSON.stringify({ mcp: { gh: { enabled: false } } }),
    '/b.json': JSON.stringify({ mcp: { gh: { type: 'local', command: ['gh-mcp'] } } }),
  };
  const listed = opencodeServers({ HOME: '/nowhere', XDG_CONFIG_HOME: '/x', OPENCODE_CONFIG: '/b.json' }, (f: string) => files[f] ?? '{}');
  assert.deepEqual(listed, [{ name: 'gh', enabled: false, config: { command: 'gh-mcp', args: [] } }]);
});

test('a warm new-chat process is taken only with the managed set it started with (Claude Code’s and Codex’s prewarm keys)', () => {
  const { claudePrewarm } = require('../electron/harness/claude/prewarm.cjs');
  const { codexPrewarm } = require('../electron/harness/codexPrewarm.cjs');
  let denials: object[] = [];
  const st = { account: 'default', model: 'sonnet', effort: null, permission: 'default', fast: false, prefs: {} };
  const api = { nativeChromeFor: () => false, billingSig: () => 'sub', artifactsOf: () => ({ on: true }) };
  const claude = claudePrewarm({ adapter: { settings: () => st }, api: { ...api, gatewayDenials: () => denials } });
  const before = claude.key({ cwd: '/w' });
  denials = [{ serverCommand: ['npx', '-y', 'x'] }];
  assert.notEqual(claude.key({ cwd: '/w' }), before, 'a server managed since: the warm CLI loads its own copy');
  // no gateway entries given (a caller without one): as with none
  assert.equal(claudePrewarm({ adapter: { settings: () => st }, api }).key({ cwd: '/w' }), before);
  let sig = '[]';
  const params = { cwd: '/w' };
  const codex = codexPrewarm({ adapter: { provider: () => null, tools: { managedSig: () => sig } } });
  const k = codex.key({ params });
  sig = '["gh"]';
  assert.notEqual(codex.key({ params }), k, 'a thread warmed before the server was managed starts with its own copy on');
  assert.equal(codexPrewarm({ adapter: { provider: () => null, tools: null } }).key({ params }), JSON.stringify([params, null]));
});

test('Claude Code’s handoff note runs with the gateway’s servers denied too; a MoMo chat’s is confined instead', async () => {
  const { createQueries } = require('../electron/harness/claude/queries.cjs');
  const runs: any[] = [];
  const denials = [{ serverCommand: ['npx', '-y', 'x'] }];
  const state: any = {
    isolated: (chatId: string) => chatId === 'momo',
    sageTools: { gatewayDenials: () => denials },
    sdk: async () => ({
      query: (run: any) => {
        runs.push(run);
        return (async function* () {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'note' }] } };
          yield { type: 'result' };
        })();
      },
    }),
  };
  const queries = createQueries(state, { auth: { cleanEnv: () => ({}) }, cli: { findBinary: async () => '/bin/claude' } });
  await queries.summarize('s1', '/w', 'note', undefined, undefined, 'chat');
  assert.deepEqual(runs[0].options.settings.deniedMcpServers, denials);
  await queries.summarize('s2', '/w', 'note', undefined, undefined, 'momo');
  assert.equal(runs[1].options.settings.deniedMcpServers, undefined);
  delete state.sageTools;
  await queries.summarize('s3', '/w', 'note');
  assert.equal(runs[2].options.settings, undefined);
});
