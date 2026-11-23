// Whole-repository rule (#2139): no Codex thread of a MoMo chat has Codex's own shell, exec or image tools, on any path
// that starts, resumes, forks, claims or switches it. A thread's start params carry the switches (FEATURES_OFF) and the
// app-server's own home (MoMo's, codexMomoHome.cjs) carries them for every thread on it; a run first confirms they hold
// (CodexIsolation.shellOff), since Codex's answer to a thread's start lists no tools to look at. Found by a probe of the
// real app, where a MoMo chat's code mode listed `exec_command`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setup, settle, thread, SHELL_OFF_CONFIG } from './support/codex-harness/fixture.ts';

export const GUARDS = ['electron/'];

const require = createRequire(import.meta.url);
const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { ISOLATED_THREAD, FEATURES_OFF, CodexIsolation } = require('../electron/harness/codexIsolation.cjs');
const { codexPrewarm } = require('../electron/harness/codexPrewarm.cjs');
const { SwitchRunner } = require('../electron/session/switch.cjs');
const { isolateMomoChats } = require('../electron/app/momo.cjs');

const ALL_OFF = Object.fromEntries(Object.keys(FEATURES_OFF).map((k) => [k, false]));
/** The MCP servers the user's own Codex config defines: MoMo's own Codex home defines none of them (#2330). */
const USER_SERVERS = ['node_repl', 'rea'];

function rig(hasTools: boolean) {
  const momo = new Set(['momo-chat']);
  const tools = new CodexToolInjection({
    sessions: new ToolSessions(),
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => 1,
    hasTools: () => hasTools,
    pluginConfig: () => ({}),
    nativeEnabled: () => true,
    disableUserNodeRepl: () => true,
  });
  const ctx = setup(
    {
      // the user's own Codex config, which the adapter reads before it opens a thread
      'config/read': () => ({
        config: { ...SHELL_OFF_CONFIG.config, mcp_servers: Object.fromEntries(USER_SERVERS.map((n) => [n, { command: 'x' }])) },
      }),
      'thread/start': () => ({ thread: thread('th-new') }),
      'thread/fork': () => ({ thread: thread('th-fork') }),
    },
    { isolated: (chat: string) => momo.has(chat), tools },
  );
  // a chat's threads: the chat's own id, as the adapter names a chat's thread
  ctx.a.chatOf = (id: string) => (id.startsWith('momo') ? 'momo-chat' : id);
  return { ...ctx, momo };
}

/** What a thread-opening request carried: every Codex switch off, and no entry for a server of the user's. */
function assertIsolated(params: any, label: string) {
  const config = params.config ?? {};
  for (const k of Object.keys(ALL_OFF)) assert.equal(config.features?.[k], false, `${label}: ${k}`);
  for (const name of USER_SERVERS) assert.equal(config.mcp_servers?.[name], undefined, `${label}: no entry for ${name}`);
  assert.equal(config.plugins?.['unified-computer-use@openai-bundled']?.enabled, false, `${label}: the bundled plugin`);
  // the mark itself never reaches Codex
  assert.equal(JSON.stringify(params).includes('isolated'), false, `${label}: the mark stays here`);
}

for (const hasTools of [true, false]) {
  test(`#2139: every request that opens a MoMo chat's Codex thread carries isolation: start, resume, fork and helper (tools: ${hasTools})`, async () => {
    const r = rig(hasTools);
    // MoMo's own start, and a switch's new thread
    await r.a.startThread({ [ISOLATED_THREAD]: true, cwd: '/momo' });
    // a resume (a restart, a recycled thread) and a fork (a handoff note's, a side chat)
    await r.a.ensureResumed('momo-th');
    await r.a.fork({ threadId: 'momo-th', excludeTurns: true });
    // a helper thread of an isolated chat
    await r.a.request('thread/start', { [ISOLATED_THREAD]: true, cwd: '/momo', ephemeral: true }, { helper: true });
    await settle();
    const opened = ['thread/start', 'thread/resume', 'thread/fork'].flatMap((m) => r.server.params(m).map((p: any) => [m, p]));
    assert.equal(opened.length, 4);
    for (const [method, params] of opened) assertIsolated(params, method);
    // a coding chat's threads stay as they were: its shell is its own, and its user servers are switched off the old way
    await r.a.startThread({ cwd: '/code' });
    const plain = r.server.params('thread/start').at(-1);
    assert.equal(plain.config?.features?.shell_tool, undefined);
  });
}

test('#2139: each request that opens a thread is listed here with why it never opens a MoMo chat’s thread without isolation', () => {
  // every file that names a thread-opening method: where a new opener would have to be decided on
  const OPENERS: Record<string, string> = {
    'electron/harness/codexTurns.cjs':
      'startThread/fork carry the mark or the gate adds it; the title helper never starts for an isolated chat; the note fork is gated',
    'electron/harness/codexLeases.cjs': 'resume: CodexIsolation.gate marks it for a thread of an isolated chat',
    'electron/harness/codexPrewarm.cjs': 'a composer’s thread: never warmed for isolated params (key is null)',
    'electron/harness/bindings.cjs': 'capability names a window may ask for, not requests',
    'electron/harness/versions.cjs': 'the methods the version probe knows',
    'electron/harness/codexConnection.cjs': 'checks isolation before preparing the request for dispatch',
    'electron/harness/codexOutgoing.cjs': 'decorates the gate’s request and keeps its isolation marker through dispatch',
    'electron/harness/codexIsolation.cjs': 'the gate that marks resume and fork',
    'electron/harness/codexIsolatedServer.cjs': 'routes a marked start and every request naming one of its threads',
    'electron/capabilities/channels/codexConfig.cjs': 'the config of every opening request, isolated when marked',
  };
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(cjs|mjs)$/.test(e.name) && /['"`]thread\/(start|resume|fork)['"`]/.test(fs.readFileSync(p, 'utf8')))
        found.push(path.relative(process.cwd(), p));
    }
  };
  walk(path.join(process.cwd(), 'electron'));
  assert.deepEqual(found.sort(), Object.keys(OPENERS).sort());
});

test('#2139: a turn of a MoMo chat runs only while MoMo’s Codex confirms its shell is off, read at each run; another chat’s never asks', async () => {
  let features: any = { shell_tool: false, unified_exec: false, view_image: false };
  let fail = false;
  const r = setup(
    {
      'config/read': () => {
        if (fail) throw new Error('app-server busy');
        return { config: { features } };
      },
      'thread/memoryMode/set': () => ({}),
    },
    { isolated: (chat: string) => chat === 'momo' },
  );
  r.a.chatOf = (id: string) => id;
  const turn = (id: string) => r.a.request('turn/start', { threadId: id, input: [] });
  await turn('momo');
  assert.equal(r.server.params('turn/start').length, 1);
  // routed to MoMo's app-server by the mark, as a start of an isolated chat is
  assert.equal(r.server.params('config/read')[0][ISOLATED_THREAD], true);
  assert.equal(r.server.params('config/read')[0].includeLayers, false);
  // a switch turned back on (a home Codex didn't honour, another copy of Codex): no run, and the chat says why
  features = { ...features, shell_tool: true, view_image: true };
  await assert.rejects(turn('momo'), /Codex's shell isn't confirmed off for this chat \(shell_tool, view_image\), so it doesn't run/);
  assert.equal(r.server.params('turn/start').length, 1);
  // not cached: the next run reads again
  features = { shell_tool: false, unified_exec: false, view_image: false };
  await turn('momo');
  assert.equal(r.server.params('turn/start').length, 2);
  // a read that fails runs nothing either
  fail = true;
  await assert.rejects(turn('momo'), /Couldn't confirm Codex's shell is off for this chat, so it doesn't run: app-server busy/);
  fail = false;
  // a goal, a review, a steer and a compaction are runs too
  features = { shell_tool: true };
  for (const [method, params] of [
    ['turn/steer', { threadId: 'momo' }],
    ['review/start', { threadId: 'momo' }],
    ['thread/compact/start', { threadId: 'momo' }],
    ['thread/goal/set', { threadId: 'momo', status: 'active' }],
  ] as const)
    await assert.rejects(r.a.request(method, params), /Codex's shell isn't confirmed off/, method);
  // a chat that isn't MoMo's asks nothing
  const reads = r.server.params('config/read').length;
  await turn('coding');
  assert.equal(r.server.params('config/read').length, reads);
});

test('#2139: the check reads a switch the answer doesn’t list as off, or an answer with no config at all, as not off', async () => {
  const iso = (read: () => any) => new CodexIsolation({ isolated: () => true, chatOf: (t: string) => t, call: async () => read() });
  await iso(() => SHELL_OFF_CONFIG).shellOff();
  await assert.rejects(iso(() => ({})).shellOff(), /\(shell_tool, unified_exec, view_image\)/);
  await assert.rejects(iso(() => null).shellOff(), /isn't confirmed off/);
  // a read that fails, with an error or with a bare reason
  await assert.rejects(
    iso(() => {
      throw 'down';
    }).shellOff(),
    /Couldn't confirm Codex's shell is off for this chat, so it doesn't run: down/,
  );
  await assert.rejects(
    iso(() => ({ config: { features: { shell_tool: false, unified_exec: true, view_image: false } } })).shellOff(),
    /\(unified_exec\)/,
  );
  await assert.rejects(iso(() => ({ config: { features: { shell_tool: false, unified_exec: false } } })).shellOff(), /\(view_image\)/);
});

test('#2139: a thread warmed for a composer can never be claimed for a MoMo chat: isolated params make no prewarm key', () => {
  const hook = codexPrewarm({ adapter: { provider: () => 'openai' } as any });
  const params = { cwd: '/momo', model: 'm' };
  // the mark is a symbol: JSON keys drop it, so these two reads of the same start would be one warm thread
  assert.equal(typeof hook.key({ kind: 'codex', params }), 'string');
  assert.equal(hook.key({ kind: 'codex', params: { ...params, [ISOLATED_THREAD]: true } }), null);
  assert.equal(hook.key({ kind: 'codex', params: { ...params, [ISOLATED_THREAD]: true, ephemeral: false } }), null);
  assert.equal(hook.key({ kind: 'codex', params: null }), JSON.stringify([null, null]));
});

function switchRunner(startedWith: any[], isolated: boolean, cwdOfOldSession: string | null) {
  const r = new SwitchRunner({
    home: '/home/me',
    prefs: () => ({ permission: 'default' }),
    emit: () => undefined,
    invalidate: () => undefined,
    claim: () => undefined,
    unclaim: () => undefined,
    changed: () => undefined,
    permissionParams: () => ({}),
    git: { info: async () => ({}), status: async () => ({}) },
    ref: () => ({ kind: 'claude', id: 's1', key: 'claude:s1' }),
    chats: { record: () => ({ segments: [{ kind: 'claude', nativeId: 's1', start: 0, count: null }] }), commit: () => true },
    codex: { startThread: async (p: any) => (startedWith.push(p), { thread: { id: 't2' } }) },
    claude: {
      // a session no message started forgets its folder at a restart, and has no transcript to name it
      isFresh: () => false,
      cwdOf: async () => cwdOfOldSession,
      messages: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      accountOf: () => null,
    },
    isolated: () => isolated,
  });
  return r;
}

test('#2139: a MoMo chat switched from Claude Code starts its Codex thread in MoMo’s workspace, never in the home folder', async () => {
  const live: any = { switchRunner: null };
  const started: any[] = [];
  for (const [isolated, expected] of [
    [true, '/data/momo/workspace'],
    [false, '/home/me'],
  ] as const) {
    started.length = 0;
    const r = switchRunner(started, isolated, null);
    // as main wires it (app/momo.cjs isolateMomoChats)
    live.switchRunner = r;
    isolateMomoChats(live, { setIsolated: () => undefined }, () => isolated, '/data/momo/workspace');
    assert.equal((await r.perform('momo-chat', { harness: 'codex', model: 'gpt', mode: 'auto' })).ready, true);
    assert.equal(started[0].cwd, expected);
    assert.equal(started[0][ISOLATED_THREAD] === true, isolated);
  }
  // a MoMo chat the old session does name a folder for still runs in the workspace; the rule is the chat's, not the session's
  started.length = 0;
  const r = switchRunner(started, true, '/Users/me/code');
  live.switchRunner = r;
  isolateMomoChats(live, { setIsolated: () => undefined }, () => true, '/data/momo/workspace');
  await r.perform('momo-chat', { harness: 'codex', model: 'gpt', mode: 'auto' });
  assert.equal(started[0].cwd, '/data/momo/workspace');
  // another chat of the same app keeps the session's folder
  started.length = 0;
  const other = switchRunner(started, false, '/Users/me/code');
  live.switchRunner = other;
  isolateMomoChats(live, { setIsolated: () => undefined }, (id: string) => id === 'momo-chat', '/data/momo/workspace');
  await other.perform('code-chat', { harness: 'codex', model: 'gpt', mode: 'auto' });
  assert.equal(started[0].cwd, '/Users/me/code');
  // no workspace given: nothing changes for anyone
  isolateMomoChats(live, { setIsolated: () => undefined }, () => true);
  assert.equal(other.workspaceOf('momo-chat'), null);
});

test('#2139: the note a MoMo chat’s “new chat with a summary” describes is of its workspace too, not the home folder', async () => {
  const described: string[] = [];
  const r = switchRunner([], true, null);
  r.workspaceOf = (id: string) => (id === 'momo-chat' ? '/data/momo/workspace' : null);
  r.git = {
    info: async (cwd: string) => (described.push(cwd), {}),
    status: async () => ({}),
  };
  r.codex.summarize = async () => 'note';
  r.claude.summarize = async () => 'note';
  r.ref = () => ({ kind: 'claude', id: 's1', key: 'claude:s1' });
  await r.summaryNote('momo-chat', 'Codex');
  await r.summaryNote('code-chat', 'Codex');
  assert.deepEqual(described, ['/data/momo/workspace', '/home/me']);
});
