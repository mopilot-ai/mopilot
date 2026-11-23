// What the Switch host dialog calls (electron/host/hostContinue.cjs, localContinue.cjs, tailStore.cjs): a chat leaves this Mac and moves between machines over the real protocol, the handoff comes from the right source, and a returning source is reconciled (3.1, 3.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeHostProcess } from './support/hostProcessKit.ts';

const require = createRequire(import.meta.url);
const { createHostContinue } = require('../electron/host/hostContinue.cjs');
const { createLocalContinue } = require('../electron/host/localContinue.cjs');
const { createTailStore } = require('../electron/host/tailStore.cjs');

import { CHAT, code, connect, key, req, tmp, turns, world } from './support/hostServiceKit.ts';
test('a chat leaves this Mac: the handoff carries its conversation, the Mac keeps it read-only, the target answers the first message with it', async () => {
  const w = world();
  const got = await w.service.run(req());
  assert.deepEqual(got, { hostId: 'B', epoch: 1 });
  assert.deepEqual(w.ownership.get(CHAT), { hostId: 'B', ownerHostId: 'B', epoch: 1, folder: '/work/b' });
  assert.deepEqual(w.retired, [CHAT], 'the Mac let go of the chat');
  const { conn } = await connect(w.hosts.B);
  await conn.call('chat.send', { chatId: CHAT, epoch: 1, key: key(), text: 'now?' });
  const first = w.hosts.B.sends[0];
  assert.match(first.text, /^<sage-handoff from="Claude Code"/);
  assert.match(first.text, /fix the login bug/);
  assert.match(first.text, /Directory: \/work\/b/);
  assert.ok(first.text.endsWith('\n\nnow?'));
  assert.equal(first.cwd, '/work/b');
  // the Mac refuses a second commit for the chat it handed over
  await assert.rejects(
    w.local.channel.call('chat.commitContinue', { chatId: CHAT, expectedEpoch: 0, targetHostId: 'C', preparedId: 'prepared-0001' }),
    code('chat_released'),
  );
});

test('a chat comes back to this Mac: the handoff waits in the inbox for its next message, the machine lets go of it, and the Mac refuses what it does not answer', async () => {
  const w = world();
  await w.service.run(req());
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-back-'));
  // the machine's first message carries the Mac's record, which stays in its stream for the way back
  const b = await connect(w.hosts.B);
  await b.conn.call('chat.send', { chatId: CHAT, epoch: 1, key: key(), text: 'a question on B' });
  assert.deepEqual(await w.service.run(req({ targetHostId: 'local', cwd: folder })), { hostId: 'local', epoch: 2 });
  assert.equal(w.ownership.get(CHAT).ownerHostId, 'local');
  const waiting = w.inbox.pending(CHAT);
  assert.equal(waiting.cwd, fs.realpathSync(folder));
  assert.equal(waiting.harness, 'acp:gemini');
  assert.match(waiting.text, /fix the login bug/);
  assert.match(waiting.text, /a question on B/);
  assert.match(waiting.text, /Earlier in this conversation, handed over from another host/);
  assert.throws(() => w.hosts.B.continueHost.gate(CHAT, 1), code('chat_released'));
  for (const method of ['chat.send', 'host.status'])
    await assert.rejects(w.local.channel.call(method, { chatId: CHAT, epoch: 0, key: 'some-key-0001', text: 'x' }), code('unsupported'));
});

test("from one machine to another: the handoff is read from the source Host's snapshot, and the new Host starts from it", async () => {
  const w = world();
  await w.service.run(req());
  const b = await connect(w.hosts.B);
  await b.conn.call('chat.send', { chatId: CHAT, epoch: 1, key: key(), text: 'second question' });
  w.hosts.B.acp.emit('event', { kind: 'turnStart', turnId: 'x1', key: CHAT });
  w.hosts.B.acp.emit('event', {
    kind: 'update',
    turnId: 'x1',
    update: { sessionUpdate: 'agent_message_chunk', content: { text: 'answer on B' } },
  });
  w.hosts.B.acp.emit('event', { kind: 'turnEnd', turnId: 'x1' });
  const got = await w.service.run(req({ targetHostId: 'C', cwd: '/work/c' }));
  assert.deepEqual(got, { hostId: 'C', epoch: 2 });
  const c = await connect(w.hosts.C);
  await c.conn.call('chat.send', { chatId: CHAT, epoch: 2, key: key(), text: 'and now' });
  assert.match(w.hosts.C.sends[0].text, /second question/);
  assert.match(w.hosts.C.sends[0].text, /answer on B/);
});

test('refusals reach the dialog with their code and the chat stays where it was: an unreachable target, a Host that cannot agree', async () => {
  const w = world();
  w.down.add('B');
  await assert.rejects(w.service.run(req()), code('target_offline'));
  assert.equal(w.ownership.get(CHAT).ownerHostId, 'local');
  // a Host whose features do not include what a continue needs is refused before anything is sent
  const w3 = world();
  const proto = w3.hosts.B.protocol;
  const original = proto.connection;
  proto.connection = (emit: any) => {
    const conn = original(emit);
    return { ...conn, call: (m: string, p: any) => (m === 'host.hello' ? conn.call(m, { ...p, features: ['dedupe'] }) : conn.call(m, p)) };
  };
  await assert.rejects(w3.service.run(req()), code('feature_missing'));
  assert.equal(w3.ownership.get(CHAT).ownerHostId, 'local');
});

/** A service whose source Host answers a subscribe with exactly these stream messages. */
function withStream(messages: (chatId: string) => object[]) {
  const w = world();
  w.ownership.set(CHAT, { hostId: 'B', ownerHostId: 'B', epoch: 1, folder: '/b' });
  const session = async (_id: string, onEvent?: (e: any) => void) => ({
    call: async (method: string) => {
      if (method === 'host.hello') return { protocol: { minor: 1, floor: 1 }, features: ['epoch', 'dedupe', 'isolation', 'lanes'] };
      for (const m of messages(CHAT)) onEvent?.(m);
      return { subscribed: true };
    },
    close: () => undefined,
  });
  const reports: string[] = [];
  const service = createHostContinue({
    ownership: w.ownership,
    hostState: () => 'online',
    session,
    local: w.local.channel,
    localTurns: async () => ({ turns, failed: [], label: 'x', model: null }),
    harnessOf: () => ({ harness: 'acp:gemini', label: 'Gemini' }),
    tails: w.tails,
    report: (p: string) => reports.push(p),
    newKey: () => 'unused-key-0001',
    mirrorRev: () => 0,
    mirror: () => null,
    sleep: async () => undefined,
  });
  return { w, service, reports };
}
const frame = (chatId: string, f: object) => ({ event: 'frame', chatId, frame: f });
const hello = (snapshot: object | null) => ({ t: 'hello', seq: 0, rev: 2, epoch: 1, snapshot, inFlightEphemeral: [] });

test("the source Host's stream may carry the conversation in its Hello, or fail the app: a bad frame is reported and no Hello is an error", async () => {
  // the Hello holds the snapshot; frames for other chats and other events are ignored
  const ok = withStream((id) => [
    frame('other', { t: 'nonsense' }),
    { event: 'closed', chatId: id },
    frame(
      id,
      hello({
        items: [
          { t: 'user', turnId: 'a', text: 'kept in the snapshot' },
          { t: 'assistant', turnId: 'a', text: 'ok' },
        ],
      }),
    ),
  ]);
  // the target here answers a preparation with nothing useful, so each run ends after the handoff was built from the stream
  await assert.rejects(ok.service.run(req({ targetHostId: 'C', cwd: '/work/c' })), code('not_prepared'));
  assert.deepEqual(ok.reports, []);
  const bad = withStream((id) => [frame(id, { t: 'nonsense' })]);
  await assert.rejects(bad.service.run(req({ targetHostId: 'C', cwd: '/work/c' })), code('not_prepared'));
  assert.ok(bad.reports.some((p) => /could not be read/.test(p)));
  assert.ok(bad.reports.some((p) => /no snapshot/.test(p)));
  // a snapshot that lists no items is a chat with none
  const bare = withStream((id) => [frame(id, hello({}))]);
  await assert.rejects(bare.service.run(req({ targetHostId: 'C', cwd: '/work/c' })), code('not_prepared'));
  // a Hello with no snapshot and no frames behind it is a chat with no items
  const empty = withStream((id) => [frame(id, hello(null))]);
  await assert.rejects(empty.service.run(req({ targetHostId: 'C', cwd: '/work/c' })), code('not_prepared'));
});

test("the source lost: the user's yes continues without it; when it returns it is told, poisons its copy, and the tail is kept read-only", async () => {
  const w = world();
  await w.service.run(req());
  const b = await connect(w.hosts.B);
  await b.conn.call('chat.send', { chatId: CHAT, epoch: 1, key: key(), text: 'last thing on B' });
  w.down.add('B');
  await assert.rejects(w.service.run(req({ targetHostId: 'C', cwd: '/work/c' })), code('lost_host_declined'));
  const got = await w.service.run(req({ targetHostId: 'C', cwd: '/work/c', lostHostConfirmed: true }));
  assert.deepEqual(got, { hostId: 'C', epoch: 2 });
  assert.equal(w.ownership.get(CHAT).lostHost.sourceHostId, 'B');
  // nothing on this Mac holds the conversation of a chat that runs on another machine yet, so the record says it is incomplete
  const first = (await connectAndFirst(w.hosts.C, 2)).text;
  assert.match(first, /Directory: \/work\/c/);
  assert.match(first, /may be missing earlier turns/);
  w.down.delete('B');
  await w.service.hostReturned('B');
  assert.equal(w.hosts.B.epochs.current(CHAT), 2);
  assert.equal(w.ownership.get(CHAT).lostHost, undefined);
  assert.equal(w.tails.read(CHAT)[0].hostId, 'B');
  // a Host that returns with nothing moved is only given the releases it missed
  const before = w.sessions.length;
  await w.service.hostReturned('B');
  assert.equal(w.sessions.length, before);
  assert.equal(w.service.machine().movedFrom('B').length, 0);
});

async function connectAndFirst(host: ReturnType<typeof makeHostProcess>, epoch: number) {
  const { conn } = await connect(host);
  await conn.call('chat.send', { chatId: CHAT, epoch, key: key(), text: 'go' });
  return host.sends[0];
}

test('a returning Host that cannot be reached for the hello is reported, not thrown', async () => {
  const w = world();
  w.down.add('B');
  const m = w.service.machine();
  w.ownership.set(CHAT, {
    hostId: 'C',
    ownerHostId: 'C',
    epoch: 1,
    folder: '/c',
    lostHost: { sourceHostId: 'B', targetHostId: 'C', epoch: 1, rev: 0 },
  });
  assert.equal(m.movedFrom('B').length, 1);
  await w.service.hostReturned('B');
  assert.ok(w.problems.some((p) => /could not be told/.test(p)));
});

test('the tail store keeps one tail per chat and Host, replaces a repeat, and never overwrites a file it cannot read', () => {
  const file = path.join(tmp(), 'tails.json');
  const store = createTailStore(file);
  assert.deepEqual(store.read('c1'), []);
  store.merge({ chatId: 'c1', hostId: 'a|b', items: [{ x: 1 }] });
  store.merge({ chatId: 'c1', hostId: 'a|b', items: [{ x: 1 }, { x: 2 }] });
  store.merge({ chatId: 'c1', hostId: 'h2', items: [] });
  store.merge({ chatId: 'c2', hostId: 'h2', items: [{ y: 1 }] });
  assert.deepEqual(
    store
      .read('c1')
      .map((t: any) => [t.hostId, t.items.length])
      .sort(),
    [
      ['a|b', 2],
      ['h2', 0],
    ],
  );
  fs.writeFileSync(file, '{ broken');
  assert.deepEqual(store.read('c1'), []);
  assert.throws(() => store.merge({ chatId: 'c1', hostId: 'h2', items: [] }));
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken');
});

test('this Mac answers the requests of a continue: a subscribe at its epoch, a preparation only for a chat it does not run, nothing else', async () => {
  const w = world();
  const prepare = { chatId: CHAT, epoch: 1, key: 'prep-key-0001', harness: 'acp:gemini', cwd: '/w', handoff: 'x' };
  assert.deepEqual(await w.local.channel.call('chat.subscribe', { chatId: CHAT, epoch: 0 }), { subscribed: true });
  await assert.rejects(w.local.channel.call('chat.prepareContinue', prepare), code('same_host'));
  const idle = createLocalContinue({
    dir: path.join(w.dir, 'idle'),
    target: w.inbox.target,
    serves: () => false,
    busy: () => false,
    retire: async () => undefined,
    report: () => undefined,
  });
  await assert.rejects(idle.channel.call('chat.prepareContinue', { ...prepare, harness: 'nonsense:x' }), code('invalid'));
  await assert.rejects(
    idle.channel.call('chat.prepareContinue', { ...prepare, cwd: path.join(w.dir, 'missing') }),
    (e: any) => e.code !== undefined,
  );
  assert.ok((await idle.channel.call('chat.prepareContinue', { ...prepare, key: 'prep-key-0002', cwd: w.dir })).preparedId);
});

test('a hello that lacks what a continue needs, a session that cannot open with a non-error, and a snapshot with no items are all refused or read as empty', async () => {
  const session = (hello: object | null, fail?: unknown) => async (_id: string, onEvent?: (e: any) => void) => {
    if (fail !== undefined) throw fail;
    return {
      call: async (method: string) => {
        if (method === 'host.hello') return hello;
        onEvent?.(frame(CHAT, { t: 'hello', seq: 0, rev: 0, epoch: 1, snapshot: {}, inFlightEphemeral: [] }));
        return { subscribed: true };
      },
      close: () => undefined,
    };
  };
  const build = (open: any) => {
    const w = world();
    return createHostContinue({
      ownership: w.ownership,
      hostState: () => 'online',
      session: open,
      local: w.local.channel,
      localTurns: async () => ({ turns, failed: [], label: 'x', model: null }),
      harnessOf: () => ({ harness: 'acp:gemini', label: 'Gemini' }),
      tails: w.tails,
      report: () => undefined,
      newKey: () => 'unused-key-0001',
      mirrorRev: () => 0,
      mirror: () => null,
      sleep: async () => undefined,
    });
  };
  const poor = { protocol: { minor: 1, floor: 1 }, features: ['dedupe'] };
  await assert.rejects(build(session(poor)).run(req()), (e: any) => e.code === 'feature_missing' && e.notSent === true);
  await assert.rejects(build(session(null, 'boom')).run(req()), (e: any) => e?.message === 'boom' && e.notSent === true);
});

test('a commit whose answers are lost is asked again after a pause, and the move still settles', async () => {
  const w = world();
  const slept: number[] = [];
  let lost = 2;
  const session = async (hostId: string, onEvent?: (e: any) => void) => {
    const conn = w.hosts[hostId].protocol.connection((m: object) => onEvent?.(m));
    return {
      call: async (method: string, params: object) => {
        const res = await conn.call(method, params);
        if (method === 'chat.commitContinue' && lost-- > 0) throw new Error('reply lost');
        return res;
      },
      close: () => conn.close(),
    };
  };
  const service = createHostContinue({
    ownership: w.ownership,
    hostState: () => 'online',
    session,
    local: w.local.channel,
    localTurns: async () => ({ turns, failed: [], label: 'x', model: null }),
    harnessOf: () => ({ harness: 'acp:gemini', label: 'Gemini' }),
    tails: w.tails,
    report: () => undefined,
    newKey: () => 'unused-key-0001',
    mirrorRev: () => 0,
    mirror: () => null,
    sleep: async (ms: number) => void slept.push(ms),
  });
  // from B (not this Mac) so the commit goes through a session
  w.ownership.set(CHAT, { hostId: 'B', ownerHostId: 'B', epoch: 0, folder: '/b' });
  await connect(w.hosts.B);
  assert.deepEqual(await service.run(req({ targetHostId: 'C', cwd: '/work/c' })), { hostId: 'C', epoch: 1 });
  assert.equal(slept.length, 2);
});

test('A1/A4: a second request for the chat is refused while one runs and does not take its confirmation with it', async () => {
  const w = world();
  await w.service.run(req());
  w.down.add('B');
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const original = w.hosts.C.protocol.connection;
  w.hosts.C.protocol.connection = (emit: any) => {
    const conn = original(emit);
    return { ...conn, call: async (m: string, p: any) => (m === 'chat.prepareContinue' ? (await gate, conn.call(m, p)) : conn.call(m, p)) };
  };
  const first = w.service.run(req({ targetHostId: 'C', cwd: '/work/c', lostHostConfirmed: true }));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await assert.rejects(w.service.run(req({ targetHostId: 'C', cwd: '/work/c', lostHostConfirmed: false })), code('continue_in_flight'));
  release();
  assert.deepEqual(await first, { hostId: 'C', epoch: 2 });
});
