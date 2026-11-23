// The connector tools (electron/capabilities/tools/connectorTools.cjs) and what each harness answers them with
// (connectorProviders.cjs): Claude Code's SDK calls, Codex's app-server and config, a basic harness's own server list.
// What a harness can't do is said, a change asks the user first, and a failed read is never shown as "no connectors".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Registry, ToolError } = require('../electron/capabilities/contract/registry.cjs');
const { registerConnectorTools, NEEDS_AUTH } = require('../electron/capabilities/tools/connectorTools.cjs');
const { claudeProvider, codexProvider, acpProvider } = require('../electron/capabilities/tools/connectorProviders.cjs');

const rows = [
  { name: 'github', status: 'connected', enabled: true, tool_count: 3 },
  { name: 'Notion', status: 'needs_auth', enabled: true },
  { name: 'old', status: 'disabled', enabled: false },
];

function setup(over: { kind?: string | null; provider?: any; allow?: boolean } = {}) {
  const calls: any[] = [];
  const asked: string[] = [];
  const provider = over.provider ?? {
    status: async () => ({ scope: 'this session', connectors: rows }),
    setEnabled: async (...a: any[]) => (calls.push(['set', ...a.slice(1)]), {}),
    reconnect: async (...a: any[]) => (calls.push(['reconnect', ...a.slice(1)]), {}),
  };
  const r = new Registry();
  registerConnectorTools(r, {
    owner: (ctx: any) => (ctx.segmentId === 'seg' ? ctx.chatId : null),
    kindOf: () => (over.kind === undefined ? 'claude' : over.kind),
    providers: { claude: provider, codex: provider, acp: provider },
    ask: async (_chat: string, summary: string) => (asked.push(summary), over.allow !== false),
  });
  const call = async (tool: string, args: any = {}, seg = 'seg') => {
    const res = await r.invoke('me', seg, tool, args);
    return res.ok ? JSON.parse(res.content[0].text) : { error: res.error };
  };
  return { r, call, calls, asked };
}

test('the tools: names and policies', () => {
  assert.deepEqual(
    setup()
      .r.list()
      .map((x: any) => [x.name, x.policy]),
    [
      ['session_connectors_status', 'observe'],
      ['set_session_connector_enabled', 'act'],
      ['reconnect_session_connector', 'act'],
      ['list_connectors', 'observe'],
    ],
  );
});

test('status: the harness’s connectors and where a change would apply, with a sign-in note', async () => {
  const t = setup();
  const res = await t.call('session_connectors_status');
  assert.deepEqual([res.harness, res.scope, res.connectors.length, res.note], ['claude', 'this session', 3, NEEDS_AUTH]);
  const quiet = setup({ provider: { status: async () => ({ scope: 'x', connectors: [rows[0]] }) } });
  assert.equal((await quiet.call('session_connectors_status')).note, undefined);
  assert.equal((await t.call('session_connectors_status', {}, 'stranger')).error.code, 'no_owner');
});

test('a chat with no known harness, or one whose read fails, is told why', async () => {
  assert.equal((await setup({ kind: null }).call('list_connectors')).error.code, 'unavailable');
  assert.equal((await setup({ kind: 'gemini' }).call('list_connectors')).error.code, 'unavailable');
  const failing = setup({ provider: { status: async () => Promise.reject(new Error('CLI gone')) } });
  const err = (await failing.call('session_connectors_status')).error;
  assert.deepEqual([err.code, err.message], ['unavailable', "Couldn't read the connectors: CLI gone"]);
  const odd = setup({ provider: { status: async () => Promise.reject('plain') } });
  assert.match((await odd.call('session_connectors_status')).error.message, /plain/);
  const told = setup({ provider: { status: async () => Promise.reject(new ToolError('Not here', 'nope')) } });
  assert.equal((await told.call('session_connectors_status')).error.code, 'nope');
});

test('enabling asks first; same-state, unknown names and a refusal change nothing', async () => {
  const t = setup();
  const res = await t.call('set_session_connector_enabled', { name: 'NOTION', enabled: false });
  assert.deepEqual(
    [res.name, res.enabled, res.changed, res.scope, res.said],
    ['Notion', false, true, 'this session', 'Done. Check session_connectors_status.'],
  );
  assert.deepEqual(t.asked, ['turn off the connector “Notion”']);
  assert.deepEqual(t.calls, [['set', 'claude', 'Notion', false]]);
  assert.equal((await t.call('set_session_connector_enabled', { name: 'old', enabled: true })).changed, true);
  assert.deepEqual(t.asked.at(-1), 'turn on the connector “old”');
  const before = t.calls.length;
  assert.equal((await t.call('set_session_connector_enabled', { name: 'github', enabled: true })).changed, false);
  const missing = (await t.call('set_session_connector_enabled', { name: 'zzz', enabled: true })).error;
  assert.equal(missing.code, 'not_found');
  assert.match(missing.message, /github, Notion, old/);
  assert.equal(t.calls.length, before);
  const no = setup({ allow: false });
  assert.equal((await no.call('set_session_connector_enabled', { name: 'github', enabled: false })).error.code, 'denied');
  assert.deepEqual(no.calls, []);
  const said = setup({
    provider: { status: async () => ({ scope: 's', connectors: rows }), setEnabled: async () => ({ said: 'Custom.' }) },
  });
  assert.equal((await said.call('set_session_connector_enabled', { name: 'old', enabled: true })).said, 'Custom.');
  const none = setup({ provider: { status: async () => ({ scope: 's', connectors: [] }) } });
  assert.match((await none.call('set_session_connector_enabled', { name: 'x', enabled: true })).error.message, /has: none/);
});

test('reconnect: a connector that can be, a sign-in it cannot do, and a harness that cannot reconnect', async () => {
  const t = setup();
  const res = await t.call('reconnect_session_connector', { name: 'github' });
  assert.deepEqual([res.reconnected, t.calls], [true, [['reconnect', 'claude', 'github']]]);
  assert.deepEqual(await t.call('reconnect_session_connector', { name: 'Notion' }), {
    name: 'Notion',
    reconnected: false,
    said: NEEDS_AUTH,
  });
  assert.equal(t.calls.length, 1);
  const said = setup({
    provider: {
      status: async () => ({ scope: 's', connectors: rows }),
      setEnabled: async () => ({}),
      reconnect: async () => ({ said: 'Custom.' }),
    },
  });
  assert.equal((await said.call('reconnect_session_connector', { name: 'github' })).said, 'Custom.');
  const basic = setup({ provider: { status: async () => ({ scope: 's', connectors: rows }), setEnabled: async () => ({}) } });
  const cant = await basic.call('reconnect_session_connector', { name: 'github' });
  assert.deepEqual([cant.reconnected, /cannot reconnect/.test(cant.said)], [false, true]);
});

test('list_connectors: names, status and enabled, filtered by keywords, with a hint when nothing matches', async () => {
  const t = setup();
  assert.equal((await t.call('list_connectors')).connectors.length, 3);
  const some = await t.call('list_connectors', { keywords: ['NOT', ''] });
  assert.deepEqual(some, { connectors: [{ name: 'Notion', status: 'needs_auth', enabled: true }] });
  const none = await t.call('list_connectors', { keywords: ['asana'] });
  assert.deepEqual(none.connectors, []);
  assert.match(none.note, /search_mcp_registry/);
});

test('Claude Code: statuses from the session, toggle and reconnect through its control request', async () => {
  const sent: any[] = [];
  const answer: { rows: unknown } = {
    rows: [
      { name: 'a', status: 'connected', tools: [1, 2] },
      { name: 'b', status: 'needs-auth' },
      { name: 'c', status: 'disabled' },
      { name: 'd', status: 'weird' },
      { name: 'e', status: 'failed' },
    ],
  };
  const p = claudeProvider({
    control: async (chat: string, method: string, arg?: unknown) => (
      sent.push([chat, method, arg]), method === 'mcpStatus' ? answer.rows : true
    ),
  });
  const s = await p.status('me', 'claude');
  assert.equal(s.scope, 'this session');
  assert.deepEqual(
    s.connectors.map((c: any) => [c.name, c.status, c.enabled, c.tool_count]),
    [
      ['a', 'connected', true, 2],
      ['b', 'needs_auth', true, undefined],
      ['c', 'disabled', false, undefined],
      ['d', 'pending', true, undefined],
      ['e', 'failed', true, undefined],
    ],
  );
  assert.match((await p.setEnabled('me', 'claude', 'a', false)).said, /this session/);
  assert.match((await p.reconnect('me', 'claude', 'a')).said, /Reconnecting/);
  assert.deepEqual(sent.slice(1), [
    ['me', 'toggleMcp', { name: 'a', enabled: false }],
    ['me', 'reconnectMcp', { name: 'a' }],
  ]);
  // no live process: control answers null, for a change as for a read
  answer.rows = null;
  await assert.rejects(p.status('me', 'claude'), /isn't running/);
  const gone = claudeProvider({ control: async () => null });
  await assert.rejects(gone.setEnabled('me', 'claude', 'a', true), /isn't running/);
  await assert.rejects(gone.reconnect('me', 'claude', 'a'), /isn't running/);
});

test('Codex: the app-server’s servers, config.toml for on and off, and a reload as the reconnect', async () => {
  const sent: any[] = [];
  const data = [
    { name: 'ok', runtimeStatus: 'connected', tools: { a: {}, b: {} }, authStatus: 'oAuth' },
    { name: 'login', runtimeStatus: null, tools: {}, authStatus: 'notLoggedIn' },
    { name: 'starting', runtimeStatus: 'starting', authStatus: 'unsupported' },
    { name: 'off', runtimeStatus: 'disabled', tools: {}, authStatus: 'unsupported' },
    { name: 'dead', runtimeStatus: 'cancelled', tools: {}, authStatus: 'unsupported' },
    { name: 'blank', runtimeStatus: null, tools: {}, authStatus: 'unsupported' },
    // turned off in config.toml, with no runtime state to say so
    { name: 'toml-off', runtimeStatus: null, tools: {}, authStatus: 'unsupported' },
  ];
  const p = codexProvider({
    request: async (method: string, params: unknown) => (
      sent.push([method, params]),
      method === 'mcpServerStatus/list' ? { data } : { config: { mcp_servers: { 'toml-off': { enabled: false }, ok: { enabled: true } } } }
    ),
  });
  const s = await p.status();
  assert.equal(s.scope, 'every chat on this harness');
  assert.deepEqual(
    s.connectors.map((c: any) => [c.name, c.status, c.enabled, c.tool_count]),
    [
      ['ok', 'connected', true, 2],
      ['login', 'needs_auth', true, 0],
      ['starting', 'pending', true, 0],
      ['off', 'disabled', false, 0],
      ['dead', 'failed', true, 0],
      ['blank', 'pending', true, 0],
      ['toml-off', 'disabled', false, 0],
    ],
  );
  assert.match((await p.setEnabled('me', 'codex', 'a "b"', false)).said, /every chat on it/);
  assert.match((await p.reconnect()).said, /reload/);
  assert.deepEqual(sent.slice(2), [
    ['config/value/write', { keyPath: 'mcp_servers."a \\"b\\"".enabled', value: false, mergeStrategy: 'replace' }],
    ['config/mcpServer/reload', undefined],
    ['config/mcpServer/reload', undefined],
  ]);
  const empty = codexProvider({ request: async () => ({}) });
  assert.deepEqual((await empty.status()).connectors, []);
  // an unreadable config leaves the runtime states alone; an unreadable server list is an error
  const noConfig = codexProvider({
    request: async (method: string) => (method === 'config/read' ? Promise.reject(new Error('no config')) : { data: [data[0]] }),
  });
  assert.deepEqual((await noConfig.status()).connectors, [{ name: 'ok', status: 'connected', enabled: true, tool_count: 2 }]);
  const down = codexProvider({ request: async () => Promise.reject(new Error('app-server gone')) });
  await assert.rejects(down.status(), /app-server gone/);
});

test('a basic harness: its own server list, turned off or on through the saved choice, no reconnect, no live state', async () => {
  const saved: any[] = [];
  const state = {
    supported: true,
    load: true,
    servers: [
      { name: 'a', off: false },
      { name: 'b', off: true },
    ],
  };
  const prefs: any = { acpMcp: { kimi: { load: true, off: ['b'] }, other: { load: false, off: [] } } };
  const p = acpProvider({
    status: (harness: string) => (harness === 'kimi' ? state : { supported: false, load: true, servers: [] }),
    prefs: () => prefs,
    patchPrefs: (set: any) => (saved.push(set), saved.length < 4),
  });
  assert.equal(p.reconnect, undefined);
  const s = await p.status('me', 'acp:kimi:thread');
  assert.deepEqual(s.connectors, [
    { name: 'a', status: 'unknown', enabled: true },
    { name: 'b', status: 'disabled', enabled: false },
  ]);
  await p.setEnabled('me', 'acp:kimi', 'a', false);
  await p.setEnabled('me', 'acp:kimi', 'b', true);
  assert.deepEqual(saved, [
    { acpMcp: { kimi: { load: true, off: ['a', 'b'] }, other: { load: false, off: [] } } },
    { acpMcp: { kimi: { load: true, off: [] }, other: { load: false, off: [] } } },
  ]);
  await assert.rejects(p.status('me', 'acp:other'), /can't list/);
  // a kind that names no basic harness asks for none
  await assert.rejects(p.status('me', 'codex'), /can't list/);
  const noPrefs = acpProvider({ status: () => state, prefs: () => null, patchPrefs: (set: any) => (saved.push(set), true) });
  await noPrefs.setEnabled('me', 'acp:kimi', 'a', false);
  assert.deepEqual(saved.at(-1), { acpMcp: { kimi: { load: true, off: ['a', 'b'] } } });
  const failing = acpProvider({ status: () => state, prefs: () => ({}), patchPrefs: () => false });
  await assert.rejects(failing.setEnabled('me', 'acp:kimi', 'a', false), /Couldn't save/);
});
