// The gateway as main opens it (electron/app/gatewayWiring.cjs) and its IPC (electron/app/ipc/gateway.cjs, #2999 C2), end to end over a real HTTP MCP server: no window needed; a server added over IPC starts and offers its tools in main's Registry to a non-MoMo chat, whose change asks on the chat's own card (hostAsk, through the real ApprovalBroker, naming the chat's harness); a credential goes in and never comes back; every change reaches the windows as gateway:changed; bad input is refused with a sentence; quitting ends it all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { createRequire } from 'node:module';
import { fakeSafe } from './support/momo-fixtures.ts';
import { tick } from './support/gatewayWorld.ts';
import { httpServer } from './support/gatewayHttpServer.ts';

const require = createRequire(import.meta.url);
const { openGateway } = require('../electron/app/gatewayWiring.cjs');
const ipc = require('../electron/app/ipc/gateway.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { ApprovalBroker } = require('../electron/capabilities/contract/approvals.cjs');
const { segmentKey } = require('../electron/platform/segmentOwner.cjs');
const { MOMO_META_KEY } = await import('../shared/momoChat.mjs');

const settled = async () => {
  for (let i = 0; i < 40; i++) await tick();
};

function mainWorld(o: { broker?: boolean } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-main-'));
  after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const approvals: any[] = [];
  const broker = new ApprovalBroker({
    controller: { addApproval: (chatId: string, a: any) => approvals.push({ chatId, ...a }), resolveApproval: () => true },
  });
  const seg = segmentKey('codex', 'thread-1');
  const live: any = {
    capabilities: new Registry(),
    chats: {
      records: new Map<string, any>([
        ['chat-1', { meta: {}, segments: [{ kind: 'codex', nativeId: 'thread-1' }] }],
        ['momo', { meta: { [MOMO_META_KEY]: 'main' }, segments: [{ kind: 'codex', nativeId: 'thread-1' }] }],
      ]),
    },
    computerUse: o.broker === false ? null : { broker },
    controller: { ref: (chatId: string) => ({ kind: chatId === 'chat-1' ? 'codex' : 'claude' }) },
  };
  const broadcasts: string[] = [];
  const quit = new AbortController();
  const safe = fakeSafe();
  live.gateway = openGateway({
    live,
    userData,
    safeStorage: safe,
    broadcastAll: (c: string) => broadcasts.push(c),
    quitSignal: quit.signal,
    projectOf: async () => '/work/app',
  });
  const handlers = new Map<string, Function>();
  ipc.register({ handle: (c: string, fn: Function) => handlers.set(c, fn) }, { live });
  const send = (channel: string, ...args: any[]) => handlers.get(channel)!({}, ...args);
  return { live, approvals, broker, broadcasts, quit, send, seg, userData, handlers, safe };
}

test('a server added over IPC runs, offers its tools to every chat but MoMo’s, and a change asks on the chat’s card', async () => {
  const h = await httpServer((r) => r.headers.authorization === 'Bearer t0k3n');
  const m = mainWorld();
  assert.deepEqual(await m.send('gateway:list'), { ok: true, state: 'ok', servers: [] });
  const added = await m.send('gateway:add', { name: 'Team', launch: { type: 'http', url: h.url, headers: {} }, auth: 'bearer' });
  assert.equal(added.ok, true);
  assert.ok(m.broadcasts.includes('gateway:changed'));
  assert.deepEqual(await m.send('gateway:connect', added.key, { type: 'bearer', token: 't0k3n' }), { ok: true });
  const listed = await m.send('gateway:list');
  assert.equal(listed.servers[0].status, 'ready');
  assert.equal(listed.servers[0].credential, 'saved');
  // the credential never comes back to a window
  assert.doesNotMatch(JSON.stringify(listed), /t0k3n/);
  const names = m.live.capabilities.list({ chatId: 'chat-1' }).map((t: any) => t.name);
  assert.deepEqual(names, ['mcp_team_' + names[0].split('_')[2] + '_post', 'mcp_team_' + names[0].split('_')[2] + '_whoami']);
  assert.deepEqual(m.live.capabilities.list({ chatId: 'momo' }), []);
  // a read-only tool runs with no card
  const read = await m.live.capabilities.invoke('chat-1', m.seg, names[1], {});
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(m.approvals.length, 0);
  // a change asks on the chat's card, naming its harness; allowing it runs it
  const p = m.live.capabilities.invoke('chat-1', m.seg, names[0], {});
  await settled();
  assert.equal(m.approvals.length, 1);
  assert.equal(m.approvals[0].chatId, 'chat-1');
  assert.equal(m.approvals[0].method, 'sage/gatewayTool');
  assert.equal(m.approvals[0].params.harness, 'codex');
  assert.match(m.approvals[0].params.title, /^Run post on Team\?$/);
  m.broker.answer(m.approvals[0].id, { decision: 'allow', choice: 'allow' });
  const done = await p;
  assert.equal(done.ok, true);
  assert.match(done.content[0].text, /<mcp_answer>\nposted\n<\/mcp_answer>/);
  // a segment no chat owns is refused
  const foreign = await m.live.capabilities.invoke('chat-1', 'codex:other', names[1], {});
  assert.equal(foreign.ok, false);
  // restart, disconnect and remove
  assert.deepEqual(await m.send('gateway:restart', added.key), { ok: true });
  assert.deepEqual(await m.send('gateway:disconnect', added.key), { ok: true });
  assert.equal((await m.send('gateway:list')).servers[0].status, 'needs_credentials');
  assert.deepEqual(m.live.capabilities.list({ chatId: 'chat-1' }), []);
  assert.deepEqual(await m.send('gateway:remove', added.key), { ok: true });
  assert.deepEqual((await m.send('gateway:list')).servers, []);
  m.quit.abort();
});

test('with no card to show (computer use not open), a change runs nothing; quitting ends every client and offer', async () => {
  const h = await httpServer(() => true);
  const m = mainWorld({ broker: false });
  const added = await m.send('gateway:add', { name: 'Team', launch: { type: 'http', url: h.url, headers: {} } });
  await settled();
  const names = m.live.capabilities.list({ chatId: 'chat-1' }).map((t: any) => t.name);
  assert.equal(names.length, 2);
  const r = await m.live.capabilities.invoke('chat-1', m.seg, names[0], {});
  assert.equal(r.error.code, 'denied');
  assert.equal(h.seen.filter((s) => s.url).length > 0, true);
  m.quit.abort();
  assert.deepEqual(m.live.capabilities.list({ chatId: 'chat-1' }), []);
  assert.equal(m.live.gateway.upstreams.running.size, 0);
  assert.ok(added.ok);
});

test('IPC refuses what isn’t a server or a credential with a sentence, and says when the gateway has not started', async () => {
  const m = mainWorld();
  assert.deepEqual(await m.send('gateway:add', { name: '', launch: {} }), {
    ok: false,
    error: 'A server needs a name of at most 64 characters',
  });
  for (const channel of ['gateway:remove', 'gateway:connect', 'gateway:disconnect', 'gateway:restart'])
    for (const key of [5, '', 'x'.repeat(8193), null])
      assert.deepEqual(await m.send(channel, key), { ok: false, error: 'Not a managed server' }, channel);
  const added = await m.send('gateway:add', {
    name: 'b',
    launch: { type: 'http', url: 'https://b.example/', headers: {} },
    auth: 'bearer',
  });
  const bad = await m.send('gateway:connect', added.key, { type: 'bearer', token: 'a\nb' });
  assert.equal(bad.ok, false);
  assert.doesNotMatch(bad.error, /a\nb/);
  const handlers = new Map<string, Function>();
  ipc.register({ handle: (c: string, fn: Function) => handlers.set(c, fn) }, { live: {} });
  assert.deepEqual(await handlers.get('gateway:list')!({}), { ok: false, error: 'The gateway has not started' });
  // without a Registry (no tools opened) the gateway still runs, with nothing offered
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-main-'));
  after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const quit = new AbortController();
  const g = openGateway({
    live: {},
    userData,
    safeStorage: fakeSafe(),
    broadcastAll: () => {},
    quitSignal: quit.signal,
    projectOf: async () => null,
  });
  assert.deepEqual(g.view(), { state: 'ok', servers: [] });
  quit.abort();
  m.quit.abort();
});

test('W3: a locked store answers in the gateway’s words, never MoMo’s, and nothing is saved', async () => {
  const m = mainWorld();
  m.safe.available = false;
  const r = await m.send('gateway:add', { name: 'b', launch: { type: 'http', url: 'https://b.example/', headers: {} } });
  assert.deepEqual(r, {
    ok: false,
    error: 'The gateway can’t open its saved servers and credentials right now (the system keychain is unavailable)',
  });
  m.safe.available = true;
  m.safe.failEncrypt = true;
  const w = await m.send('gateway:add', { name: 'b', launch: { type: 'http', url: 'https://b.example/', headers: {} } });
  assert.deepEqual(w, {
    ok: false,
    error: 'The gateway can’t encrypt its saved data right now (the system keychain is unavailable), so nothing was saved',
  });
  m.safe.failEncrypt = false;
  assert.deepEqual((await m.send('gateway:list')).servers, []);
  m.quit.abort();
});

test('the renderer’s types declare exactly the bridge’s gateway calls, and each bridge call has its IPC handler', async () => {
  await import('../src/lib/native/gateway.ts');
  const bridge = require('../electron/bridge/gateway.cjs');
  const text = fs.readFileSync(path.join(import.meta.dirname, '../src/lib/native/gateway.ts'), 'utf8');
  const block = text.slice(text.indexOf('gateway: {'), text.indexOf('};', text.indexOf('gateway: {')));
  const declared = [...block.matchAll(/^\s+(\w+)\(/gm)].map((m) => m[1]).sort();
  assert.deepEqual(declared, Object.keys(bridge).sort());
  const handlers = new Map<string, Function>();
  ipc.register({ handle: (c: string, fn: Function) => handlers.set(c, fn) }, { live: {}, shell: {} });
  for (const [name, spec] of Object.entries<any>(bridge)) if (spec.kind === 'invoke') assert.ok(handlers.has(spec.channel), name);
});

test('rules over IPC: list, add, remove and reset; a bad rule or id is refused with a sentence; every change reaches the windows', async () => {
  const m = mainWorld();
  assert.deepEqual(await m.send('gateway:rules'), { ok: true, rules: [], state: 'ok', invalid: 0 });
  const added = await m.send('gateway:addRule', { connector: '*', pattern: 'delete_*', stance: 'block', scope: 'all' });
  assert.equal(added.ok, true);
  assert.equal(added.rule.pattern, 'delete_*');
  assert.ok(m.broadcasts.includes('gateway:changed'));
  assert.equal((await m.send('gateway:rules')).rules.length, 1);
  assert.deepEqual(await m.send('gateway:addRule', { stance: 'block' }), {
    ok: false,
    error: 'Not a rule: it needs a server, a tool pattern, a stance and a scope',
  });
  for (const bad of [null, 'block', 5])
    assert.deepEqual(await m.send('gateway:addRule', bad), {
      ok: false,
      error: 'Not a rule: it needs a server, a tool pattern, a stance and a scope',
    });
  for (const id of [5, '', 'x'.repeat(65)]) assert.deepEqual(await m.send('gateway:removeRule', id), { ok: false, error: 'Not a rule' });
  assert.deepEqual(await m.send('gateway:removeRule', added.rule.id), { ok: true });
  await m.send('gateway:addRule', { connector: '*', pattern: '*', stance: 'ask', scope: 'all' });
  assert.deepEqual(await m.send('gateway:resetRules'), { ok: true });
  assert.deepEqual((await m.send('gateway:rules')).rules, []);
  m.quit.abort();
});

test('the wiring’s card is the gatewayTool kind with Always allow, for the chat’s harness; one whose harness can’t be read offers none', async () => {
  const h = await httpServer(() => true);
  const m = mainWorld();
  m.live.controller = { ref: () => ({ kind: 'codex' }), state: { get: () => ({ permission: 'default' }) } };
  const added = await m.send('gateway:add', { name: 'Team', launch: { type: 'http', url: h.url, headers: {} } });
  await settled();
  const names = m.live.capabilities.list({ chatId: 'chat-1' }).map((t: any) => t.name);
  const p = m.live.capabilities.invoke('chat-1', m.seg, names[0], {});
  await settled();
  assert.equal(m.approvals[0].method, 'sage/gatewayTool');
  assert.deepEqual(
    m.approvals[0].params.choices.map((c: any) => c.id),
    ['once', 'always'],
  );
  const before = m.broadcasts.length;
  m.broker.answer(m.approvals[0].id, { decision: 'allow', choice: 'always' });
  assert.equal((await p).ok, true);
  const saved = (await m.send('gateway:rules')).rules[0];
  // for this chat's harness in its project, and every window heard it
  assert.deepEqual([saved.connector, saved.stance, saved.scope, saved.harness], [added.key, 'allow', 'project:/work/app', 'codex']);
  assert.ok(m.broadcasts.slice(before).includes('gateway:changed'));
  // the rule now allows it: no second card
  assert.equal((await m.live.capabilities.invoke('chat-1', m.seg, names[0], {})).ok, true);
  assert.equal(m.approvals.length, 1);
  // a chat whose settings can't be read (no harness known): no Always allow, so no rule for every harness
  await m.send('gateway:resetRules');
  m.live.controller = { ref: () => ({ kind: 'codex' }) };
  const q = m.live.capabilities.invoke('chat-1', m.seg, names[0], {});
  await settled();
  assert.deepEqual(
    m.approvals[1].params.choices.map((c: any) => c.id),
    ['once'],
  );
  m.broker.answer(m.approvals[1].id, { decision: 'allow', choice: 'always' });
  assert.equal((await q).ok, true);
  assert.deepEqual((await m.send('gateway:rules')).rules, []);
  m.quit.abort();
});

test('the wiring reads each chat’s permission from main’s session settings: Full access runs a change with no card', async () => {
  const h = await httpServer(() => true);
  const m = mainWorld();
  m.live.controller = {
    ref: (chatId: string) => {
      if (chatId !== 'chat-1') throw new Error('no such chat');
      return { kind: 'codex' };
    },
    state: { get: () => ({ permission: 'full-access' }) },
  };
  await m.send('gateway:add', { name: 'Team', launch: { type: 'http', url: h.url, headers: {} } });
  await settled();
  const names = m.live.capabilities.list({ chatId: 'chat-1' }).map((t: any) => t.name);
  const r = await m.live.capabilities.invoke('chat-1', m.seg, names[0], {});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(m.approvals.length, 0, 'Full access: no card');
  // a chat main can't resolve is not Full access (and sees the tools as any chat does)
  assert.equal(m.live.capabilities.list({ chatId: 'ghost' }).length, 2);
  m.quit.abort();
});

test('every card kind main may ask for (gatewayTool included) is one the renderer’s approval params name', async () => {
  await import('../src/lib/native/contracts/control.ts');
  const { KINDS } = require('../electron/capabilities/contract/approvals.cjs');
  const text = fs.readFileSync(path.join(import.meta.dirname, '../src/lib/native/contracts/control.ts'), 'utf8');
  const union = text.slice(text.indexOf('kind:', text.indexOf('export interface SageApprovalParams')));
  const named = new Set([...union.slice(0, union.indexOf(';')).matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]));
  assert.ok(KINDS.has('gatewayTool'));
  assert.deepEqual(
    [...KINDS].filter((k: string) => !named.has(k)),
    [],
  );
});

test('C4 wiring: Codex’s tool injection, a basic harness’s OwnMcp and the plugin delivery get the gateway’s check; a managed change restarts the basic harness', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-main-'));
  after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const seen: unknown[] = [];
  const live: any = { codexTools: {}, acpOwnMcp: { changed: (g?: string) => void seen.push(g) } };
  const quit = new AbortController();
  const g = openGateway({
    live,
    userData,
    safeStorage: fakeSafe(),
    broadcastAll: () => {},
    quitSignal: quit.signal,
    projectOf: async () => null,
  });
  const entry = { command: 'npx', args: ['-y', '@acme/github-mcp'] };
  assert.equal(live.codexTools.managedServer(entry), false);
  await g.add({ name: 'gh', launch: { type: 'stdio', ...entry, env: {} } });
  assert.equal(live.codexTools.managedServer(entry), true);
  assert.equal(live.codexTools.managedSig(), JSON.stringify([...g.managedKeys()]), 'a warm thread’s key reads the managed set');
  assert.equal(live.acpOwnMcp.managed(entry), true);
  const { pluginDelivery } = require('../electron/plugins/service.cjs');
  assert.equal(pluginDelivery().managed({ type: 'stdio', ...entry, env: {} }), true);
  // the set at startup, then again after the add
  assert.equal(seen[0], '[]');
  assert.ok(seen.includes(JSON.stringify([...g.managedKeys()])));
  quit.abort();
  // without Codex's tools or a basic harness (neither opened), the gateway still opens
  const bare = openGateway({
    live: {},
    userData,
    safeStorage: fakeSafe(),
    broadcastAll: () => {},
    quitSignal: new AbortController().signal,
    projectOf: async () => null,
  });
  assert.deepEqual(
    bare.view().servers.map((s: any) => s.name),
    ['gh'],
  );
});

test('gatewayDenials: Claude Code gets the gateway’s deny entries only once main’s gateway has opened', async () => {
  const { gatewayDenials } = require('../electron/app/gatewayManaged.cjs');
  const denials = [{ serverCommand: ['npx', '-y', 'x'] }];
  assert.deepEqual(gatewayDenials({}), []);
  assert.deepEqual(gatewayDenials({ gateway: null }), []);
  assert.deepEqual(gatewayDenials({ gateway: { nativeDenials: () => denials } }), denials);
});
