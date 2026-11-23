// WP0-6: every remote kill switch (electron/platform/flags.cjs) has a consumer. The capability ones are checked
// through the resolver (resolveCaps) and its why-text; the others at the module that reads the switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { DEFAULTS } = require('../electron/platform/flags.cjs');
const { harnessKeys, channelKey, harnessOff, killedReason } = require('../shared/killSwitch.cjs');
const { flagsFor, computeCaps } = require('../electron/session/caps.cjs');
const { resolveCaps, SEMANTICS } = require('../shared/caps.mjs');
const { whyText } = await import('../src/harness/caps.ts');
const { codexThreadConfig, CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { SessionMcp } = require('../electron/capabilities/channels/sessionMcp.cjs');
const { decide, unattendedReason } = require('../electron/capabilities/contract/policy.cjs');
const { VisionFallback, gatedBackend } = require('../electron/capabilities/vision/index.cjs');
const { ChatsStore, flushPendingWrites } = require('../electron/platform/chats.cjs');
const { Admission, binStamp } = require('../electron/harness/admission.cjs');
const { ChatController } = require('../electron/session/controller.cjs');
const { SessionStore } = require('../electron/session/state.cjs');

/** `isEnabled` with these keys off and everything else on. */
const off =
  (...keys: string[]) =>
  (k: string) =>
    !keys.includes(k);

/** The caps a chat of `kind` gets with `keys` switched off. */
function capsWith(kind: string, ...keys: string[]) {
  const flags = flagsFor(off(...keys), {}, kind);
  const bindings = Object.fromEntries(SEMANTICS.map((s: string) => [s, { via: 'rpc', method: s }]));
  return resolveCaps({ tier: kind.startsWith('acp:') ? 'basic' : 'first', bindings, flags });
}
const why = (c: any) => (c.via === 'none' ? c.why : null);

test('every switch the plan names is a known key', () => {
  for (const k of [
    'harness.codex.enabled',
    'harness.claude.enabled',
    'tier.basic.enabled',
    'harness.acp.kimi.enabled',
    'channel.claude.sdkMcp',
    'channel.codex.threadConfigMcp',
    'channel.acp.sessionMcp',
    'shared.computerUse.unattended',
    'shared.visionFallback',
    'codex.disableUserNodeRepl',
    'data.legacyMirror',
  ])
    assert.ok(k in DEFAULTS, k);
  for (const kind of ['codex', 'claude', 'acp:kimi']) for (const k of [...harnessKeys(kind), channelKey(kind)]) assert.ok(k in DEFAULTS, k);
});

for (const [key, kind, label] of [
  ['harness.codex.enabled', 'codex', 'Codex'],
  ['harness.claude.enabled', 'claude', 'Claude Code'],
  ['tier.basic.enabled', 'acp:kimi', 'Kimi Code'],
  ['harness.acp.kimi.enabled', 'acp:kimi', 'Kimi Code'],
] as const) {
  test(`${key}: the chat's harness can do nothing and says why`, () => {
    const caps = capsWith(kind, key);
    for (const s of ['goal', 'plan', 'model', 'computerUse', 'browser', 'shell']) {
      assert.deepEqual(why(caps[s]), { layer: 'flag', code: 'flag.killed.harness' }, s);
      assert.equal(whyText(why(caps[s]), { label, semantic: s as any }), `${label} is turned off for now`);
    }
    // nothing there needs the harness running
    assert.equal(caps.archive.via, 'rpc');
    // another harness's chat is not affected
    const other = capsWith(kind === 'codex' ? 'claude' : 'codex', key);
    assert.equal(other.goal.via, 'rpc');
  });
}

test('tier.basic.enabled leaves the first tier alone', () => {
  assert.equal(capsWith('codex', 'tier.basic.enabled').goal.via, 'rpc');
  assert.equal(capsWith('claude', 'tier.basic.enabled').computerUse.via, 'rpc');
  assert.equal(capsWith('acp:dsh', 'harness.acp.kimi.enabled').goal.via, 'rpc');
});

for (const [key, kind, label] of [
  ['channel.codex.threadConfigMcp', 'codex', 'Codex'],
  ['channel.claude.sdkMcp', 'claude', 'Claude Code'],
  ['channel.acp.sessionMcp', 'acp:kimi', 'Kimi Code'],
] as const) {
  test(`${key}: no computer or browser control, with the reason; chat itself stays`, () => {
    const caps = capsWith(kind, key);
    for (const s of ['computerUse', 'browser'] as const) {
      assert.deepEqual(why(caps[s]), { layer: 'flag', code: 'flag.killed.channel' });
      assert.equal(
        whyText(why(caps[s]), { label, semantic: s }),
        `${label} can't be given ${s === 'computerUse' ? 'computer control' : 'browser control'} right now`,
      );
    }
    assert.equal(caps.goal.via, 'rpc');
    assert.equal(caps.dictation.via, 'rpc');
  });
}

test('the flag layer: a killed harness wins over a harness feature and a killed channel', () => {
  const caps = capsWith('codex', 'harness.codex.enabled', 'channel.codex.threadConfigMcp');
  assert.equal(why(caps.computerUse).code, 'flag.killed.harness');
  const goals = resolveCaps({
    tier: 'first',
    bindings: Object.fromEntries(SEMANTICS.map((s: string) => [s, { via: 'rpc', method: s }])),
    flags: { 'features.goals': false, 'sage.channel': false },
  });
  assert.equal(why(goals.goal).code, 'flag.off.goal');
  assert.equal(why(goals.computerUse).code, 'flag.killed.channel');
});

test('computeCaps for a basic harness reads the same switches', () => {
  const flags = flagsFor(off('harness.acp.kimi.enabled'), {}, 'acp:kimi');
  const caps = computeCaps({
    kind: 'acp:kimi',
    negotiated: null,
    acp: { commands: [], modes: null, configOptions: [], plan: null },
    provider: null,
    model: null,
    account: null,
    flags,
    session: null,
  });
  assert.equal(caps.computerUse.state, 'disabled');
  assert.equal(caps.computerUse.why.code, 'flag.killed.harness');
  const codex = computeCaps({
    kind: 'codex',
    negotiated: null,
    provider: null,
    model: null,
    account: null,
    flags: flagsFor(off('harness.codex.enabled'), {}, 'codex'),
    session: null,
  });
  assert.equal(codex.goal.state, 'disabled');
});

test('killedReason: the first tier only counts its harness switch, the basic tier its channel too', () => {
  assert.equal(killedReason('codex', off('channel.codex.threadConfigMcp')), null);
  assert.match(killedReason('codex', off('harness.codex.enabled')), /Turned off/);
  assert.equal(killedReason('acp:kimi', off('channel.acp.sessionMcp')), null);
  assert.match(killedReason('acp:kimi', off('channel.acp.sessionMcp'), { needsChannel: true }), /tool channel/);
  assert.equal(harnessOff('acp:kimi:abc', off('harness.acp.kimi.enabled')), 'harness.acp.kimi.enabled');
  assert.equal(
    harnessOff('claude', () => true),
    null,
  );
});

/* -- picker and adapters ---------------------------------------------------------------- */
test('admission: a killed basic harness is no longer admitted, so the picker hides it and the host refuses it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-kill-'));
  const file = path.join(dir, 'acp-admission.json');
  const bin = process.execPath;
  fs.writeFileSync(
    file,
    JSON.stringify({
      kimi: { id: 'kimi', state: 'admitted', reason: null, version: '1', authMethods: [], stamp: binStamp(bin), catalog: null },
    }),
  );
  let enabled = off();
  const a = new Admission({
    ids: ['kimi'],
    quirks: () => ({ label: 'Kimi Code' }),
    resolveBin: () => bin,
    env: () => process.env,
    tools: {},
    file,
    killed: (id: string) => killedReason(`acp:${id}`, (k: string) => enabled(k), { needsChannel: true }),
  });
  const row = () => a.list()[0];
  {
    assert.equal(row().state, 'admitted');
    assert.equal(a.admitted('kimi'), true);
    enabled = off('tier.basic.enabled');
    assert.equal(row().state, 'off');
    assert.match(row().reason, /Turned off/);
    assert.equal(a.admitted('kimi'), false);
    enabled = off('channel.acp.sessionMcp');
    assert.equal(row().state, 'off');
    enabled = off();
    assert.equal(row().state, 'admitted');
  }
  const killed = new Admission({
    ids: ['kimi'],
    quirks: () => ({ label: 'Kimi Code' }),
    resolveBin: () => null,
    env: () => process.env,
    tools: {},
    file,
    killed: () => 'x',
  });
  assert.equal(killed.list()[0].state, 'missing', 'only an admitted harness turns off');
});

test('the controller refuses a turn on a killed harness and keeps the message queued', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-kill-'));
  const state = new SessionStore();
  const chats = new ChatsStore(path.join(dir, 'threads'));
  const started: string[] = [];
  let killed: string | null = 'Turned off by MoPilot for now';
  const c = new ChatController({
    state,
    chats,
    killed: () => killed,
    codex: {
      startTurn: async (id: string) => (started.push(id), { started: true }),
      startGoal: async () => ({ started: true }),
      steer: async () => ({ started: true }),
    },
    window: async () => ({ started: true }),
  });
  c.send('t1', { text: 'hi', attachments: [], opts: { human: true } }, 1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, []);
  const s = state.get('t1');
  assert.equal(s.turn, 'crashed');
  assert.equal(s.crashed, 'Turned off by MoPilot for now');
  assert.equal(s.queue.length, 1);
  killed = null;
  c.send('t1', { text: 'again', attachments: [], opts: { human: true } }, 1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, ['t1']);
});

/* -- tool channels ---------------------------------------------------------------------- */
test('channel.codex.threadConfigMcp: off, a thread starts without sage-mcp', () => {
  let on = true;
  const inj = new CodexToolInjection({
    sessions: new ToolSessions(),
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => 1,
    hasTools: () => on,
  });
  const msg = { id: 1, method: 'thread/start', params: { cwd: '/w' } };
  assert.ok(inj.outgoing(msg).params.config.mcp_servers);
  on = false;
  assert.equal(inj.outgoing({ id: 2, method: 'thread/start', params: {} }).params.config, undefined);
});

test('channel.acp.sessionMcp: off, the session gets no tools and is not admitted', async () => {
  let on = false;
  const sessions = new ToolSessions();
  const mcp = new SessionMcp({
    sessions,
    socket: { on() {}, listen: async () => '/tmp/s.sock' },
    command: '/bin/sage-mcp',
    enabled: () => on,
  });
  await assert.rejects(mcp.prepare('k', { harnessPid: 1 }), /turned off/);
  assert.equal(await mcp.admission('k'), false);
  on = true;
  const t = await mcp.prepare('k', { harnessPid: 1 });
  assert.equal(t.mcpServers.length, 1);
});

/* -- codex.disableUserNodeRepl ---------------------------------------------------------- */
test("codex.disableUserNodeRepl: off, the user's node_repl stays on in the thread", () => {
  const args = {
    serverName: 'sage_0123456789ab',
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    token: 'tok',
    userServers: ['node_repl'],
  };
  assert.deepEqual(codexThreadConfig(args).mcp_servers.node_repl, { enabled: false });
  assert.deepEqual(codexThreadConfig({ ...args, disableUserNodeRepl: true }).mcp_servers.node_repl, { enabled: false });
  assert.equal('node_repl' in codexThreadConfig({ ...args, disableUserNodeRepl: false }).mcp_servers, false);
  // the cua_repl plugin is MoPilot's own computer use; it is not this switch
  assert.equal(codexThreadConfig({ ...args, disableUserNodeRepl: false }).plugins['unified-computer-use@openai-bundled'].enabled, false);
  let on = false;
  const inj = new CodexToolInjection({
    sessions: new ToolSessions(),
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => 1,
    disableUserNodeRepl: () => on,
  });
  inj.setUserServers(['node_repl']);
  assert.equal('node_repl' in inj.outgoing({ id: 1, method: 'thread/start', params: {} }).params.config.mcp_servers, false);
  on = true;
  assert.deepEqual(inj.outgoing({ id: 2, method: 'thread/start', params: {} }).params.config.mcp_servers.node_repl, { enabled: false });
});

/* -- shared.computerUse.unattended ------------------------------------------------------ */
test('shared.computerUse.unattended: off, nothing runs while nobody is there, grant or not; a person at the keyboard is not affected', () => {
  const app = { bundleId: 'com.apple.Notes', name: 'Notes' };
  const grants = [{ bundleId: app.bundleId, level: 'full' }];
  const click = { tool: 'computer_click', args: { x: 1, y: 2 }, app, grants };
  for (const away of [
    'a scheduled task',
    'a sub-agent',
    'no input for 10 minutes',
    'a tool call outside a prompt',
    'no turn you started',
    unattendedReason({ turn: { human: false }, idleMs: 1000 }),
  ]) {
    assert.equal(decide({ ...click, unattended: away }).action, 'run', `${away}: allowed while the switch is on`);
    const refused = decide({ ...click, unattended: away, unattendedAllowed: false });
    assert.deepEqual([refused.action, refused.code, refused.pause], ['refuse', 'unattended', true], away);
    assert.match(refused.message, /switched off/);
  }
  assert.equal(decide({ ...click, unattended: null, unattendedAllowed: false }).action, 'run');
  assert.equal(DEFAULTS['shared.computerUse.unattended'], true);
});

/* -- shared.visionFallback -------------------------------------------------------------- */
test('shared.visionFallback: off, no vision model reads the screen; the OCR element list stays', async () => {
  let on = true;
  const backend = { source: 'mopilot', vendor: 'MoPilot', model: 'v', crossVendor: true };
  const v = new VisionFallback({
    backendFor: gatedBackend(
      () => on,
      async () => backend,
    ),
    read: async () => '',
    broker: {},
  });
  assert.equal((await v.plan('c1', 'text')).locate, true);
  on = false;
  const p = await v.plan('c1', 'text');
  assert.deepEqual([p.kinds, p.ocr, p.locate, p.backend], [['elements'], true, false, null]);
});

/* -- data.legacyMirror ------------------------------------------------------------------ */
test('data.legacyMirror: asked at each write; off, the frozen legacy keys stop being written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-kill-'));
  const ui = path.join(dir, 'ui-state.json');
  fs.writeFileSync(ui, JSON.stringify({ prefs: {} }));
  const pinned = () => (flushPendingWrites(), JSON.parse(fs.readFileSync(ui, 'utf8')).pinned ?? {});
  let on = true;
  const store = new ChatsStore(path.join(dir, 'threads'), { uiState: ui, legacyMirror: () => on });
  store.patchMeta('cx-1', { pinned: true });
  assert.deepEqual(pinned(), { 'cx-1': true }, 'mirrored while on');
  on = false;
  store.patchMeta('cx-2', { pinned: true });
  assert.deepEqual(pinned(), { 'cx-1': true }, 'not written while off');
  assert.equal(store.get('cx-2').meta.pinned, true, 'the chat itself is still saved');
  on = true;
  store.patchMeta('cx-3', { pinned: true });
  assert.deepEqual(Object.keys(pinned()).sort(), ['cx-1', 'cx-2', 'cx-3'], 'on again: everything catches up');
  // a plain boolean still works
  const ui2 = path.join(dir, 'ui2.json');
  fs.writeFileSync(ui2, JSON.stringify({ prefs: {} }));
  new ChatsStore(path.join(dir, 'threads2'), { uiState: ui2, legacyMirror: false }).patchMeta('cx-4', { pinned: true });
  assert.equal(JSON.parse(fs.readFileSync(ui2, 'utf8')).pinned, undefined);
});

test("MoPilot's plugins: a binding on every family, and plugins.<family> off takes them from that family only", () => {
  const { codexBindings, claudeBindings, acpBindings } = require('../electron/harness/bindings.cjs');
  assert.deepEqual(codexBindings(null).plugins, { via: 'config', option: 'plugins', value: true });
  assert.deepEqual(claudeBindings().plugins, { via: 'config', option: 'plugins', value: true });
  assert.deepEqual(acpBindings(null).plugins, { via: 'polyfill', engine: 'plugins' });
  const off = (key: string) => (k: string) => k !== key;
  assert.equal(flagsFor(off('plugins.acp'), null, 'acp:opencode')['sage.plugins'], false);
  assert.equal('sage.plugins' in flagsFor(off('plugins.acp'), null, 'claude'), false);
  assert.equal(flagsFor(off('plugins.codex'), null, 'codex')['sage.plugins'], false);
  assert.equal(flagsFor(off('plugins.claude'), null, 'claude')['sage.plugins'], false);
  assert.equal('sage.plugins' in flagsFor(() => true, null, null), false);
  assert.ok(SEMANTICS.includes('plugins'));
  for (const f of ['codex', 'claude', 'acp']) assert.equal(DEFAULTS[`plugins.${f}`], true, f);
});

test("Claude Code's plugins count once its CLI loaded the plugin folders (the claude.pluginDirs probe)", () => {
  const { claudeProbes } = require('../electron/harness/versions.cjs');
  const { PROBES_FOR } = require('../electron/harness/bindings.cjs');
  assert.deepEqual(PROBES_FOR.claude.plugins, ['claude.pluginDirs']);
  assert.equal(claudeProbes({ probe: 'ok', pluginDirs: true })['claude.pluginDirs'], true);
  assert.equal(claudeProbes({ probe: 'ok', pluginDirs: false })['claude.pluginDirs'], false);
  assert.equal('claude.pluginDirs' in claudeProbes({ probe: 'ok' }), false);
});

test('a chat that runs Claude Code or Codex on a machine answers to no switch of this Mac’s harnesses, and a basic agent of that name would still', () => {
  for (const kind of ['acp:host-claude', 'acp:host-codex:u1']) {
    assert.deepEqual(harnessKeys(kind), [], kind);
    assert.equal(
      harnessOff(kind, () => false),
      null,
      kind,
    );
  }
  assert.deepEqual(harnessKeys('acp:kimi'), ['tier.basic.enabled', 'harness.acp.kimi.enabled']);
});
