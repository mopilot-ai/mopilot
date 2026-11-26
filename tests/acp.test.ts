// The generic ACP adapter (electron/harness/acp.cjs) against tests/fixtures/fake-acp-agent.mjs: initialize,
// session/new with the tool channel, prompt and streaming, permissions (sage_<nonce> auto-allowed once),
// cancel and the second cancel for unattended work, fs/* and terminal/*, and reopening a session from
// the transcript after a restart (session/load, session/resume, or a new session).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { readJsonLineLog } from '../scripts/fixture-json-log.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcriptFixture } from './support/transcript-fixture.ts';
import { acpFixtureStop } from './support/acp-fixture-stop.mjs';

const require = createRequire(import.meta.url);
const acp = require('../electron/harness/acp.cjs');
const { ItemsLog } = require('../electron/platform/chats.cjs');
const pty = require('../electron/platform/pty.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT = path.join(ROOT, 'tests/fixtures/fake-acp-agent.mjs');
const MCP_SERVER = path.join(ROOT, 'tests/conformance/lib/mcp-server.mjs');
const SERVER = 'sage_0123456789ab';

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sage-acp-')));
const fixture = transcriptFixture(dir);
after(() => fixture.cleanup());

function setup(o: { profile?: object; admit?: boolean; items?: string; state?: string; host?: object } = {}) {
  const log = path.join(dir, `agent-${Math.random().toString(36).slice(2)}.jsonl`);
  const items = fixture.own(new ItemsLog(o.items ?? path.join(dir, `threads-${Math.random().toString(36).slice(2)}`)));
  const events: any[] = [];
  const prepared: any[] = [];
  const host = new acp.AcpHost({
    items,
    quirks: (id: string) =>
      id === 'fake'
        ? {
            label: 'Fake',
            args: [AGENT],
            env: {
              FAKE_ACP_LOG: log,
              FAKE_ACP_STATE: o.state ?? path.join(dir, 'state'),
              FAKE_ACP_PROFILE: JSON.stringify(o.profile ?? {}),
            },
          }
        : null,
    ids: ['fake'],
    ...o.host,
    resolveBin: () => process.execPath,
    env: () => process.env,
    pty,
    cwd: dir,
    tools: {
      prepare: async (key: string, p: any) => {
        prepared.push({ key, ...p });
        return { serverName: SERVER, mcpServers: [{ name: SERVER, command: process.execPath, args: [MCP_SERVER, 'HELLO'], env: [] }] };
      },
      admission: async () => o.admit !== false,
      end: () => {},
    },
  });
  fixture.stopWith(acpFixtureStop(host));
  host.on('event', (e: any) => {
    events.push(e);
    // answer permission cards as a person would: allow
    if (e.kind === 'permission')
      setTimeout(() => host.permission(e.requestId, e.options.find((x: any) => x.kind === 'allow_once')?.optionId), 5);
  });
  const agentLog = () => readJsonLineLog(log);
  return { host, items, events, prepared, agentLog };
}

const until = async (fn: () => any, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const said = (events: any[], turnId: string) =>
  events
    .filter((e) => e.kind === 'update' && e.turnId === turnId && e.update.sessionUpdate === 'agent_message_chunk')
    .map((e) => e.update.content.text)
    .join('');
const ended = (events: any[], turnId: string) => events.find((e) => e.kind === 'turnEnd' && e.turnId === turnId);
const key = (n: string) => `acp:fake:${n}`;
const text = (t: string) => ({ cwd: dir, blocks: [{ type: 'text', text: t }], display: [{ type: 'text', text: t, text_elements: [] }] });

test('initialize, session/new with sage-mcp, a streamed reply, and the transcript', async () => {
  const { host, events, items, prepared, agentLog } = setup();
  const { turnId } = await host.send(key('a'), text('hello there'), { human: true, uuid: 'u1', chatId: 'chat-a' });
  assert.equal(turnId, 'at-u1');
  const end = await until(() => ended(events, turnId));
  assert.equal(end.stopReason, 'end_turn');
  assert.equal(said(events, turnId), 'fake-acp: hello there');
  // The live session asks for v1 with fs, terminal and bounded form elicitation (no URL capability).
  const init = agentLog().find((l: any) => l.kind === 'in' && l.msg.method === 'initialize');
  assert.equal(init.msg.params.protocolVersion, 1);
  assert.deepEqual(init.msg.params.clientCapabilities, {
    session: { promptSuggestions: {} },
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
    elicitation: { form: {} },
  });
  assert.equal(init.msg.params.clientCapabilities.elicitation.url, undefined, 'live sessions do not advertise URL elicitation');
  // the tool channel was prepared for this chat, and its server went into session/new
  assert.equal(prepared[0].chatId, 'chat-a');
  assert.equal(prepared[0].resume, false);
  const mcp = agentLog().find((l: any) => l.kind === 'mcp');
  assert.equal(mcp.name, SERVER);
  assert.equal(mcp.ok, true);
  // turnStart carries the message as the thread shows it
  const start = events.find((e) => e.kind === 'turnStart');
  assert.deepEqual(start.user, { id: 'u-u1', clientId: 'u1', content: [{ type: 'text', text: 'hello there', text_elements: [] }] });
  assert.equal(start.human, true);
  // and the chat's folder, where main snapshots the turn's changes (electron/session/turnSnapshots.cjs)
  assert.equal(start.cwd, dir);
  const recs = await items.readAsync(key('a'));
  assert.deepEqual(
    recs.map((r: any) => r.t),
    ['session', 'user', ...recs.filter((r: any) => r.t === 'update').map(() => 'update'), 'end'],
  );
  assert.ok(recs[0].sessionId.startsWith('fake-acp-session-'));
  assert.equal(recs[0].cwd, dir);
  const session = events.find((e) => e.kind === 'session');
  assert.equal(session.caps.loadSession, false);
  assert.equal(session.caps.mcp.http, true);
});

test('a permission card, answered by its own options; sage_<nonce> tools are allowed once without one', async () => {
  const { host, events } = setup();
  const { turnId } = await host.send(key('p'), text('PERMIT then SAGEPERMIT'), {});
  await until(() => ended(events, turnId));
  const cards = events.filter((e) => e.kind === 'permission');
  // only the harness's own action asked; MoPilot's tool was auto-allowed
  assert.equal(cards.length, 1);
  assert.deepEqual(
    cards[0].options.map((o: any) => o.kind),
    ['allow_once', 'reject_once'],
  );
  assert.equal(cards[0].toolCall.title, 'Fake action');
  assert.match(said(events, turnId), /\[sage-permit: allow\]/);
});

test('isSageToolCall matches only this session’s random name, where the tool name goes', () => {
  assert.ok(acp.isSageToolCall({ title: `mcp__${SERVER}__computer_click`, kind: 'other' }, SERVER));
  assert.ok(acp.isSageToolCall({ title: 'click', _meta: { claudeCode: { toolName: `mcp__${SERVER}__click` } } }, SERVER));
  assert.ok(acp.isSageToolCall({ title: `click (${SERVER} MCP Server)` }, SERVER));
  assert.ok(!acp.isSageToolCall({ title: 'mcp__sage__click' }, SERVER));
  assert.ok(!acp.isSageToolCall({ title: 'mcp__sage_ffffffffffff__click' }, SERVER));
  // a command that mentions the name is still a command
  assert.ok(!acp.isSageToolCall({ title: `${SERVER}__x; rm -rf /`, kind: 'execute' }, SERVER));
  assert.ok(!acp.isSageToolCall({ title: 'run', rawInput: { command: `mcp__${SERVER}__x` } }, SERVER));
  assert.ok(!acp.isSageToolCall({ title: `mcp__${SERVER}__x` }, null));
});

test('Stop: session/cancel ends the prompt as cancelled', async () => {
  const { host, events, agentLog } = setup();
  const { turnId } = await host.send(key('c'), text('SLOW please'), {});
  await until(() => said(events, turnId));
  assert.equal(host.cancel(key('c')), true);
  const end = await until(() => ended(events, turnId));
  assert.equal(end.stopReason, 'cancelled');
  assert.equal(agentLog().filter((l: any) => l.kind === 'in' && l.msg.method === 'session/cancel').length, 1);
});

test('work with no prompt running is unattended: cancelled again, its permission refused', async () => {
  const { host, events, agentLog } = setup();
  const { turnId } = await host.send(key('l'), text('LATE'), {});
  await until(() => ended(events, turnId));
  const late = await until(() => agentLog().find((l: any) => l.kind === 'latePermit'));
  assert.deepEqual(late.outcome, { outcome: 'cancelled' });
  // a second session/cancel went out, and nobody saw a card
  assert.ok(agentLog().some((l: any) => l.kind === 'in' && l.msg.method === 'session/cancel'));
  assert.ok(events.some((e) => e.kind === 'unattended'));
  assert.ok(!events.some((e) => e.kind === 'permission'));
  // the stray tool call was recorded outside any turn
  assert.ok(events.some((e) => e.kind === 'update' && e.turnId === null && e.update.sessionUpdate === 'tool_call'));
});

test('fs/read_text_file, fs/write_text_file and terminal/* run on this machine', async (t) => {
  const { host, events } = setup();
  const spawned = t.mock.method(pty, 'spawn');
  const file = path.join(dir, 'note.txt');
  fs.writeFileSync(file, 'line one\nline two\n');
  const out = path.join(dir, 'sub', 'out.txt');
  const { turnId } = await host.send(key('f'), text(`FSREAD ${file} FSWRITE ${out} written TERM ptyword`), {});
  await until(() => ended(events, turnId), 10_000);
  const reply = said(events, turnId);
  assert.match(reply, /\[read: line one\nline two\]/);
  assert.equal(fs.readFileSync(out, 'utf8'), 'written');
  assert.match(reply, /\[term: ptyword exit 0\]/);
  // no interactive view answers an agent's terminal: on Windows it answers ConPTY's start-up question itself (pty.cjs)
  assert.equal(spawned.mock.calls.at(-1)?.arguments[1]?.selfAnswer, true);
  assert.deepEqual(acp.readTextFile({ path: file, line: 2, limit: 1 }), { content: 'line two' });
  assert.throws(() => acp.readTextFile({ path: 'relative.txt' }), /absolute/);
});

test('after a restart: session/resume reopens the session from the transcript', async () => {
  const threads = path.join(dir, 'threads-resume');
  const state = path.join(dir, 'state-resume');
  const a = setup({ profile: { resume: true }, items: threads, state });
  const t1 = (await a.host.send(key('r'), text('first'), {})).turnId;
  await until(() => ended(a.events, t1));
  a.host.closeAll();
  const b = setup({ profile: { resume: true }, items: threads, state });
  const t2 = (await b.host.send(key('r'), text('HISTORY'), {})).turnId;
  await until(() => ended(b.events, t2));
  assert.match(said(b.events, t2), /\[history: 1\]/);
  assert.ok(b.agentLog().some((l: any) => l.kind === 'in' && l.msg.method === 'session/resume'));
  assert.equal(b.prepared[0].resume, true);
  assert.equal((await b.items.readAsync(key('r'))).filter((r: any) => r.t === 'session').length, 1);
});

test('after a restart: session/load reopens it, and its replayed history stays out of the transcript', async () => {
  const threads = path.join(dir, 'threads-load');
  const state = path.join(dir, 'state-load');
  const a = setup({ profile: { loadSession: true }, items: threads, state });
  const t1 = (await a.host.send(key('L'), text('first'), {})).turnId;
  await until(() => ended(a.events, t1));
  a.host.closeAll();
  const b = setup({ profile: { loadSession: true }, items: threads, state });
  const t2 = (await b.host.send(key('L'), text('HISTORY'), {})).turnId;
  await until(() => ended(b.events, t2));
  assert.match(said(b.events, t2), /\[history: 1\]/);
  assert.ok(b.agentLog().some((l: any) => l.kind === 'in' && l.msg.method === 'session/load'));
  assert.ok(!b.events.some((e) => e.kind === 'update' && e.update.sessionUpdate === 'user_message_chunk'));
});

test('after a restart without load or resume: a new session, and the chat says so', async () => {
  const threads = path.join(dir, 'threads-new');
  const a = setup({ items: threads });
  const t1 = (await a.host.send(key('n'), text('first'), {})).turnId;
  await until(() => ended(a.events, t1));
  a.host.closeAll();
  const b = setup({ items: threads });
  const t2 = (await b.host.send(key('n'), text('HISTORY'), {})).turnId;
  await until(() => ended(b.events, t2));
  assert.match(said(b.events, t2), /\[history: 0\]/);
  assert.match(b.events.find((e) => e.kind === 'session').note, /can't reopen sessions/);
  assert.equal((await b.items.readAsync(key('n'))).filter((r: any) => r.t === 'session').length, 2);
});

test('no sage-mcp handshake: the send fails with the reason, and the next one tries again', async () => {
  const { host } = setup({ admit: false });
  await assert.rejects(host.send(key('x'), text('hi'), {}), /can't give Fake computer and browser control/);
  assert.equal(host.chats.has(key('x')), false);
});

test('images only go to a harness that takes them', async () => {
  const { host } = setup();
  await assert.rejects(
    host.send(key('i'), { cwd: dir, blocks: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }], display: [] }, {}),
    /can't take images/,
  );
});

test('negotiate: only what initialize declares', () => {
  const n = acp.negotiate({
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { resume: {}, close: {} } },
    authMethods: [{ id: 'login', name: 'Log in' }],
  });
  assert.equal(n.loadSession, true);
  assert.equal(n.resume, true);
  assert.equal(n.close, true);
  assert.equal(n.fork, false);
  assert.equal(n.image, true);
  assert.deepEqual(n.mcp, { http: false, sse: false });
  assert.deepEqual(n.authMethods, [{ id: 'login', name: 'Log in' }]);
  assert.equal(acp.negotiate({}).loadSession, false);
});

test('ItemsLog: append-only, and a half-written last line is skipped', async () => {
  const items = fixture.own(new ItemsLog(path.join(dir, 'items')));
  items.append('acp:x:1', { t: 'session', sessionId: 's' }, { t: 'user', turnId: 't' });
  fs.appendFileSync(items.file('acp:x:1'), '{"t":"upd');
  assert.deepEqual(await items.readAsync('acp:x:1'), [
    { t: 'session', sessionId: 's' },
    { t: 'user', turnId: 't' },
  ]);
  assert.deepEqual(
    items.list().map((x: any) => x.id),
    ['acp:x:1'],
  );
  assert.deepEqual(await items.readAsync('acp:none:1'), []);
});

const MODES = {
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: 'Default' },
    { id: 'plan', name: 'Plan' },
  ],
};
const CONFIG = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'fast',
    options: [
      { value: 'fast', name: 'Fast one' },
      { value: 'smart', name: 'Smart one' },
    ],
  },
];

test('modes and config options: declared on session/new, changed with set_mode and set_config_option', async () => {
  const { host, events } = setup({
    profile: { modes: MODES, configOptions: CONFIG, commands: [{ name: 'init', description: 'Write AGENTS.md' }] },
  });
  const t1 = (await host.send(key('m'), text('hi'), {})).turnId;
  await until(() => ended(events, t1));
  const session = events.find((e) => e.kind === 'session');
  assert.deepEqual(session.modes, MODES);
  assert.equal(session.configOptions[0].currentValue, 'fast');
  // the catalog arrives as an update
  await until(() => events.some((e) => e.kind === 'update' && e.update.sessionUpdate === 'available_commands_update'));
  await host.setMode(key('m'), 'plan');
  await host.setConfigOption(key('m'), 'model', 'smart');
  assert.ok(events.some((e) => e.kind === 'state' && e.state.configOptions?.[0].currentValue === 'smart'));
  const t2 = (await host.send(key('m'), text('SETTINGS'), {})).turnId;
  await until(() => ended(events, t2));
  assert.match(said(events, t2), /\[mode: plan config: \{"model":"smart"\}\]/);
  await assert.rejects(host.setMode(key('unknown-chat'), 'plan'), /Send a message first/);
});

for (const caps of [{ resume: true }, { loadSession: true }, {}]) {
  test(`mode and config options chosen in a chat are set again when its session is reopened (${Object.keys(caps)[0] ?? 'new session'})`, async () => {
    const threads = path.join(dir, `threads-settings-${Object.keys(caps)[0] ?? 'new'}`);
    const state = path.join(dir, `state-settings-${Object.keys(caps)[0] ?? 'new'}`);
    const profile = { ...caps, modes: MODES, configOptions: CONFIG };
    const a = setup({ profile, items: threads, state });
    const k = key('settings');
    const t1 = (await a.host.send(k, text('first'), {})).turnId;
    await until(() => ended(a.events, t1));
    await a.host.setMode(k, 'plan');
    await a.host.setConfigOption(k, 'model', 'smart');
    a.host.closeAll();
    const b = setup({ profile, items: threads, state });
    const t2 = (await b.host.send(k, text('SETTINGS'), {})).turnId;
    await until(() => ended(b.events, t2));
    assert.match(said(b.events, t2), /\[mode: plan config: \{"model":"smart"\}\]/);
    // the session event the windows see already carries them
    const session = b.events.find((e) => e.kind === 'session');
    assert.equal(session.modes.currentModeId, 'plan');
    assert.equal(session.configOptions[0].currentValue, 'smart');
    // and reopening again doesn't pile up records
    const modes = async (x: any) => (await x.items.readAsync(k)).filter((r: any) => r.t === 'mode').length;
    assert.equal(await modes(b), 2);
  });
}

test('a mode the agent no longer offers is not set again', async () => {
  const threads = path.join(dir, 'threads-settings-gone');
  const state = path.join(dir, 'state-settings-gone');
  const a = setup({ profile: { resume: true, modes: MODES }, items: threads, state });
  const t1 = (await a.host.send(key('gone'), text('first'), {})).turnId;
  await until(() => ended(a.events, t1));
  await a.host.setMode(key('gone'), 'plan');
  a.host.closeAll();
  const b = setup({
    profile: { resume: true, modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] } },
    items: threads,
    state,
  });
  const t2 = (await b.host.send(key('gone'), text('SETTINGS'), {})).turnId;
  await until(() => ended(b.events, t2));
  assert.match(said(b.events, t2), /\[mode: default /);
  assert.ok(!b.agentLog().some((l: any) => l.kind === 'in' && l.msg.method === 'session/set_mode'));
});

const cancels = (agentLog: () => any[]) => agentLog().filter((l: any) => l.kind === 'in' && l.msg.method === 'session/cancel').length;

test('a Stop the agent ignores once is sent again, and the second one ends the turn as cancelled', async () => {
  const { host, events, agentLog } = setup({ profile: { ignoreCancel: 1 }, host: { cancelRetryMs: 150, cancelForceMs: 5000 } });
  const { turnId } = await host.send(key('c2'), text('SLOW please'), {});
  await until(() => said(events, turnId));
  host.cancel(key('c2'));
  const end = await until(() => ended(events, turnId), 3000);
  assert.equal(end.stopReason, 'cancelled');
  assert.equal(end.error, null);
  assert.equal(cancels(agentLog), 2);
});

test('an agent that never stops: asked twice, then the turn ends here as one that did not stop', async () => {
  const { host, events, agentLog, items } = setup({ profile: { ignoreCancel: true }, host: { cancelRetryMs: 100, cancelForceMs: 400 } });
  const k = key('c3');
  const { turnId } = await host.send(k, text('SLOW please'), {});
  await until(() => said(events, turnId));
  host.cancel(k);
  const end = await until(() => ended(events, turnId), 3000);
  assert.equal(end.stopReason, 'error');
  assert.match(end.error, /Fake did not stop when asked/);
  // the agent process logs the second Stop when it reads it, which a busy machine can delay past the forced end
  await until(() => cancels(agentLog) === 2);
  assert.equal(cancels(agentLog), 2);
  assert.deepEqual(
    (await items.readAsync(k)).filter((r: any) => r.t === 'end').map((r: any) => [r.turnId, r.stopReason, /did not stop/.test(r.error)]),
    [[turnId, 'error', true]],
  );
  // the chat is free again: the next message goes out as a new turn
  assert.equal(host.chats.get(k).prompting, null);
  const next = await host.send(k, text('after'), {});
  assert.notEqual(next.turnId, turnId);
});

test('a Stop that works leaves no escalation behind', async () => {
  const { host, events, agentLog } = setup({ host: { cancelRetryMs: 100, cancelForceMs: 300 } });
  const { turnId } = await host.send(key('c4'), text('SLOW please'), {});
  await until(() => said(events, turnId));
  // each Stop as the host sends it, and whether its turn had already ended then: an agent slowed by a busy machine may
  // be asked twice before it answers, but never after
  const agent = host.chats.get(key('c4')).agent;
  const notify = agent.notify.bind(agent);
  const stops: boolean[] = [];
  agent.notify = (method: string, params: any) => {
    if (method === 'session/cancel') stops.push(!!ended(events, turnId));
    return notify(method, params);
  };
  host.cancel(key('c4'));
  await until(() => ended(events, turnId));
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(stops.length >= 1 && cancels(agentLog) >= 1);
  assert.deepEqual(
    stops.filter((afterEnd) => afterEnd),
    [],
    'no Stop after the turn ended',
  );
  assert.equal(events.filter((e) => e.kind === 'turnEnd' && e.turnId === turnId).length, 1);
});
