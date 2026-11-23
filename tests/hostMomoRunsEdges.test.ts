// More of MoMo's routine runs on a Host (host/src/momoRuns.mjs and what it stands on): an ACP agent and no main chat, a run that went quiet, prefs that cannot be read, the Memory page and a run's card through the server, a run that survives the home being asked for again and a report that is not remembered from.
import { fakeGate } from './support/host/fakeGate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createMomoHome } from '../host/src/momoHome.mjs';
// @ts-ignore
import { createMomoChats } from '../host/src/momoChats.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../host/src/secretStore.mjs';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';
import { waitFor } from './support/waitFor.ts';
import { servedHost } from './support/hostClientsWorld.ts';
import { MOMO, PROVIDER_ENV, world, turn } from './support/host/momoRunsKit.ts';

test('a routine runs on an ACP agent the same way, and with no main chat there is no brain: the run is not started and nothing is told', async (t) => {
  const w = await world(t, { harness: 'acp:opencode' });
  await w.home.prefs.change({ proactivity: 'default', quietHours: null });
  await w.routine();
  await w.scheduler.tick();
  assert.equal((await w.minute())?.ran.length, 1);
  const run = w.sends.at(-1);
  assert.match(run.key, /^acp:opencode:/);
  assert.equal(w.chats.isMomoChat(run.key), true);
  // events of turns that are not a run's are not its business, and a chunk with no text adds nothing
  w.events.emit('event', {
    kind: 'update',
    key: 'claude:other',
    turnId: 'other',
    update: { sessionUpdate: 'agent_message_chunk', content: { text: 'x' } },
  });
  w.events.emit('event', { kind: 'turnStart', key: run.key, turnId: 'run-turn' });
  w.events.emit('event', {
    kind: 'update',
    key: run.key,
    turnId: 'run-turn',
    update: { sessionUpdate: 'agent_message_chunk', content: {} },
  });
  w.events.emit('event', { kind: 'turnEnd', turnId: 'run-turn', stopReason: 'end_turn' });
  await waitFor(() => w.sends.some((s) => s.key === w.main.chatId), 'the report');
  assert.match(w.sends.at(-1).text, /Finished with nothing to say/);
  // no main chat: no brain
  const bare = await world(t, { main: false });
  await bare.home.prefs.change({ proactivity: 'default', quietHours: null });
  const routine = (await bare.routine())!;
  await bare.scheduler.tick();
  assert.deepEqual((await bare.minute())?.failed, [routine.id]);
  assert.equal(bare.sends.length, 0);
  assert.equal(bare.chats.main(), null);
});

test('a run that went quiet is stopped and told, an old one’s chat is removed, a chat that cannot be tagged is not started, and nothing is listed while the grant is revoked', async (t) => {
  const w = await world(t);
  await w.home.prefs.change({ proactivity: 'default', quietHours: null });
  await w.routine();
  await w.scheduler.tick();
  await w.minute();
  const run = w.sends.at(-1);
  // its chat's turn is not going and the run has sat 16 minutes
  w.states.set(run.key, { turn: 'idle' });
  w.clock.advance(16 * 60_000);
  await w.runs.source.list();
  assert.equal(w.stores().routines.openRuns().length, 0, 'the run ended');
  await waitFor(() => w.sends.some((s) => s.key === w.main.chatId && /didn’t finish/.test(s.text)), 'its report');
  // a month later its chat goes
  w.clock.advance(31 * 86_400_000);
  await w.runs.source.list();
  assert.equal(
    w
      .stores()
      .routines.endedBefore(Date.now() + 365 * 86_400_000)
      .filter((r: any) => !r.discarded).length,
    0,
  );
  // a record that cannot be tagged is not a chat to run in
  const broken: any = createMomoChats({
    home: w.home,
    sessions: { chats: { records: new Map(), patchMeta: () => undefined }, isolated: () => true },
    epochs: { current: () => 0 },
    env: PROVIDER_ENV,
  });
  assert.throws(() => broken.startBackground('claude', 'routine'), /could not be set up/);
  // the grant is revoked: nothing is listed, nothing runs
  await assert.rejects(w.home.grant({ account: 'a1', features: [] }), /Unknown request/);
  assert.deepEqual(await w.runs.source.list(), []);
});

test('prefs that cannot be read mean MoMo does nothing on its own, and a Host with no main chat has none', async (t) => {
  const w = await world(t);
  await w.home.prefs.change({ proactivity: 'high' });
  w.home.data.safeStorage.decryptString = () => {
    throw new Error('wrong key');
  };
  assert.equal(w.home.prefs.get().proactivity, 'off', 'the client is told the same');
  assert.deepEqual(w.home.prefs.forRoutines().momo, {
    routines: { proactivity: 'off' },
    paused: true,
    brief: { on: false, time: undefined, zone: undefined },
    notify: { previews: false, tellNowMax: 6 },
  });
  const none = await world(t, { main: false });
  assert.equal(none.chats.main(), null);
});

test('through the server, the Memory page’s requests need the home’s account presented, are checked, and see only what the store holds', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-memory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = createMomoHome({
    hostId: 'home-aaaa-1111',
    dataDir: path.join(dir, 'data'),
    safeStorage: createFileSafeStorage(path.join(dir, 'config')),
  });
  const host = await servedHost(t, { momo: home });
  const a = await host.paired('a', 'A');
  await a.conn.request('host.momoGrant', { account: 'a1', features: MOMO });
  await a.conn.request('host.hello', helloParams());
  await home.start({ name: 'Studio' });
  await home.stores()!.memory.save({ text: 'Likes tea', source: 'user', confidence: 'sure' });
  assert.equal((await a.conn.request('host.momoMemory', { op: 'list' })).facts[0].text, 'Likes tea');
  const { changes } = await a.conn.request('host.momoMemory', { op: 'changes' });
  assert.equal((await a.conn.request('host.momoMemory', { op: 'undo', id: changes[0].id })).change.op, 'undo');
  for (const bad of [{ op: 'wipe' }, { op: 'undo' }, { op: 'undo', id: '' }, {}])
    await assert.rejects(a.conn.request('host.momoMemory', bad), (e: any) => e.code === 'invalid');
  await home.close();
});

test('a card a MoMo run waits on is a Host approval: a connection that presented sees it, the first answer wins and the second is told who answered, the clock reminds and pauses, and one that presented nothing never hears of it', async (t) => {
  const w = await world(t);
  await w.home.prefs.change({ proactivity: 'default', quietHours: null });
  await w.routine();
  await w.scheduler.tick();
  await w.minute();
  const run = w.sends.at(-1).key;
  const connect = async (fingerprint: string, presents: boolean) => {
    const conn = w.protocol.connection(
      () => undefined,
      () => null,
      { principal: () => (presents ? ({ fingerprint, name: fingerprint, kind: 'phone' } as any) : null) },
    );
    await conn.call('host.hello', helloParams());
    if (presents) {
      await conn.call('host.momoGrant', { account: 'a1', features: MOMO });
      await conn.call('host.hello', helloParams());
    }
    return conn;
  };
  const phone = await connect('phone', true);
  const mac = await connect('mac', true);
  const stranger = await connect('stranger', false);
  w.events.emit('event', { kind: 'turnStart', key: run, turnId: 'card-turn' });
  w.events.emit('event', {
    kind: 'permission',
    key: run,
    requestId: 'card-1',
    turnId: 'card-turn',
    toolCall: { title: 'send the summary', kind: 'execute' },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  });
  const waiting = async (conn: any) => ((await conn.call('host.pending', {})).cards as any[]).map((c) => c.requestId);
  assert.deepEqual(await waiting(phone), ['card-1']);
  assert.deepEqual(await waiting(mac), ['card-1']);
  assert.deepEqual(await waiting(stranger), [], 'a connection that presented nothing is not told of it');
  // the first answer wins; the second is told who and when
  const answer = (conn: any, key: string) =>
    conn.call('chat.answer', { chatId: run, epoch: 0, key, requestId: 'card-1', optionId: 'allow' });
  await answer(phone, 'key-00000001');
  await assert.rejects(answer(mac, 'key-00000002'), (e: any) => e.code === 'card_answered' && e.details?.by?.fingerprint === 'phone');
  assert.deepEqual(await waiting(mac), []);
  // a card left alone is counted as any card is: asked, reminded after ten minutes, and the run paused after thirty, saying so
  const card = (id: string) =>
    w.events.emit('event', {
      kind: 'permission',
      key: run,
      requestId: id,
      turnId: 'card-turn',
      toolCall: { title: 'send the summary', kind: 'execute' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    });
  w.momoPushes.length = 0;
  card('card-2');
  assert.deepEqual(
    w.momoPushes.map((e) => e.kind),
    ['needsYou'],
  );
  for (const timer of [...w.timers].sort((x, y) => x.ms - y.ms)) timer.fn();
  assert.deepEqual(
    w.momoPushes.map((e) => e.kind),
    ['needsYou', 'reminder', 'paused'],
  );
  assert.deepEqual(w.pushes, [], 'nothing of a MoMo chat goes the way an ordinary chat’s card does');
  assert.deepEqual(
    ((await phone.call('host.pending', {})).attention as any[]).map((a) => [a.kind, a.reason]),
    [['paused', 'approval_timeout']],
  );
});

test('a run under way survives the home being asked for again, and the chat a routine’s result is told to stays marked in the gate’s one tracker, ever after', async (t) => {
  const w = await world(t);
  const gate = fakeGate();
  w.home.gate = gate;
  await w.home.prefs.change({ proactivity: 'default', quietHours: null });
  await w.routine();
  await w.scheduler.tick();
  await w.minute();
  const run = w.sends.at(-1).key;
  // a client asks for the same home again: the stores are opened new, and the run is still the Host's
  await w.home.start({ name: 'Studio' });
  turn(w, run, 'Nothing new today.');
  await waitFor(() => w.sends.some((s) => s.key === w.main.chatId), 'the report');
  assert.match(w.sends.at(-1).text, /“Morning” finished/, 'told as finished, not as cut short');
  // the words are in the chat's context from now on: not while the turn that answers them runs, not after it ends, not on the owner's next "thanks"
  assert.equal(gate.taintFor(w.main.chatId).tainted(), true);
  w.events.emit('event', { kind: 'turnStart', key: w.main.chatId, turnId: 'answer' });
  assert.equal(gate.taintFor(w.main.chatId).tainted(), true);
  w.events.emit('event', { kind: 'turnEnd', turnId: 'answer', stopReason: 'end_turn' });
  assert.equal(gate.taintFor(w.main.chatId).tainted(), true);
  w.events.emit('event', { kind: 'turnStart', key: w.main.chatId, turnId: 'thanks' });
  w.events.emit('event', { kind: 'turnEnd', turnId: 'thanks', stopReason: 'end_turn' });
  assert.equal(gate.taintFor(w.main.chatId).tainted(), true);
  // a report that could not be sent never entered the chat's context: it is as it was
  const failed = await world(t);
  const failedGate = fakeGate();
  failed.home.gate = failedGate;
  await failed.home.prefs.change({ proactivity: 'default', quietHours: null });
  await failed.routine();
  await failed.scheduler.tick();
  await failed.minute();
  failed.failSend(false);
  failed.protocol.asHost = async () => {
    throw new Error('refused');
  };
  const key = failed.sends.at(-1).key;
  turn(failed, key, 'again');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(failedGate.taintFor(failed.main.chatId).tainted(), false);
});
