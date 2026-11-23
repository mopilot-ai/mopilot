// Control matrix, ownership while a switch starts the native session (docs/control-plane/matrix.md CM-O13 to
// CM-O15): a harness switch claims the native session it starts for its chat before the session sends anything
// (design ControlContext): SwitchRunner, ChatController.claim/chatOf and the CodexAdapter as main wires them
// (electron/app/sessions.cjs), over a fake app-server that sends the new thread's notifications in the same
// read as the thread/start answer. Without the claim, the thread's lease and thread/started list it in the
// sidebar as a chat of its own, and its first events go to a chat nobody shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tick } from './support/async-scenarios.ts';

export const GUARDS = ['electron/', 'shared/'];

const require = createRequire(import.meta.url);
const { CodexAdapter } = require('../electron/harness/codex.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { ChatController } = require('../electron/session/controller.cjs');
const { SwitchRunner } = require('../electron/session/switch.cjs');
const { ChatsStore } = require('../electron/platform/chats.cjs');

const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};

const NEW = 'cx-new';

/**
 * An app-server stand-in. thread/start answers, then the new thread's thread/started and a status change
 * follow in the same read (`later`: in the next one); `fails` answers it with an error.
 */
function fakeServer(o: { fails?: boolean; later?: boolean } = {}) {
  const s = {
    listeners: new Set<(e: any) => void>(),
    proc: {},
    start() {},
    send(m: any) {
      if (m.id == null || !m.method) return;
      setImmediate(() => {
        if (m.method === 'thread/start' && o.fails) return s.emit({ id: m.id, error: { code: -32600, message: 'no model' } });
        if (m.method !== 'thread/start') return s.emit({ id: m.id, result: m.method === 'initialize' ? { userAgent: 'fake' } : {} });
        const thread = { id: NEW, cwd: '/repo', name: null, preview: '', ephemeral: false };
        s.emit({ id: m.id, result: { thread } });
        const notify = () => {
          s.emit({ method: 'thread/started', params: { thread } });
          s.emit({ method: 'thread/status/changed', params: { threadId: NEW, status: { type: 'idle' } } });
        };
        if (o.later) setImmediate(notify);
        else notify();
      });
    },
    emit(msg: any) {
      for (const l of s.listeners) l({ kind: 'message', msg });
    },
  };
  return s;
}

function setup(o: { fails?: boolean; later?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-claim-'));
  const chats = new ChatsStore(path.join(dir, 'threads'));
  const state = new SessionStore();
  const events: any[] = [];
  const order: string[] = [];
  const emit = (e: any, target?: any) => events.push({ ...e, target });
  let controller: any;
  const codex = new CodexAdapter({
    server: fakeServer(o),
    state,
    nativeOf: (chatId: string) => controller.ref(chatId),
    chatOf: (id: string) => controller.chatOf(id),
    prefs: () => ({ model: null, effort: null, permission: 'default', serviceTier: null }),
    emit,
    // the tool channel sees each message first (codexConfig.cjs observe): it already sees the chat
    tools: {
      outgoing: (m: any) => m,
      observe: (m: any) => m.result?.thread?.id && order.push(`tools ${controller.chatOf(m.result.thread.id)}`),
      exited() {},
      setUserServers() {},
    },
    probe: null,
  });
  const sessions: [string, string][] = [];
  const runner = new SwitchRunner({
    chats,
    ref: (chatId: string) => controller.ref(chatId),
    invalidate: () => controller.invalidate(),
    claim: (key: string, chatId: string) => controller.claim(key, chatId),
    unclaim: (key: string, chatId: string) => controller.unclaim(key, chatId),
    changed: () => {},
    prefs: () => ({ permission: 'default', serviceTier: null, claudeBin: null }),
    home: '/home/me',
    emit,
    git: { info: async () => ({ branch: 'main' }), status: async () => ({ files: [] }) },
    codex: {
      startThread: (params: any, opts: any) => codex.startThread(params, opts),
      ensureResumed: (id: string) => codex.ensureResumed(id),
      threadTurns: async () => ({ data: [], nextCursor: null }),
      summarize: async () => 'note',
      cwdOf: () => '/repo',
    },
    claude: {
      // the Claude session is the chat's from the moment it exists
      registerSession: (key: string) => sessions.push([key, controller.chatOf(key)]),
      isFresh: () => true,
      cwdOf: () => '/repo',
      accountOf: () => 'default',
      allTurns: async () => [],
      summarize: async () => 'note',
    },
    permissionParams: () => ({}),
  });
  controller = new ChatController({ state, chats, codex, claudeTurns: {}, acpTurns: {}, switcher: runner, claude: {}, acp: {} });
  /** A chat on Claude Code (session s0), or on Codex (thread `cx-old`). */
  const chat = (id: string, kind: 'claude' | 'codex') => {
    const first = chats.record(id).segments[0];
    chats.commit({ ...chats.record(id), segments: [{ ...first, kind, nativeId: kind === 'claude' ? 's0' : 'cx-old', count: 0 }] });
    controller.invalidate();
    return id;
  };
  const perform = (chatId: string, harness: 'claude' | 'codex') =>
    runner.perform(chatId, { harness, model: 'm', modelLabel: 'M', mode: 'workspace' });
  return { chats, state, events, order, sessions, controller, codex, runner, chat, perform };
}

/** A Claude → Codex switch whose new thread's notifications arrive with the answer, or `later`. */
async function claudeToCodex(later: boolean) {
  const h = setup({ later });
  const chatId = h.chat('chat1', 'claude');
  const r = await h.perform(chatId, 'codex');
  await settle();
  assert.equal(r.ready, true);
  assert.equal(h.chats.record(chatId).segments.at(-1).nativeId, NEW);
  const notes = h.events.filter((e) => e.kind === 'notification');
  assert.deepEqual(
    notes.map((e) => [e.method, e.chatId, e.params.threadId]),
    [['thread/status/changed', chatId, chatId]],
    'no thread/started of its own; its events go to the chat',
  );
  const leases = h.events.filter((e) => e.kind === 'lease');
  assert.deepEqual(
    leases.map((e) => [e.threadId, e.thread, e.chatId]),
    [[NEW, null, chatId]],
    'held for the chat, without the thread the windows would list',
  );
  // the tool channel, which sees the answer first, already resolves the chat
  assert.deepEqual(h.order, [`tools ${chatId}`]);
  // committed: the claim is gone and the segment answers
  assert.equal(h.controller.claims.size, 0);
  assert.equal(h.controller.chatOf(NEW), chatId);
}

test("CM-O13a: Claude → Codex, the thread's notifications in the same read as its answer: its lease, thread/started and events are the chat's", () =>
  claudeToCodex(false));

test("CM-O13b: Claude → Codex, the thread's notifications after its answer: its lease carries no thread of its own", () =>
  claudeToCodex(true));

test("CM-O14: Codex → Claude: the new Claude session is the chat's before it is registered", async () => {
  const h = setup();
  const chatId = h.chat('chat2', 'codex');
  const r = await h.perform(chatId, 'claude');
  assert.equal(r.ready, true);
  const id = h.chats.record(chatId).segments.at(-1).nativeId;
  assert.deepEqual(h.sessions, [[`claude:${id}`, chatId]]);
  assert.equal(h.controller.claims.size, 0);
  assert.equal(h.controller.chatOf(`claude:${id}`), chatId);
});

test('CM-O15: a thread that fails to start leaves no claim, and a switch that fails after the start lets its thread go', async () => {
  const failed = setup({ fails: true });
  const a = failed.chat('chat3', 'claude');
  assert.deepEqual(await failed.perform(a, 'codex'), {
    ready: false,
    error:
      "Couldn't start Codex: no model. Your message is kept in the queue: fix that and send it again, or cancel the switch to send it here.",
  });
  assert.equal(failed.controller.claims.size, 0);
  assert.match(failed.events.find((e) => e.kind === 'toast').text, /Couldn't start Codex: no model/);

  const h = setup();
  const b = h.chat('chat4', 'claude');
  h.runner.handoff = async () => {
    throw new Error('disk full');
  };
  await assert.rejects(h.perform(b, 'codex'), /disk full/);
  assert.equal(h.controller.claims.size, 0);
  assert.equal(h.controller.chatOf(NEW), NEW, 'not committed: the thread is no chat of its own segment');
  assert.equal(h.chats.record(b).segments.length, 1);
});

test("unclaim drops only the chat's own claim", () => {
  const h = setup();
  h.controller.claim('k', 'a');
  h.controller.unclaim('k', 'b');
  assert.equal(h.controller.chatOf('k'), 'a');
  h.controller.unclaim('k', 'a');
  assert.equal(h.controller.chatOf('k'), 'k');
});

test("an answer's hook runs before the tool channel and the next message, and not for an error or another request", async () => {
  const h = setup();
  const seen: string[] = [];
  const p = h.codex.request('x/y', {}, { onAnswer: (r: any) => seen.push(`answer ${r.ok}`) });
  const sent = new Promise<any>((res) => {
    h.codex.server.send = (m: any) => m.method === 'x/y' && res(m);
  });
  const m = await sent;
  h.codex.tools.observe = (m: any) => seen.push(m.method ?? 'answer seen');
  h.codex.onServer({ kind: 'message', msg: { id: m.id, result: { ok: 1 } } });
  h.codex.onServer({ kind: 'message', msg: { method: 'z/notified', params: {} } });
  assert.deepEqual(await p, { ok: 1 });
  assert.deepEqual(seen, ['answer 1', 'answer seen', 'z/notified']);
  // an error answer, and an answer to a request without a hook
  const e = h.codex.request('x/y', {}, { onAnswer: () => seen.push('wrong') });
  const plain = h.codex.request('x/z', {});
  await settle();
  const [eid, pid] = [...h.codex.pending.keys()];
  h.codex.onServer({ kind: 'message', msg: { id: eid, error: { code: 1, message: 'no' } } });
  h.codex.onServer({ kind: 'message', msg: { id: pid, result: {} } });
  await assert.rejects(e, /no/);
  await plain;
  assert.ok(!seen.includes('wrong'));
  // a hook that throws: the request still settles and the tool channel still sees the answer
  seen.length = 0;
  const broken = h.codex.request(
    'x/y',
    {},
    {
      onAnswer: () => {
        throw new Error('hook');
      },
    },
  );
  await settle();
  const [bid] = [...h.codex.pending.keys()];
  h.codex.onServer({ kind: 'message', msg: { id: bid, result: { ok: 2 } } });
  assert.deepEqual(await broken, { ok: 2 });
  assert.deepEqual(seen, ['answer seen']);
});
