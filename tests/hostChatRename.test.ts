// A machine chat's rename on the Host (`chat.rename`, feature `chatName`: shared/host/chatName.mjs, host/src/methods/chatName.mjs, host/src/chatRename.mjs) through the real protocol: the request's shape (A), what the Host keeps, tells and survives (W), what it refuses (B), and that no automatic title replaces the person's name on any family (I).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createAcpRuntime } from '../host/src/acp.mjs';
import { createChatRename, dropsTitle } from '../host/src/chatRename.mjs';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import { createHostSessions } from '../host/src/sessions.mjs';
import { FEATURES, PARSERS, REQUIRES, helloParams, parseParams, requireFeatures } from '../shared/host/schema.mjs';
import { NAME_FEATURE, NAME_MAX, nameOf } from '../shared/host/chatName.mjs';

const quiet = { report: () => undefined };
const scope = { chatId: 'claude:00000000-0000-4000-8000-000000000001', epoch: 1, key: 'key-rename-0001' };
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-rename-')));
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

test('A: the request names the chat and a name of 1 to 200 characters; anything else is refused and other fields are dropped', () => {
  assert.deepEqual(parseParams('chat.rename', { ...scope, name: '  Fix the login  ', extra: 1 }), { ...scope, name: 'Fix the login' });
  assert.equal(parseParams('chat.rename', { ...scope, name: 'x'.repeat(NAME_MAX) }).name.length, NAME_MAX);
  for (const name of [undefined, null, 7, '', '   ', 'x'.repeat(NAME_MAX + 1), 'two\nlines', 'tab\there', 'nul\u0000', 'del\u007f'])
    assert.throws(
      () => parseParams('chat.rename', { ...scope, name }),
      (e: any) => e.code === 'invalid',
      String(name),
    );
  assert.throws(
    () => parseParams('chat.rename', { epoch: 1, key: scope.key, name: 'x' }),
    (e: any) => e.code === 'invalid',
  );
  assert.equal(
    nameOf(' a ', (m) => new Error(m)),
    'a',
  );
});

test('A: the method is declared by its own file: paired only, gated on its feature, and an end without the feature is refused, not served half', () => {
  assert.equal(typeof PARSERS['chat.rename'], 'function');
  assert.deepEqual((REQUIRES as any)['chat.rename'], ['epoch', 'dedupe', NAME_FEATURE]);
  assert.ok(FEATURES.includes(NAME_FEATURE));
  assert.ok(helloParams().features.includes(NAME_FEATURE));
  const without = helloParams().features.filter((f: string) => f !== NAME_FEATURE);
  assert.throws(
    () => requireFeatures('chat.rename', { features: without }),
    (e: any) => e.code === 'feature_missing' && e.missing.includes(NAME_FEATURE),
  );
  assert.doesNotThrow(() => requireFeatures('chat.rename', { features: helloParams().features }));
});

/** A protocol over a runtime that has a rename (or none); one connection that has said hello. */
function wire(runtime: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(base, 'w-'));
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const protocol = createProtocol({
    runtime: { host, send: async () => ({ turnId: 't' }), permit: () => true, familyOf: () => 'claude', ...runtime } as any,
    epochs,
    guard,
    status: () => ({ running: true }),
  });
  const frames: any[] = [];
  const conn = protocol.connection((m: object) => frames.push(m));
  const ready = conn.call('host.hello', helloParams());
  return { host, frames, call: async (p: object) => (await ready, conn.call('chat.rename', { ...scope, ...p })), conn, ready };
}

test('W: the Host renames through its runtime, answers with the name, and a resent request with the same key is answered, not run twice', async () => {
  const renamed: any[] = [];
  const w = wire({ rename: async (chatId: string, name: string) => void renamed.push([chatId, name]) });
  const first = await w.call({ name: ' Mine ' });
  assert.deepEqual(first, { replayed: false, result: { name: 'Mine' } });
  assert.deepEqual(renamed, [[scope.chatId, 'Mine']]);
  const again = await w.call({ name: ' Mine ' });
  assert.deepEqual(again, { replayed: true, result: { name: 'Mine' } });
  assert.equal(renamed.length, 1);
  // another key is another rename, and a runtime that refuses answers with its refusal
  assert.equal((await w.call({ key: 'key-rename-0002', name: 'Other' })).replayed, false);
  assert.equal(renamed.length, 2);
});

test('B: a Host whose runtime cannot rename says so in a short sentence, and nothing is kept', async () => {
  const w = wire({});
  await assert.rejects(
    w.call({ name: 'Mine' }),
    (e: any) => e.code === 'unsupported' && /cannot rename a chat yet\. Update it\./.test(e.message),
  );
});

test('W: the stream tells the name on the chat’s state lane as the person’s own, to an end that speaks the lane', async () => {
  const w = wire({});
  await w.ready;
  await w.conn.call('chat.subscribe', { chatId: scope.chatId, epoch: 1, key: 'key-sub-00000001' });
  w.host.emit('event', { kind: 'threadName', chatId: scope.chatId, name: 'Mine', named: true });
  const states = w.frames.filter((m) => m.chatId === scope.chatId && m.frame?.t === 'state').map((m) => m.frame.patch);
  assert.deepEqual(states, [{ title: { name: 'Mine', provisional: null, named: true } }]);
});

/** A chat record store that keeps what the runtime wrote, as the Host's own does. */
function fakeChats(known: Record<string, any> = {}, writes = true) {
  const records = new Map<string, any>(Object.entries(known));
  return {
    records,
    patchMeta(id: string, patch: any) {
      if (!writes) return false;
      const rec = records.get(id) ?? { id, meta: { config: null } };
      records.set(id, { ...rec, meta: { ...rec.meta, ...patch } });
      return true;
    },
  };
}

function renamer(kind: string, o: { claude?: any; codex?: any; chats?: any } = {}) {
  const emitted: any[] = [];
  const said: string[] = [];
  const chats = o.chats ?? fakeChats();
  const rename = createChatRename({
    chats,
    controller: () => ({ ref: () => ({ kind, id: 'native-1' }) }),
    claude: o.claude,
    codex: o.codex,
    emit: (e: object) => void emitted.push(e),
    report: (m: string) => void said.push(m),
  });
  return { rename, emitted, said, chats };
}

test('W: a Claude Code chat is named in its own session, recorded as named by the person (keeping its other settings), and told as theirs', async () => {
  const asked: any[] = [];
  const claude = { claude: { turnApi: { rename: async (...a: any[]) => void asked.push(a) } } };
  const chats = fakeChats({ c1: { id: 'c1', meta: { config: { permission: 'plan' } } } });
  const r = renamer('claude', { claude, chats });
  await r.rename('c1', 'Mine');
  assert.deepEqual(asked, [['native-1', 'Mine']]);
  assert.deepEqual(chats.records.get('c1').meta.config, { permission: 'plan', titleNamed: true });
  assert.deepEqual(r.emitted, [{ kind: 'threadName', chatId: 'c1', name: 'Mine', named: true }]);
  assert.deepEqual(r.said, []);
});

test('W: a Codex chat is named through its thread; an ACP chat has no session name, so only the Host and the apps keep it', async () => {
  const asked: any[] = [];
  const codex = { codex: { codexThread: (id: string) => `thr-${id}`, threadRename: async (...a: any[]) => void asked.push(a) } };
  const r = renamer('codex', { codex });
  await r.rename('cx1', 'Mine');
  assert.deepEqual(asked, [['thr-cx1', 'Mine']]);
  assert.deepEqual(r.emitted, [{ kind: 'threadName', chatId: 'cx1', name: 'Mine', named: true }]);
  const a = renamer('acp:kimi', { claude: { claude: { turnApi: { rename: () => assert.fail('an ACP chat has no session name') } } } });
  await a.rename('acp:kimi:1', 'Mine');
  assert.deepEqual(a.emitted, [{ kind: 'threadName', chatId: 'acp:kimi:1', name: 'Mine', named: true }]);
  assert.deepEqual(a.said, []);
});

test('B: a family step that fails is reported and does not fail the rename: the name stands and is told', async () => {
  const boom = { claude: { turnApi: { rename: async () => Promise.reject(new Error('no transcript yet')) } } };
  const c = renamer('claude', { claude: boom });
  await c.rename('c1', 'Mine');
  assert.deepEqual(c.said, ["A chat's own session could not be renamed: no transcript yet"]);
  assert.equal(c.emitted.length, 1);
  assert.equal(c.chats.records.get('c1').meta.config.titleNamed, true);
  // a family the Host does not run, and a Codex chat with no thread yet
  const none = renamer('claude');
  await none.rename('c1', 'Mine');
  assert.match(none.said[0], /Claude Code is not available on this Host/);
  const nothread = renamer('codex', { codex: { codex: { codexThread: () => null, threadRename: () => assert.fail('no thread') } } });
  await nothread.rename('cx1', 'Mine');
  assert.match(nothread.said[0], /no Codex thread yet/);
  const nocodex = renamer('codex');
  await nocodex.rename('cx1', 'Mine');
  assert.match(nocodex.said[0], /no Codex thread yet/);
  assert.equal(nocodex.emitted.length, 1);
});

test('B: a chat whose record cannot be kept (deleted, unreadable) is refused as unknown: nothing is renamed or told', async () => {
  const r = renamer('claude', { chats: fakeChats({}, false), claude: { claude: { turnApi: { rename: () => assert.fail('not asked') } } } });
  await assert.rejects(r.rename('gone', 'Mine'), (e: any) => e.code === 'chat_unknown' && /no such chat/.test(e.message));
  assert.deepEqual(r.emitted, []);
});

test('I: only an automatic title for a chat the person named is dropped', () => {
  const chats = fakeChats({
    named: { meta: { config: { titleNamed: true } } },
    plain: { meta: { config: { permission: 'plan' } } },
    bare: { meta: {} },
  });
  const auto = (chatId: string, more: object = {}) => ({ kind: 'threadName', chatId, name: 'Auto', ...more });
  assert.equal(dropsTitle(chats, auto('named')), true);
  assert.equal(dropsTitle(chats, auto('named', { provisional: 'x' })), true);
  // the person's own name, a chat they did not name, another event and an event with no chat are told
  assert.equal(dropsTitle(chats, auto('named', { named: true })), false);
  for (const id of ['plain', 'bare', 'unknown']) assert.equal(dropsTitle(chats, auto(id)), false);
  assert.equal(dropsTitle(chats, { kind: 'turnEnd', chatId: 'named' }), false);
  assert.equal(dropsTitle(chats, { kind: 'threadName', key: 'named', name: 'x' }), false);
});

/** The Host's real sessions over the fake ACP agent and fake Claude Code and Codex families. */
function sessionsOn(dir: string) {
  const log = path.join(dir, 'agent.jsonl');
  fs.writeFileSync(
    path.join(dir, 'harnesses.json'),
    JSON.stringify({
      fake: {
        label: 'Fake',
        bin: process.execPath,
        args: [path.join(import.meta.dirname, 'fixtures/fake-acp-agent.mjs')],
        env: { FAKE_ACP_STATE: path.join(dir, 's'), FAKE_ACP_LOG: log, FAKE_ACP_PROFILE: '{}' },
      },
    }),
  );
  const paths = createPaths({ dataDir: dir, env: {} });
  const runtime = createAcpRuntime({ paths, env: {}, hostOptions: {} });
  const seen: any = {};
  const native: any[] = [];
  const families = {
    claude: (ctx: any) => {
      seen.claude = ctx;
      return {
        claudeTurns: { startTurn: async () => ({ started: true, turnId: 'x' }), stop: async () => undefined },
        claude: { turnApi: { rename: async (id: string, name: string) => void native.push(['claude', id, name]) } },
      };
    },
    codex: (ctx: any) => {
      seen.codex = ctx;
      return {
        codex: {
          codexThread: (id: string) => `thr-${id}`,
          threadRename: async (t: string, n: string) => void native.push(['codex', t, n]),
        },
      };
    },
  };
  const sessions = createHostSessions({ paths, env: {}, runtime, families: families as any });
  const events: any[] = [];
  sessions.events.on('event', (e: any) => e.kind === 'threadName' && events.push(e));
  return { sessions, seen, native, events, close: () => (sessions.close(), runtime.close()) };
}

test('I: a chat the person named is never retitled automatically, on Claude Code, Codex and an ACP agent, and a restart keeps it so', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'r-'));
  let h = sessionsOn(dir);
  try {
    // Claude Code and Codex chats: named, then the helper's title (a Claude helper, a Codex thread name) arrives and is dropped
    await h.sessions.chatRuntime.rename!('claude:c1', 'My Claude');
    await h.sessions.chatRuntime.rename!('cx1', 'My Codex');
    assert.deepEqual(h.native, [
      ['claude', 'c1', 'My Claude'],
      ['codex', 'thr-cx1', 'My Codex'],
    ]);
    h.seen.claude.emit({ kind: 'threadName', key: 'claude:c1', chatId: 'claude:c1', name: 'Auto Claude', provisional: 'hi' });
    h.seen.codex.emit({ kind: 'threadName', chatId: 'cx1', name: 'Auto Codex' });
    // an ACP chat: named before its first message, whose cut-short title is then dropped; a chat that was not named gets it
    await h.sessions.chatRuntime.rename!('acp:fake:n1', 'My Agent');
    await h.sessions.chatRuntime.send({ key: 'acp:fake:n1', text: 'hello there', cwd: dir });
    await h.sessions.chatRuntime.send({ key: 'acp:fake:n2', text: 'hello there', cwd: dir });
    await until(() => h.events.some((e) => e.chatId === 'acp:fake:n2' && e.name === 'hello there'));
    await until(() => h.sessions.state.snapshot('acp:fake:n1').turn === 'idle' && h.sessions.state.snapshot('acp:fake:n2').turn === 'idle');
    assert.deepEqual(
      h.events.map((e) => [e.chatId, e.name, e.named === true]),
      [
        ['claude:c1', 'My Claude', true],
        ['cx1', 'My Codex', true],
        ['acp:fake:n1', 'My Agent', true],
        ['acp:fake:n2', 'hello there', false],
      ],
    );
    // the flag is on the chat's record, so a Host that restarts on the same folder still drops the automatic title
    h.close();
    h = sessionsOn(dir);
    h.seen.claude.emit({ kind: 'threadName', key: 'claude:c1', chatId: 'claude:c1', name: 'Auto again' });
    h.seen.claude.emit({ kind: 'threadName', key: 'claude:c9', chatId: 'claude:c9', name: 'Another chat' });
    assert.deepEqual(
      h.events.map((e) => e.name),
      ['Another chat'],
    );
  } finally {
    h.close();
  }
});
