// The Host's composition root (host/src/sessions.mjs): chats run through the shared ChatController on the Host's AcpHost, a family the Host does not run refuses explicitly, and a family plugs in through the factories (A: queue and Stop, B: unavailable families, the seam).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { readJsonLineLog } from '../scripts/fixture-json-log.mjs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createAcpRuntime } from '../host/src/acp.mjs';
import { UnsupportedError } from '../host/src/errors.mjs';
import { unavailableFamily } from '../host/src/families.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import { createHostSessions } from '../host/src/sessions.mjs';
import { helloParams } from '../shared/host/schema.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const AGENT = path.join(ROOT, 'tests/fixtures/fake-acp-agent.mjs');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-sessions-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const until = async (fn: () => any, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A Host's sessions over the fake ACP agent; `log` is what the agent was asked. */
function setup(families: any = undefined, profile: object = {}) {
  const dir = fs.mkdtempSync(path.join(base, 'd-'));
  const log = path.join(dir, 'agent.jsonl');
  fs.writeFileSync(
    path.join(dir, 'harnesses.json'),
    JSON.stringify({
      fake: {
        label: 'Fake',
        bin: process.execPath,
        args: [AGENT],
        env: { FAKE_ACP_STATE: path.join(dir, 's'), FAKE_ACP_LOG: log, FAKE_ACP_PROFILE: JSON.stringify(profile) },
      },
    }),
  );
  const paths = createPaths({ dataDir: dir, env: {} });
  // a Stop the agent ignores is asked again at once; forcing the turn to end waits long enough that a loaded runner's
  // answer to the second Stop is never taken for an agent that would not stop
  const runtime = createAcpRuntime({ paths, env: {}, hostOptions: { cancelRetryMs: 5, cancelForceMs: 5000 } });
  const sessions = createHostSessions({ paths, env: {}, runtime, families });
  const agentLog = () => readJsonLineLog(log);
  return { dir, runtime, sessions, agentLog, close: () => (sessions.close(), runtime.close()) };
}

test('A: a message runs a whole turn through the shared controller: its state goes running, then idle, and the stream hears it', async () => {
  const h = setup();
  try {
    const events: any[] = [];
    h.sessions.chatRuntime.host.on('event', (e: any) => events.push(e));
    const key = 'acp:fake:a';
    const sent = await h.sessions.chatRuntime.send({ key, text: 'hello there', cwd: h.dir });
    assert.equal(sent.action, 'started');
    await until(() => h.sessions.state.snapshot(key).turn === 'idle' && events.some((e) => e.kind === 'turnEnd'));
    const text = events
      .filter((e) => e.update?.sessionUpdate === 'agent_message_chunk')
      .map((e) => e.update.content.text)
      .join('');
    assert.equal(text, 'fake-acp: hello there');
    assert.ok(h.sessions.state.snapshot(key).rev > 0);
    // the chat's session started in the folder the first message named
    const created = h.agentLog().find((l: any) => l.msg?.method === 'session/new');
    assert.equal(created.msg.params.cwd, h.dir);
  } finally {
    h.close();
  }
});

test('A: a message sent while a turn runs is queued, not refused, and Stop ends the running turn', async () => {
  const h = setup();
  try {
    const key = 'acp:fake:q';
    await h.sessions.chatRuntime.send({ key, text: 'SLOW first', cwd: h.dir });
    await until(() => h.sessions.state.snapshot(key).turn === 'running');
    const second = await h.sessions.chatRuntime.send({ key, text: 'second' });
    assert.equal(second.action, 'queued');
    assert.equal(h.sessions.state.snapshot(key).queue.length, 1);
    // what the idle stop reads of the chats: a turn running and a message waiting behind it, and no card
    assert.deepEqual(h.sessions.busy(), { turnRunning: true, cardWaiting: false, queued: true });
    h.sessions.chatRuntime.host.cancel(key);
    await until(() => h.sessions.state.snapshot(key).turn !== 'running' || h.sessions.state.snapshot(key).queue.length === 0);
    assert.notEqual(h.sessions.state.snapshot(key).turn, 'crashed');
  } finally {
    h.close();
  }
});

test('an attached image reaches the agent: a BMP as a PNG, a file nothing can read as a missing attachment instead of a failed message', async () => {
  const h = setup(undefined, { image: true });
  try {
    const key = 'acp:fake:img';
    const bmp = path.join(h.dir, 'x.bmp');
    const header = Buffer.alloc(58);
    header.write('BM', 0);
    header.writeUInt32LE(54, 10);
    header.writeUInt32LE(40, 14);
    header.writeInt32LE(1, 18);
    header.writeInt32LE(1, 22);
    header.writeUInt16LE(1, 26);
    header.writeUInt16LE(24, 28);
    fs.writeFileSync(bmp, header);
    const broken = path.join(h.dir, 'y.heic');
    fs.writeFileSync(broken, 'not an image');
    await h.sessions.chatRuntime.send({ key, text: 'first', cwd: h.dir });
    await until(() => h.sessions.state.snapshot(key).turn === 'idle' && h.agentLog().some((l: any) => l.msg?.method === 'session/prompt'));
    const receipt = await h.sessions.controller.send(
      key,
      {
        text: 'look',
        attachments: [
          { kind: 'image', path: bmp, name: 'x.bmp' },
          { kind: 'image', path: broken, name: 'y.heic' },
        ],
        opts: {},
      },
      null,
      true,
    );
    assert.equal(receipt.action, 'started');
    const prompt = await until(() => h.agentLog().filter((l: any) => l.msg?.method === 'session/prompt')[1]);
    const images = prompt.msg.params.prompt.filter((b: any) => b.type === 'image');
    assert.equal(images.length, 1, 'the unreadable one is left out');
    assert.equal(images[0].mimeType, 'image/png');
    assert.equal(Buffer.from(images[0].data, 'base64').toString('latin1', 1, 4), 'PNG');
  } finally {
    h.close();
  }
});

test('B: Claude Code and Codex chats are refused as unavailable on this Host, and so is switching harness and changing the permission mode', async () => {
  const h = setup();
  try {
    await assert.rejects(
      h.sessions.chatRuntime.send({ key: 'claude:c1', text: 'hi' }),
      (e: any) => e instanceof UnsupportedError && /Claude Code is not available on this Host/.test(e.message),
    );
    await assert.rejects(
      h.sessions.chatRuntime.send({ key: '019a0000-0000-7000-8000-000000000001', text: 'hi' }),
      (e: any) => e instanceof UnsupportedError && /Codex is not available on this Host/.test(e.message),
    );
    await assert.rejects(
      h.sessions.host.permit({ value: 'default' }),
      (e: any) => e instanceof UnsupportedError && /permission mode/.test(e.message),
    );
    const none = unavailableFamily('Nothing');
    assert.equal(none.then, undefined);
    assert.equal(none[Symbol.iterator], undefined);
    assert.equal(await Promise.resolve(none), none);
    // the controller probes these with `?.()` before every send, so they must read as absent, not as a refusal
    assert.equal(none.pendingContinue, undefined);
    assert.equal(none.goalRestartCurrent, undefined);
    assert.throws(
      () => none.anything(),
      (e: any) => e.code === 'unsupported' && /Nothing is not available on this Host/.test(e.message),
    );
  } finally {
    h.close();
  }
});

test('B: a Claude Code chat is not started on a Host that supplies no Claude family, and it lists no models', async () => {
  const h = setup();
  try {
    assert.deepEqual(h.sessions.modelsOf('claude'), []);
    assert.deepEqual(h.sessions.modelsOf('codex'), [], 'only Claude Code’s are kept here');
    await assert.rejects(h.sessions.chatRuntime.prepare({ chatId: 'claude:c9', harness: 'claude' }), /cannot run that harness yet/);
  } finally {
    h.close();
  }
});

test('the seam: a family factory is given the Host’s services, supplies its adapter, and its turn events reach the stream', async () => {
  const seen: any = {};
  const started: any[] = [];
  const families = {
    claude: (ctx: any) => {
      Object.assign(seen, ctx);
      const claudeTurns = {
        startTurn: async (chatId: string, ref: any, item: any) => {
          started.push({ chatId, key: ref.key, text: item.text });
          ctx.emit({ kind: 'turnStart', key: ref.key, turnId: 'ct1' });
          ctx.emit({ kind: 'update', turnId: 'ct1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'from claude' } } });
          ctx.emit({ kind: 'turnEnd', turnId: 'ct1', stopReason: 'end_turn' });
          return { started: true, turnId: 'ct1' };
        },
        stop: async () => undefined,
      };
      return { claudeTurns, claude: unavailableFamily('Claude Code') };
    },
    codex: (ctx: any) => ({ codex: { info: ctx.paths.dataDir } }),
  };
  const h = setup(families);
  try {
    assert.deepEqual(Object.keys(seen).sort(), ['ceiling', 'chats', 'controller', 'emit', 'env', 'log', 'paths', 'state', 'userOf']);
    // a Host given no ceiling has none: a family never needs one to be given
    assert.equal(seen.ceiling(), undefined);
    assert.equal(seen.log('a Host given no log takes a line and says nothing'), undefined);
    assert.equal(seen.controller(), h.sessions.controller);
    assert.equal(seen.state, h.sessions.state);
    const events: any[] = [];
    h.sessions.chatRuntime.host.on('event', (e: any) => events.push(e));
    // the controller routes a claude chat to the adapter the factory gave
    await h.sessions.chatRuntime.send({ key: 'claude:c2', text: 'hi from the app' });
    await until(() => events.some((e) => e.kind === 'turnEnd'));
    assert.deepEqual(
      started.map((s) => [s.key, s.text]),
      [['claude:c2', 'hi from the app']],
    );
    assert.equal(events.find((e) => e.update)?.update.content.text, 'from claude');
  } finally {
    h.close();
  }
});

test('the protocol serves a chat on these sessions: send answers, the turn’s reply arrives as an item, Stop is accepted', async () => {
  const h = setup();
  try {
    const quiet = { report: () => undefined };
    const epochs = createEpochStore(path.join(h.dir, 'e.json'), quiet);
    const guard = createGuard({ epochs, ledger: createLedger(path.join(h.dir, 'l'), quiet) });
    const protocol = createProtocol({ runtime: h.sessions.chatRuntime, epochs, guard, status: () => ({ running: true }) });
    const frames: any[] = [];
    const conn = protocol.connection((m: any) => frames.push(m));
    await conn.call('host.hello', helloParams());
    const chatId = 'acp:fake:p';
    const scope = { chatId, epoch: 1 };
    await conn.call('chat.subscribe', scope);
    const sent: any = await conn.call('chat.send', { ...scope, key: 'key-00000001', text: 'ping', cwd: h.dir });
    assert.equal(sent.result.action, 'started');
    await until(() => frames.some((m) => m.frame?.item?.t === 'assistant'));
    assert.equal(frames.find((m) => m.frame?.item?.t === 'assistant').frame.item.text, 'fake-acp: ping');
    const stopped: any = await conn.call('chat.stop', { ...scope, key: 'key-00000002' });
    assert.deepEqual(stopped.result, { stopped: true });
    // a Stop that fails is the client's error, not an unhandled rejection of the Host
    const failing = createProtocol({
      runtime: {
        host: Object.assign(new EventEmitter(), {
          cancel: async () => {
            throw new Error('the harness is gone');
          },
        }),
        send: async () => ({ turnId: 't' }),
        permit: () => false,
      },
      epochs,
      guard,
      status: () => ({ running: true }),
    });
    const other = failing.connection(() => undefined);
    await other.call('host.hello', helloParams());
    await assert.rejects(other.call('chat.stop', { chatId: 'acp:fake:z', epoch: 1, key: 'key-00000003' }), /the harness is gone/);
  } finally {
    h.close();
  }
});

test('the chat runtime answers a permission card through the ACP host, and says when the card is gone', () => {
  const h = setup();
  try {
    const given: any[] = [];
    (h.runtime.host as any).permission = (requestId: string, optionId?: string) => (given.push([requestId, optionId]), requestId === 'p1');
    assert.equal(h.sessions.chatRuntime.permit({ requestId: 'p1', optionId: 'allow' }), true);
    assert.equal(h.sessions.chatRuntime.permit({ requestId: 'gone' }), false);
    assert.deepEqual(given, [
      ['p1', 'allow'],
      ['gone', undefined],
    ]);
  } finally {
    h.close();
  }
});

test('A: an ACP chat’s mode is set on its agent for later turns; a mode the agent lacks, or a chat with no session, is refused with `mode_unavailable`', async () => {
  const modes = {
    currentModeId: 'ask',
    availableModes: [
      { id: 'ask', name: 'Ask' },
      { id: 'code', name: 'Code' },
    ],
  };
  const h = setup(undefined, { modes });
  try {
    const key = 'acp:fake:mode';
    await h.sessions.chatRuntime.send({ key, text: 'hello', cwd: h.dir });
    await until(() => h.sessions.state.get(key).turn === 'idle');
    await h.sessions.chatRuntime.setMode({ chatId: key, value: 'code' });
    assert.ok(h.agentLog().some((m: any) => m.kind === 'in' && m.msg.method === 'session/set_mode' && m.msg.params.modeId === 'code'));
    await assert.rejects(
      h.sessions.chatRuntime.setMode({ chatId: key, value: 'nope' }),
      (e: any) => e.code === 'mode_unavailable' && /Unknown mode/.test(e.message),
    );
    await assert.rejects(
      h.sessions.chatRuntime.setMode({ chatId: 'acp:fake:none', value: 'code' }),
      (e: any) => e.code === 'mode_unavailable',
    );
    // a non-Error rejection still carries the coded reason
    const live = h.runtime.host;
    const original = live.setMode;
    live.setMode = async () => Promise.reject('boom');
    await assert.rejects(
      h.sessions.chatRuntime.setMode({ chatId: key, value: 'code' }),
      (e: any) => e.code === 'mode_unavailable' && /could not change/.test(e.message),
    );
    live.setMode = original;
  } finally {
    h.close();
  }
});

test('A: an ACP agent that ignores the first Stop does not make the next message the stopped turn: sent during, it waits queued; sent after the end, it is its own turn (#4023)', async () => {
  const h = setup(undefined, { ignoreCancel: 1 });
  try {
    const key = 'acp:fake:slowstop';
    const events: any[] = [];
    h.sessions.chatRuntime.host.on('event', (e: any) => e.key === key && events.push(e));
    const of = (kind: string) => events.filter((e) => e.kind === kind);
    const state = () => h.sessions.state.snapshot(key);
    await h.sessions.chatRuntime.send({ key, text: 'SLOW first', cwd: h.dir });
    await until(() => state().turn === 'running');
    const [first] = of('turnStart');
    h.sessions.chatRuntime.host.cancel(key);
    const during = await h.sessions.chatRuntime.send({ key, text: 'during' });
    assert.equal(during.action, 'queued');
    await until(() => of('turnEnd').length === 1 && state().turn === 'idle');
    assert.deepEqual([of('turnEnd')[0].turnId, of('turnEnd')[0].stopReason], [first.turnId, 'cancelled']);
    assert.equal(of('turnStart').length, 1, 'no ghost turn start; the stopped turn ended once');
    const after = await h.sessions.chatRuntime.send({ key, text: 'after' });
    assert.equal(after.action, 'started');
    // the message held for the person runs next, as a turn of its own
    await until(() => of('turnEnd').length === 3 && state().turn === 'idle');
    const ends = of('turnEnd');
    // each message has a turn of its own, found by what the start recorded of the person's words
    const turnOf = (text: string) => of('turnStart').find((s: any) => s.user?.content?.[0]?.text === text)?.turnId;
    assert.deepEqual([ends[1].stopReason, ends[1].turnId], ['end_turn', turnOf('after')]);
    assert.deepEqual([ends[2].stopReason, ends[2].turnId], ['end_turn', turnOf('during')]);
    assert.equal(new Set(ends.map((e: any) => e.turnId)).size, 3, 'every message has its own turn');
  } finally {
    h.close();
  }
});

test('queued Host display inputs release on deletion, survive send-now transfer and retire with their exact ownership guard', async () => {
  let ctx: any;
  const h = setup({ codex: (given: any) => ((ctx = given), { codex: {}, check: async () => {} }) });
  const key = 'queued-owner';
  try {
    h.sessions.state.patch(key, { turn: 'running', activeTurn: { id: 'busy', human: true } });
    const first = await h.sessions.chatRuntime.send({ key, text: 'first', clientId: 'input-first' });
    assert.equal(first.action, 'queued');
    assert.equal(ctx.userOf(key, 'input-first').clientId, 'input-first');
    h.sessions.controller.removeQueued(key, 'input-first');
    assert.equal(ctx.userOf(key, 'input-first'), undefined);
    const second = await h.sessions.chatRuntime.send({ key, text: 'second', clientId: 'input-second' });
    assert.equal(second.action, 'queued');
    const taken = h.sessions.controller.removeQueued(key, 'input-second', false);
    assert.equal(ctx.userOf(key, 'input-second').clientId, 'input-second', 'send-now transfer still owns its display input');
    h.sessions.state.patch(key, { queue: [taken] });
    h.sessions.state.patch(key, { queue: [] });
    assert.equal(ctx.userOf(key, 'input-second'), undefined);
  } finally {
    h.close();
  }
});

test('an original Host client id and image bytes reach the actual ACP agent and its display turn', async () => {
  const h = setup(undefined, { image: true });
  try {
    const key = 'acp:fake:original-image';
    const image = path.join(h.dir, 'picked.png');
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=';
    fs.writeFileSync(image, Buffer.from(data, 'base64'));
    const events: any[] = [];
    h.sessions.chatRuntime.host.on('event', (event: any) => events.push(event));
    await h.sessions.chatRuntime.send({
      key,
      text: 'look',
      cwd: h.dir,
      clientId: 'original-image-key',
      attachments: [{ kind: 'image', path: image }],
    });
    const prompt = await until(() => h.agentLog().find((r: any) => r.msg?.method === 'session/prompt'));
    assert(prompt.msg.params.prompt.some((part: any) => part.type === 'image' && part.data === data));
    const start = await until(() => events.find((event) => event.kind === 'turnStart'));
    assert.equal(start.user.clientId, 'original-image-key');
    assert.equal(start.user.content.filter((part: any) => part.type === 'localImage').length, 1);
    await until(() => h.sessions.state.snapshot(key).turn === 'idle');
  } finally {
    h.close();
  }
});

test('retiring a Host chat clears its queued display inputs without sending them', async () => {
  const h = setup();
  try {
    const chatId = 'acp:fake:retired';
    h.sessions.chatRuntime.discardQueued('missing');
    h.sessions.state.patch(chatId, { queue: [{ id: 'queued-input', text: 'never dispatch', attachments: [], opts: {} }] });
    const guard = createGuard({
      epochs: createEpochStore(path.join(h.dir, 'epochs-delete'), { report: () => {} }),
      ledger: createLedger(path.join(h.dir, 'ledger-delete'), { report: () => {} }),
    });
    const tools = { attach: () => ({ detach: () => {} }), abortChat: () => {} } as any;
    const protocol = createProtocol({
      dataDir: h.dir,
      runtime: h.sessions.chatRuntime,
      epochs: createEpochStore(path.join(h.dir, 'epochs-delete'), { report: () => {} }),
      guard,
      tools,
      status: () => ({}),
    });
    const conn = protocol.connection(() => {});
    await conn.call('host.hello', helloParams());
    await conn.call('chat.remove', { chatId, epoch: 1, key: 'delete-queued-chat' });
    assert.deepEqual(h.sessions.state.get(chatId).queue, []);
  } finally {
    h.close();
  }
});

test('the real ACP send path preserves a side-chat refusal that fires during native preparation', async () => {
  const h = setup();
  const parent = 'acp:fake:parent';
  const child = `acp:fake:side-chat-${crypto.randomUUID()}`;
  try {
    const epochs = createEpochStore(path.join(h.dir, 'epochs-side'), { report: () => undefined });
    epochs.admit(parent, 1);
    const guard = createGuard({ epochs, ledger: createLedger(path.join(h.dir, 'ledger-side'), { report: () => undefined }) });
    const protocol = createProtocol({ dataDir: h.dir, runtime: h.sessions.chatRuntime, epochs, guard, status: () => ({}) });
    const conn = protocol.connection(() => undefined);
    await conn.call('host.hello', helloParams());
    h.sessions.chatRuntime.host.on('event', (e: any) => {
      if (e.kind === 'turnStarting' && e.key === child) epochs.admit(parent, 2);
    });
    await assert.rejects(
      conn.call('chat.start', {
        chatId: child,
        key: crypto.randomUUID(),
        epoch: 0,
        harness: 'acp:fake',
        cwd: h.dir,
        text: 'side question',
        sideChat: { sourceId: parent, epoch: 1 },
      }),
      { code: 'side_chat_parent_changed' },
    );
    assert.equal(h.sessions.chats.isDeleted(child), true);
    assert.equal(
      h.agentLog().some((r) => r.msg?.method === 'session/prompt'),
      false,
    );
    conn.close();
  } finally {
    h.close();
  }
});
