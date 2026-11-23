// ACP chat titles written in a hidden session on the chat's agent (electron/harness/acp/titleSessions.cjs, #2150):
// its text is collected, its permission asks cancelled, nothing of it reaches the chat, and it is let go after.
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
const { AcpTitleSessions, safeMode } = require('../electron/harness/acp/titleSessions.cjs');
const { ItemsLog } = require('../electron/platform/chats.cjs');
const pty = require('../electron/platform/pty.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT = path.join(ROOT, 'tests/fixtures/fake-acp-agent.mjs');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sage-acp-title-')));
const fixture = transcriptFixture(dir);
after(() => fixture.cleanup());

/** A stub agent: answers session/new and session/prompt as told, and records what it was sent. */
function stubAgent(o: { session?: unknown; prompt?: (p: any) => Promise<unknown>; close?: boolean; notifyThrows?: boolean } = {}) {
  const calls: [string, any][] = [];
  const agent = {
    caps: { close: !!o.close },
    request: async (method: string, params: any) => {
      calls.push([method, params]);
      if (method === 'session/new') return 'session' in o ? o.session : { sessionId: 's-title' };
      if (method === 'session/prompt') return o.prompt ? o.prompt(params) : { stopReason: 'end_turn' };
      if (method === 'session/close') throw new Error('gone');
      return {};
    },
    notify: (method: string, params: any) => {
      if (o.notifyThrows) throw new Error('exited');
      calls.push([method, params]);
    },
  };
  return { agent, calls };
}

test('the title is the text the hidden session answers with; its updates and requests stay out of the chat', async () => {
  const titles = new AcpTitleSessions();
  const { agent, calls } = stubAgent({
    close: true,
    prompt: async ({ sessionId }) => {
      const chunk = (content: any) =>
        titles.take(agent, 'session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content } });
      assert.equal(chunk({ type: 'text', text: ' Login ' }), true);
      assert.equal(chunk({ type: 'text', text: 'bug ' }), true);
      // not text, no text or not a message: taken (no chat sees it), not kept
      assert.equal(chunk({ type: 'image', data: 'x' }), true);
      assert.equal(chunk({ type: 'text' }), true);
      assert.equal(titles.take(agent, 'session/update', { sessionId, update: { sessionUpdate: 'tool_call' } }), true);
      assert.equal(titles.take(agent, 'cursor/update_todos', { sessionId }), true);
      // a permission ask is cancelled, any client method refused
      assert.deepEqual(titles.answer(agent, 'session/request_permission', { sessionId }), { outcome: { outcome: 'cancelled' } });
      assert.throws(() => titles.answer(agent, 'fs/read_text_file', { sessionId }), /A title session can't use fs\/read_text_file/);
      return { stopReason: 'end_turn' };
    },
  });
  assert.equal(await titles.write(agent, '/work', 'fix the login bug', 1000), 'Login bug');
  assert.deepEqual(calls[0], ['session/new', { cwd: '/work', mcpServers: [] }]);
  assert.equal(calls[1][0], 'session/prompt');
  assert.match(calls[1][1].prompt[0].text, /Request:\nfix the login bug$/);
  // answered: closed (a close that fails is only noted), never cancelled
  assert.deepEqual(
    calls.slice(2).map(([m]) => m),
    ['session/close'],
  );
  assert.equal(titles.open.size, 0);
  // another session's traffic is not a title session's
  assert.equal(titles.take(agent, 'session/update', { sessionId: 's-title' }), false);
  assert.equal(titles.answer(agent, 'session/request_permission', { sessionId: 'other' }), undefined);
  assert.equal(titles.of(agent, undefined), null);
});

test('no session, a blank answer, a refused prompt and an exited agent leave no title and no session open', async () => {
  const titles = new AcpTitleSessions();
  assert.equal(await titles.write(stubAgent({ session: null }).agent, '/w', 'x', 1000), null);
  assert.equal(await titles.write(stubAgent({ session: { sessionId: 7 } }).agent, '/w', 'x', 1000), null);
  assert.equal(await titles.write(stubAgent().agent, '/w', 'x', 1000), null);
  // refused (or timed out) before an answer: the agent is told to stop, and a dead agent is only noted
  const refused = stubAgent({ prompt: async () => Promise.reject(new Error('timed out')) });
  await assert.rejects(titles.write(refused.agent, '/w', 'x', 1000), /timed out/);
  assert.deepEqual(refused.calls.at(-1), ['session/cancel', { sessionId: 's-title' }]);
  const dead = stubAgent({ prompt: async () => Promise.reject(new Error('exited')), notifyThrows: true });
  await assert.rejects(titles.write(dead.agent, '/w', 'x', 1000), /exited/);
  assert.equal(titles.open.size, 0);
  // two title sessions on one agent at once each keep their own text
  let release!: () => void;
  const both = stubAgent({
    prompt: async ({ sessionId }) => {
      titles.take(both.agent, 'session/update', {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: sessionId } },
      });
      if (sessionId === 'a') await new Promise<void>((r) => (release = r));
      return {};
    },
  });
  let n = 0;
  const request = both.agent.request;
  both.agent.request = async (m: string, p: any) => (m === 'session/new' ? { sessionId: n++ ? 'b' : 'a' } : request(m, p));
  const first = titles.write(both.agent, '/w', 'x', 1000);
  await new Promise((r) => setImmediate(r));
  assert.equal(await titles.write(both.agent, '/w', 'y', 1000), 'b');
  release();
  assert.equal(await first, 'a');
  assert.equal(titles.open.size, 0);
});

test('a title session runs only in a mode that reads or asks: its read-only one when offered, never one that acts alone', async () => {
  const anchors = { plan: 'readOnly', default: 'ask', yolo: 'full', auto: 'auto' };
  const modes = (current: string | undefined, ...ids: string[]) => ({ currentModeId: current, availableModes: ids.map((id) => ({ id })) });
  assert.equal(safeMode(null, anchors), '', 'no modes: it asks (the quirks contract)');
  assert.equal(safeMode(modes('plan', 'plan', 'yolo'), anchors), '');
  assert.equal(safeMode(modes('yolo', 'default', 'plan', 'yolo'), anchors), 'plan');
  assert.equal(safeMode(modes('default', 'default', 'yolo'), anchors), '');
  assert.equal(safeMode(modes('unlisted', 'unlisted'), anchors), '', 'an unlisted mode counts as ask');
  assert.equal(safeMode(modes('yolo', 'default', 'yolo'), anchors), null);
  assert.equal(safeMode(modes('auto', { id: 7 } as any), anchors), null);
  assert.equal(safeMode({ currentModeId: 'auto', availableModes: 'x' }, anchors), null);
  // the read-only mode is set before the prompt
  const titles = new AcpTitleSessions();
  const ro = stubAgent();
  const request = ro.agent.request;
  ro.agent.request = async (m: string, p: any) =>
    m === 'session/new' ? { sessionId: 's', modes: modes('yolo', 'plan', 'yolo') } : request(m, p);
  await titles.write(ro.agent, '/w', 'x', 1000, anchors);
  assert.deepEqual(
    ro.calls.map(([m, p]) => [m, p.modeId]),
    [
      ['session/set_mode', 'plan'],
      ['session/prompt', undefined],
    ],
  );
  // only a mode that acts alone: the session is closed and never prompted
  const full = stubAgent({ close: true });
  full.agent.request = async (m: string, p: any) => (
    full.calls.push([m, p]), m === 'session/new' ? { sessionId: 's', modes: modes('yolo', 'yolo') } : {}
  );
  assert.equal(await titles.write(full.agent, '/w', 'x', 1000, anchors), null);
  assert.deepEqual(
    full.calls.map(([m]) => m),
    ['session/new', 'session/close'],
  );
});

function setup(profile: object = {}, quirks: object = {}) {
  const log = path.join(dir, `agent-${Math.random().toString(36).slice(2)}.jsonl`);
  const items = fixture.own(new ItemsLog(path.join(dir, `threads-${Math.random().toString(36).slice(2)}`)));
  const events: any[] = [];
  const host = new acp.AcpHost({
    items,
    quirks: (id: string) =>
      id === 'fake'
        ? {
            label: 'Fake',
            args: [AGENT],
            env: { FAKE_ACP_LOG: log, FAKE_ACP_STATE: path.join(dir, 'state'), FAKE_ACP_PROFILE: JSON.stringify(profile) },
            ...quirks,
          }
        : null,
    ids: ['fake'],
    resolveBin: () => process.execPath,
    env: () => process.env,
    pty,
    cwd: dir,
  });
  fixture.stopWith(acpFixtureStop(host));
  host.on('event', (e: any) => events.push(e));
  const agentLog = () => readJsonLineLog(log);
  return { host, items, events, agentLog };
}
const KEY = 'acp:fake:t1';
const until = async (fn: () => any, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("the host writes a chat's title on its own agent without touching the chat (fake ACP agent)", async () => {
  const { host, items, events, agentLog } = setup({ close: true });
  assert.equal(await host.titleFor(KEY, 'x', 1000), null, 'no session yet');
  const display = [{ type: 'text', text: 'hello', text_elements: [] }];
  const { turnId } = await host.send(KEY, { cwd: dir, blocks: [{ type: 'text', text: 'hello' }], display }, { uuid: 'u1', chatId: KEY });
  await until(() => events.find((e) => e.kind === 'turnEnd' && e.turnId === turnId));
  const before = { events: events.length, recs: (await items.readAsync(KEY)).length };
  // PERMIT: the hidden session asks for a permission, which is cancelled, so its prompt ends early
  const title = await host.titleFor(KEY, 'fix the login bug PERMIT', 5000);
  assert.equal(title, null, 'cancelled before it said anything');
  const plain = await host.titleFor(KEY, 'fix the login bug', 5000);
  assert.match(String(plain), /^Fake chat title$/);
  // nothing of either reached the chat: no event, no transcript record, no permission card
  assert.equal(events.length, before.events);
  assert.equal((await items.readAsync(KEY)).length, before.recs);
  const sent = agentLog().filter((l: any) => l.kind === 'in');
  const news = sent.filter((l: any) => l.msg.method === 'session/new');
  assert.equal(news.length, 3);
  assert.deepEqual(news[1].msg.params.mcpServers, [], 'no tools for a title session');
  // both title sessions are closed; the chat's own is not. The close is sent without waiting for its answer (the title
  // doesn't wait on it), so the agent may log it after titleFor resolved
  const closes = () =>
    agentLog()
      .filter((l: any) => l.kind === 'in' && l.msg.method === 'session/close')
      .map((l: any) => l.msg.params.sessionId);
  const closed = await until(() => (closes().length >= 2 ? closes() : null));
  assert.equal(closed.length, 2);
  assert.ok(!closed.includes((await items.readAsync(KEY))[0].sessionId));
  assert.equal(host.titleSessions.open.size, 0);
  // an automatic title is marked as such in the transcript; a user's is not
  host.rename(KEY, 'Login bug', true);
  host.rename(KEY, 'Mine');
  const titles = (await items.readAsync(KEY)).filter((r: any) => r.t === 'title');
  assert.deepEqual(
    titles.map((r: any) => [r.name, r.auto]),
    [
      ['Login bug', true],
      ['Mine', undefined],
    ],
  );
});

test("a harness whose sessions show in MoPilot's own lists writes no title session; the latest title is known at once", async () => {
  const { host, items, events, agentLog } = setup({}, { titleSessions: false });
  const display = [{ type: 'text', text: 'hello', text_elements: [] }];
  const { turnId } = await host.send(KEY, { cwd: dir, blocks: [{ type: 'text', text: 'hello' }], display }, { uuid: 'u1', chatId: KEY });
  await until(() => events.find((e) => e.kind === 'turnEnd' && e.turnId === turnId));
  assert.equal(await host.titleFor(KEY, 'fix the login bug', 5000), null);
  assert.equal(agentLog().filter((l: any) => l.kind === 'in' && l.msg.method === 'session/new').length, 1);
  // read from the transcript before this run wrote one, then from what it wrote, with no read in between
  assert.equal(await host.titleOf(KEY), null);
  items.append(KEY, { t: 'title', name: 'From disk', at: 1 });
  assert.equal((await host.titleOf(KEY)).name, 'From disk');
  host.rename(KEY, 'fix the login bug', true);
  host.history = async () => {
    throw new Error('not read');
  };
  assert.deepEqual([(await host.titleOf(KEY)).name, (await host.titleOf(KEY)).auto], ['fix the login bug', true]);
  host.rename('not-acp', 'x');
  host.rename(KEY, 7 as any);
  assert.equal((await host.titleOf(KEY)).name, 'fix the login bug');
});
