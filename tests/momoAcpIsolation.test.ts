// An ACP chat kept apart from the coding side (MoMo's, #2278): it runs on a process of its own that its harness's
// isolation quirk confines (no fs/terminal advertised, its own tools and instructions off), on the harness's mode for
// it, with every native permission request refused and no instructions file reachable from its folder; a harness that
// can't be confined runs no such chat. A coding chat on the same harness is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setup, settle, KEY, dir as tmp, INIT } from './support/acp-host/fixture';

const require = createRequire(import.meta.url);
const { CLIENT_CAPABILITIES } = require('../electron/harness/acp/agent.cjs');
const isolation = require('../electron/harness/acp/isolation.cjs');
const { reachableInstructions } = require('../electron/harness/instructionFiles.cjs');

const MOMO = 'acp:fake:momo';
const MODE_OPTION = (current: string) => ({
  id: 'mode',
  name: 'Mode',
  type: 'select',
  currentValue: current,
  options: [
    { value: 'build', name: 'Build' },
    { value: 'momo', name: 'MoMo' },
  ],
});
const confined = {
  label: 'Fake',
  args: ['acp'],
  env: { Q: 'coding' },
  isolation: { env: (ctx: any) => ({ ISO: '1', DATA: ctx.dataDir, Q: 'momo' }), mode: { configOption: 'mode', value: 'momo' } },
};
const folder = () => fs.mkdtempSync(path.join(tmp, 'ws-'));
const configCalls = (proc: any) => proc.received.filter((m: any) => m.method === 'session/set_config_option').map((m: any) => m.params);

function world(o: any = {}) {
  const t = setup({
    quirks: (id: string) => (id === 'fake' ? (o.quirks ?? confined) : null),
    handlers: {
      'session/new': () => ({ sessionId: `s-${Math.random().toString(36).slice(2, 8)}`, configOptions: [MODE_OPTION(o.mode ?? 'build')] }),
      'session/set_config_option': (p: any) => ({ configOptions: [MODE_OPTION(p.value)] }),
      ...o.handlers,
    },
    plugins: o.plugins,
    defaults: () => ({ config: { mode: 'build' } }),
    admission: { noteCatalog: (h: string, c: any) => void catalogs.push([h, c]), signedIn: () => null, signedOut: () => null },
  });
  const catalogs: any[] = [];
  const momo = new Set(o.momo ?? [MOMO]);
  (t.host as any).isolated = (key: string) => momo.has(key);
  return { ...t, catalogs, momo };
}

test('start: an isolated chat runs on its own confined process; a coding chat on the same harness is unchanged', async () => {
  const t = world();
  const ws = folder();
  const momo = await t.host.ensure(MOMO, { cwd: ws });
  const code = await t.host.ensure(KEY, { cwd: ws });
  assert.equal(momo.isolated, true);
  assert.equal(code.isolated, false);
  assert.notEqual(momo.agent, code.agent, 'two processes');
  assert.equal(t.sp.calls.length, 2);
  const [isoCall, codeCall] = t.sp.calls;
  assert.deepEqual(isoCall.options.env, { BASE: '1', Q: 'momo', ISO: '1', DATA: '/data' });
  assert.deepEqual(codeCall.options.env, { BASE: '1', Q: 'coding' });
  const init = (p: any) => p.received.find((m: any) => m.method === 'initialize').params.clientCapabilities;
  assert.deepEqual(init(t.sp.procs[0]).fs, { readTextFile: false, writeTextFile: false });
  assert.equal(init(t.sp.procs[0]).terminal, false);
  assert.deepEqual(init(t.sp.procs[1]).fs, CLIENT_CAPABILITIES.fs);
  assert.equal(init(t.sp.procs[1]).terminal, true);
  // the isolated chat is on MoMo's mode, recorded; the coding chat on the defaults new chats start with
  assert.deepEqual(configCalls(t.sp.procs[0]), [{ sessionId: momo.sessionId, configId: 'mode', value: 'momo' }]);
  assert.deepEqual(configCalls(t.sp.procs[1]), []);
  assert.ok((await t.host.history(MOMO)).some((r: any) => r.t === 'config' && r.configId === 'mode' && r.value === 'momo'));
  // only the coding session tells admission what new chats are offered
  assert.deepEqual(
    t.catalogs.map(([h]) => h),
    ['fake'],
  );
  t.host.closeAll();
});

test('each isolated chat has a confined process of its own, so no other session’s tool server reaches it (#2302)', async () => {
  const t = world();
  const ws = folder();
  t.momo.add('acp:fake:momo2');
  const [a, b] = await Promise.all([t.host.ensure(MOMO, { cwd: ws }), t.host.ensure('acp:fake:momo2', { cwd: ws })]);
  assert.notEqual(a.agent, b.agent);
  assert.equal(t.host.isolatedAgents.size, 2);
  // each process opened exactly one session, with only that chat's own MoPilot server
  for (const proc of t.sp.procs) {
    const opened = proc.received.filter((m: any) => m.method === 'session/new');
    assert.equal(opened.length, 1);
    assert.deepEqual(
      opened[0].params.mcpServers.map((s: any) => s.name),
      ['sage_0123456789ab'],
    );
  }
  // the same chat asked again keeps its process
  assert.equal((await t.host.ensure(MOMO, { cwd: ws })).agent, a.agent);
  // closing a chat stops its process and no other
  t.host.close(MOMO);
  await settle();
  assert.equal(t.host.isolatedAgents.has(MOMO), false);
  assert.ok(t.sp.procs[0].stdin.ended);
  assert.equal(t.sp.procs[1].stdin.ended, false);
  assert.equal(t.host.chats.has('acp:fake:momo2'), true);
  // coding chats hold a process each too (#2311), unless the harness claims per-session MCP servers
  await Promise.all([t.host.ensure(KEY, { cwd: ws }), t.host.ensure('acp:fake:c2', { cwd: ws })]);
  assert.notEqual(t.host.chats.get(KEY).agent, t.host.chats.get('acp:fake:c2').agent);
  t.host.closeAll();
});

test('an isolated chat whose open fails lets go of its process; one whose process never started has none to stop', async () => {
  const t = world({ handlers: { 'session/new': () => ({ sessionId: 's1', configOptions: [] }) } });
  await assert.rejects(t.host.ensure(MOMO, { cwd: folder() }), /has no mode mode/);
  await settle();
  assert.equal(t.host.isolatedAgents.size, 0);
  assert.ok(t.sp.procs[0].stdin.ended);
  const none = world({ quirks: { ...confined, isolation: { ...confined.isolation, env: () => Promise.reject(new Error('no env')) } } });
  await assert.rejects(none.host.ensure(MOMO, { cwd: folder() }), /no env/);
  assert.equal(none.host.isolatedAgents.size, 0);
  // a chat that never got a process (its entry already gone) has none to stop
  none.host.endTools(MOMO, { own: true });
  const failed = Promise.reject(new Error('gone'));
  failed.catch(() => undefined);
  none.host.isolatedAgents.set(MOMO, failed);
  none.host.endTools(MOMO, { own: true });
  await settle();
  assert.equal(none.host.isolatedAgents.size, 0);
});

test('a harness whose quirks can’t confine it runs no isolated chat; its coding chats run', async () => {
  const t = world({ quirks: { label: 'Fake', args: ['acp'] } });
  const ws = folder();
  await assert.rejects(t.host.ensure(MOMO, { cwd: ws }), /Fake can't run MoMo's chats: its own file and shell tools can't be turned off/);
  assert.equal(t.sp.calls.length, 0, 'nothing started');
  assert.equal((await t.host.ensure(KEY, { cwd: ws })).isolated, false);
  t.host.closeAll();
});

test('resume: an isolated chat reopens on the confined process and back on MoMo’s mode', async () => {
  const t = world({
    handlers: { initialize: () => INIT({ loadSession: true }), 'session/load': () => ({ configOptions: [MODE_OPTION('build')] }) },
  });
  const ws = folder();
  t.items.append(MOMO, { t: 'session', harness: 'fake', sessionId: 'old', cwd: ws, at: 1 });
  const chat = await t.host.ensure(MOMO, {});
  assert.equal(chat.sessionId, 'old');
  assert.equal(t.sp.procs[0].received.find((m: any) => m.method === 'session/load').params.sessionId, 'old');
  assert.ok(t.sp.calls[0].options.env.ISO);
  assert.deepEqual(configCalls(t.sp.procs[0]), [{ sessionId: 'old', configId: 'mode', value: 'momo' }]);
  t.host.closeAll();
});

test('a switched-harness chat is isolated by the chat its session belongs to; one already on the mode isn’t set again', async () => {
  const t = world({ momo: ['mc'], mode: 'momo' });
  const ws = folder();
  const chat = await t.host.ensure('acp:fake:seg2', { cwd: ws, chatId: 'mc' });
  assert.equal(chat.isolated, true);
  assert.deepEqual(configCalls(t.sp.procs[0]), []);
  t.host.closeAll();
});

test('the mode can’t be changed away from MoMo’s; other options can; a coding chat changes it freely', async () => {
  const t = world();
  const ws = folder();
  await t.host.ensure(MOMO, { cwd: ws });
  await t.host.ensure(KEY, { cwd: ws });
  await assert.rejects(t.host.setConfigOption(MOMO, 'mode', 'build'), /MoMo's chats keep their own mode/);
  await assert.rejects(t.host.setMode(MOMO, 'build'), /MoMo's chats keep their own mode/);
  await t.host.setConfigOption(MOMO, 'mode', 'momo');
  await t.host.setConfigOption(MOMO, 'model', 'x');
  await t.host.setConfigOption(KEY, 'mode', 'build');
  await t.host.setMode(KEY, 'plan');
  t.host.closeAll();
});

test('a confined process without MoMo’s mode fails closed; so does one that refuses it', async () => {
  const none = world({ handlers: { 'session/new': () => ({ sessionId: 's1', configOptions: [] }) } });
  await assert.rejects(none.host.ensure(MOMO, { cwd: folder() }), /Fake has no mode mode for MoMo's chats/);
  none.host.closeAll();
  const refused = world({
    handlers: {
      'session/set_config_option': () => {
        throw new Error('no such agent');
      },
    },
  });
  await assert.rejects(refused.host.ensure(MOMO, { cwd: folder() }), /no such agent/);
  assert.equal(refused.host.chats.size, 0);
  refused.host.closeAll();
});

test('a mode pinned as a session mode is set and held the same way', async () => {
  const q = { ...confined, isolation: { env: () => ({}), mode: { mode: 'ask' } } };
  const modes = (current: string) => ({ currentModeId: current, availableModes: [{ id: 'ask' }, { id: 'code' }] });
  const t = world({ quirks: q, handlers: { 'session/new': () => ({ sessionId: 's1', modes: modes('code') }) } });
  const chat = await t.host.ensure(MOMO, { cwd: folder() });
  assert.deepEqual(
    t.sp.procs[0].received.filter((m: any) => m.method === 'session/set_mode').map((m: any) => m.params.modeId),
    ['ask'],
  );
  assert.equal(chat.state.modes.currentModeId, 'ask');
  await assert.rejects(t.host.setMode(MOMO, 'code'), /keep their own mode/);
  await t.host.setMode(MOMO, 'ask');
  await t.host.setConfigOption(MOMO, 'model', 'x');
  t.host.closeAll();
  const held = world({ quirks: q, handlers: { 'session/new': () => ({ sessionId: 's1', modes: modes('ask') }) } });
  await held.host.ensure(MOMO, { cwd: folder() });
  assert.equal(held.sp.procs[0].received.filter((m: any) => m.method === 'session/set_mode').length, 0);
  held.host.closeAll();
});

test('fs and terminal requests: refused for an isolated chat, served for a coding one', async () => {
  const t = world();
  const ws = folder();
  fs.writeFileSync(path.join(ws, 'note.txt'), 'hi');
  const momo = await t.host.ensure(MOMO, { cwd: ws });
  const code = await t.host.ensure(KEY, { cwd: ws });
  // the rule is gone, the chat stays isolated (decided when its session opened)
  (t.host as any).isolated = undefined;
  for (const method of ['fs/read_text_file', 'fs/write_text_file', 'terminal/create', 'terminal/output', 'terminal/release'])
    await assert.rejects(t.host.onAgentRequest(momo.agent, method, { sessionId: momo.sessionId, path: path.join(ws, 'note.txt') }), {
      code: -32000,
    });
  assert.deepEqual(
    await t.host.onAgentRequest(code.agent, 'fs/read_text_file', { sessionId: code.sessionId, path: path.join(ws, 'note.txt') }),
    {
      content: 'hi',
    },
  );
  t.host.closeAll();
});

test('permission requests: an isolated chat’s native tool is refused without a card, its own tools pass; a coding chat asks', async () => {
  const t = world();
  const ws = folder();
  const momo = await t.host.ensure(MOMO, { cwd: ws });
  const code = await t.host.ensure(KEY, { cwd: ws });
  await t.host.send(MOMO, { blocks: [{ type: 'text', text: 'ls' }] });
  await t.host.send(KEY, { blocks: [{ type: 'text', text: 'ls' }] });
  const options = [
    { optionId: 'a', kind: 'allow_once' },
    { optionId: 'r', kind: 'reject_once' },
  ];
  const shell = { title: 'bash', kind: 'execute' };
  assert.deepEqual(
    await t.host.onAgentRequest(momo.agent, 'session/request_permission', { sessionId: momo.sessionId, toolCall: shell, options }),
    {
      outcome: { outcome: 'selected', optionId: 'r' },
    },
  );
  // with no reject option it is cancelled
  assert.deepEqual(
    await t.host.onAgentRequest(momo.agent, 'session/request_permission', {
      sessionId: momo.sessionId,
      toolCall: shell,
      options: [{ optionId: 'a', kind: 'allow_always' }],
    }),
    { outcome: { outcome: 'cancelled' } },
  );
  const own = { title: 'mcp__sage_0123456789ab__momo_memory_read', kind: 'other' };
  assert.deepEqual(
    await t.host.onAgentRequest(momo.agent, 'session/request_permission', { sessionId: momo.sessionId, toolCall: own, options }),
    {
      outcome: { outcome: 'selected', optionId: 'a' },
    },
  );
  assert.equal(t.kinds().includes('permission'), false, 'no card for the isolated chat');
  const pending = t.host.onAgentRequest(code.agent, 'session/request_permission', { sessionId: code.sessionId, toolCall: shell, options });
  await settle();
  const card = t.events.find((e: any) => e.kind === 'permission');
  assert.equal(card.key, KEY);
  t.host.permission(card.requestId, 'a');
  assert.deepEqual(await pending, { outcome: { outcome: 'selected', optionId: 'a' } });
  t.host.closeAll();
});

test('an instructions file reachable from an isolated chat’s folder keeps it from opening; a coding chat opens', async () => {
  const t = world();
  const ws = folder();
  fs.writeFileSync(path.join(ws, 'AGENTS.md'), 'always say PAPAYA');
  await assert.rejects(t.host.ensure(MOMO, { cwd: ws }), /would load .*AGENTS\.md/);
  assert.equal((await t.host.ensure(KEY, { cwd: ws })).isolated, false);
  t.host.closeAll();
});

test('reachable instructions: the folder itself, and up to the root of the git project it is in', () => {
  const root = folder();
  const inner = path.join(root, 'a', 'b');
  fs.mkdirSync(inner, { recursive: true });
  assert.deepEqual(reachableInstructions(inner), []);
  // outside a git project, a parent's file is not read
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'x');
  assert.deepEqual(reachableInstructions(inner), []);
  fs.mkdirSync(path.join(root, '.git'));
  assert.deepEqual(reachableInstructions(inner), [path.join(root, 'CLAUDE.md')]);
  fs.writeFileSync(path.join(inner, 'CONTEXT.md'), 'x');
  assert.deepEqual(reachableInstructions(inner), [path.join(inner, 'CONTEXT.md'), path.join(root, 'CLAUDE.md')]);
});

test('an isolated chat gets none of MoPilot’s plugin servers; a coding chat does', async () => {
  let asked = 0;
  const plugins = { forAcp: async () => (asked++, { mcpServers: [{ name: 'plug' }], release: () => undefined, withheld: [] }) };
  const t = world({ plugins });
  const ws = folder();
  await t.host.ensure(MOMO, { cwd: ws });
  assert.equal(asked, 0);
  const servers = (p: any) => p.received.find((m: any) => m.method === 'session/new').params.mcpServers.map((s: any) => s.name);
  assert.deepEqual(servers(t.sp.procs[0]), ['sage_0123456789ab']);
  await t.host.ensure(KEY, { cwd: ws });
  assert.deepEqual(servers(t.sp.procs[1]), ['sage_0123456789ab', 'plug']);
  t.host.closeAll();
});

test('the confined process going away ends only its own chats, and the next isolated chat starts a new one', async () => {
  const t = world();
  const ws = folder();
  const momo = await t.host.ensure(MOMO, { cwd: ws });
  await t.host.ensure(KEY, { cwd: ws });
  t.sp.procs[0].exit(1);
  await settle();
  assert.equal(t.host.chats.has(MOMO), false);
  assert.equal(t.host.chats.has(KEY), true);
  assert.equal(t.host.isolatedAgents.size, 0);
  const again = await t.host.ensure(MOMO, { cwd: ws });
  assert.notEqual(again.agent, momo.agent);
  t.host.closeAll();
  assert.equal(t.host.isolatedAgents.size, 0);
});

test('isolation helpers: the refusal, the setting guard and the unconfined reason', () => {
  assert.deepEqual(isolation.refusal([{ optionId: 'x', kind: 'reject_always' }]), { outcome: { outcome: 'selected', optionId: 'x' } });
  assert.deepEqual(isolation.refusal(undefined), { outcome: { outcome: 'cancelled' } });
  assert.equal(isolation.unconfined({ label: 'L', isolation: { env: () => ({}), mode: { mode: 'm' } } }), null);
  assert.match(isolation.unconfined(null), /^This harness can't run MoMo's chats/);
  // a chat that isn't isolated, or a pin that isn't asked about
  isolation.guardSetting({ isolated: false }, null, { modeId: 'x' });
  isolation.guardSetting({ isolated: true }, { configOption: 'mode', value: 'm' }, { configId: 'model', value: 'x' });
  assert.throws(() => isolation.guardSetting({ isolated: true }, null, { modeId: 'x' }), /keep their own mode/);
  assert.throws(() => isolation.guardSetting({ isolated: true }, null, { configId: 'mode', value: 'x' }), /keep their own mode/);
});

test('a pinned mode set on an agent that answers without its options is taken all the same', async () => {
  const both = [MODE_OPTION('build'), { id: 'model', name: 'Model', type: 'select', currentValue: 'a', options: [{ value: 'a' }] }];
  const t = world({
    handlers: { 'session/new': () => ({ sessionId: 's1', configOptions: both }), 'session/set_config_option': () => ({}) },
  });
  const chat = await t.host.ensure(MOMO, { cwd: folder() });
  assert.deepEqual(
    chat.state.configOptions.map((o: any) => o.currentValue),
    ['momo', 'a'],
  );
  t.host.closeAll();
  // a session with no config options at all has no mode for MoMo
  const bare = world({ handlers: { 'session/new': () => ({ sessionId: 's1' }) } });
  await assert.rejects(bare.host.ensure(MOMO, { cwd: folder() }), /has no mode mode for MoMo's chats/);
  bare.host.closeAll();
});

test('the quirks contract: an isolation quirk is checked', () => {
  const quirks = require('../electron/harness/quirks/index.cjs');
  const base = { label: 'X', bins: ['x'], args: [], privacyDefaults: [], admission: { handshakeTimeoutMs: 1 } };
  assert.deepEqual(quirks.validate({ ...base, isolation: { env: () => ({}), mode: { mode: 'm' } } }), []);
  assert.deepEqual(quirks.validate({ ...base, isolation: { env: () => ({}), mode: { configOption: 'mode', value: 'm' } } }), []);
  for (const bad of [{}, { env: {}, mode: { mode: 'm' } }, { env: () => ({}) }, { env: () => ({}), mode: { configOption: 'mode' } }])
    assert.deepEqual(quirks.validate({ ...base, isolation: bad }), ['isolation'], JSON.stringify(bad));
});

test('no MoMo chat starts, on any harness, in a workspace an instructions file would load from', () => {
  const { assertCleanWorkspace } = require('../electron/momo/apart.cjs');
  const ws = folder();
  assertCleanWorkspace(ws);
  fs.writeFileSync(path.join(ws, 'CLAUDE.md'), 'x');
  assert.throws(() => assertCleanWorkspace(ws), { code: 'instructions', message: /MoMo's workspace would load .*CLAUDE\.md/ });
});
