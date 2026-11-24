// MoMo's tasks on the user's other machines through the tasks service (host/src/momoServices/tasks.mjs): off until a link is bound, the home key, a task started on an allowed machine and followed there, a machine not allowed, and the connections and the key leaving memory when the home pauses or is wiped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tasksWorld, ask, until, REPORT } from './support/host/momoTasksWorld.ts';

process.env.MOPILOT_MOMO_HOST_LINK = '1';
const HOST_B = 'b'.repeat(32);
const OTHER = { id: 'm1', name: 'Studio', link: 'opaque', hostId: HOST_B };

/** A dialler to a scripted other Host. */
function link(answers: Record<string, any> = {}) {
  const calls: { method: string; params: any }[] = [];
  const listeners: ((e: any) => void)[] = [];
  let closed = 0;
  const base: Record<string, any> = {
    'host.challenge': { nonce: 'n', hostId: HOST_B },
    'host.auth': {},
    'host.hello': {},
    'chat.start': {},
    'chat.subscribe': {},
    'chat.stop': {},
    'host.status': { harnesses: [{ id: 'claude', detected: true, signedIn: true }] },
    ...answers,
  };
  return {
    calls,
    push: (e: any) => listeners.forEach((fn) => fn(e)),
    closed: () => closed,
    dial: async () => ({
      request: async (method: string, params: any) => {
        calls.push({ method, params });
        const a = base[method];
        if (a instanceof Error) throw a;
        return a;
      },
      onEvent: (fn: (e: any) => void) => (listeners.push(fn), () => undefined),
      onClose: () => undefined,
      close: () => void closed++,
    }),
  };
}

test('with no link bound the tasks run only on this machine, as before', async (t) => {
  const w = await tasksWorld(t);
  const out = await w.tasks.create({ ...ask, where: { machineId: 'm1', harness: 'claude' } });
  assert.equal(out.item?.state === 'failed' || !!out.error, true);
  assert.match(JSON.stringify(out), /can't reach that machine from here|offline/);
  assert.equal(w.sessions.sent.length, 0);
});

test("MoMo's public key is made once for the owner's app to register, and only while this Host is the home", async (t) => {
  const w = await tasksWorld(t);
  const key = await w.tasks.homeKey();
  assert.match(key, /^[A-Za-z0-9+/=]{40,}$/);
  assert.equal(await w.tasks.homeKey(), key);
  const away = await tasksWorld(t, { start: false });
  await assert.rejects(away.tasks.homeKey(), (e: any) => e.code === 'momo_home_away');
  await assert.rejects(away.tasks.allowMachine(OTHER), (e: any) => e.code === 'momo_home_away');
  await assert.rejects(away.tasks.disallowMachine('m1'), (e: any) => e.code === 'momo_home_away');
});

test('a task starts on an allowed machine, is followed there and settles from its journal; the machine is listed with its name', async (t) => {
  const w = await tasksWorld(t);
  const l = link();
  w.tasks.bindHostLink({ dial: l.dial });
  await w.tasks.allowMachine(OTHER);
  const { item, error } = await w.tasks.create({ ...ask, where: { machineId: 'm1', harness: 'claude' } });
  assert.ok(!error);
  assert.equal(item.where.machineId, 'm1');
  const start = l.calls.find((c) => c.method === 'chat.start')!.params;
  assert.equal(start.permission, 'default');
  assert.equal(w.sessions.sent.length, 0, 'nothing ran on this machine');
  const chatId = start.chatId;
  l.push({
    event: 'frame',
    chatId,
    frame: {
      t: 'durable',
      item: {
        t: 'event',
        event: {
          kind: 'update',
          update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Result: made it.\nFiles: a.xlsx\nEvidence: opened it.' } },
        },
      },
    },
  });
  l.push({
    event: 'frame',
    chatId,
    frame: { t: 'durable', item: { t: 'event', event: { kind: 'turnEnd', turnId: 't1', stopReason: 'end_turn' } } },
  });
  await until(async () => (await w.tasks.view()).some((v: any) => v.state !== 'working'), 'the task to settle');
  const view = await w.tasks.view();
  assert.notEqual(view[0].state, 'working');
  // the machine is no longer used once the owner takes the standing away
  await w.tasks.disallowMachine('m1');
  const refused = await w.tasks.create({ ...ask, title: 'second', where: { machineId: 'm1', harness: 'claude' } });
  assert.match(JSON.stringify(refused), /isn't one of your machines any more/);
});

test('a machine MoMo is not allowed to use says so with the one-click fix', async (t) => {
  const w = await tasksWorld(t);
  w.tasks.bindHostLink({ dial: link().dial });
  const out = await w.tasks.create({ ...ask, where: { machineId: 'm1', harness: 'claude' } });
  const text = JSON.stringify(out);
  assert.match(text, /isn't one of your machines any more/);
});

test('without a dialler the other machines are not reachable and the task says so; a working task is followed again after the home restarts', async (t) => {
  const w = await tasksWorld(t);
  w.tasks.bindHostLink(null);
  await w.tasks.allowMachine(OTHER);
  const view = await w.tasks.view();
  assert.deepEqual(view, []);
  const l = link();
  w.tasks.bindHostLink({ dial: l.dial });
  const { item } = await w.tasks.create({ ...ask, where: { machineId: 'm1', harness: 'claude' } });
  assert.equal(item.state, 'working');
  // the home stops and starts again: the working task on the other machine is followed again, from the start of its journal
  await w.home.lifecycle('pause');
  assert.ok(l.closed() >= 1, 'the connection to the other machine closed');
  await w.home.lifecycle('start');
  await until(() => l.calls.filter((c) => c.method === 'chat.subscribe').length >= 2, 'the session to be followed again');
});

test('a wipe stops the sessions on other machines first, then closes the connections', async (t) => {
  const w = await tasksWorld(t);
  const l = link();
  w.tasks.bindHostLink({ dial: l.dial });
  await w.tasks.allowMachine(OTHER);
  await w.tasks.create({ ...ask, where: { machineId: 'm1', harness: 'claude' } });
  await w.home.lifecycle('wipe');
  const stop = l.calls.findIndex((c) => c.method === 'chat.stop');
  assert.ok(stop >= 0, 'the remote session was told to stop with the key and the connection still there');
  assert.ok(l.closed() >= 1);
  assert.equal(l.calls.length - 1, stop, 'nothing was asked of that machine after its Stop');
});

test("what a session wrote enters MoMo's chat as outside content: the chat is marked before the card is posted, and a sink that names no chat takes nothing", async (t) => {
  const w = await tasksWorld(t);
  assert.equal(w.gate.taintFor('momo-chat').tainted(), false);
  await w.tasks.create(ask);
  const chatId = w.sessions.sent[0].key;
  w.sessions.say(chatId, REPORT);
  w.sessions.end(chatId);
  await until(() => w.cards.length === 1, 'the card');
  assert.equal(
    w.gate.taintFor('momo-chat').tainted(),
    true,
    'a later turn of that chat cannot change what MoMo remembers without the owner',
  );
  // a sink that names no chat (or no gate) is refused, so the next card stays owed and the chat is not touched
  const quiet = await tasksWorld(t);
  (quiet.binding.chat as any).chatId = () => null;
  await quiet.tasks.create(ask);
  const id = quiet.sessions.sent[0].key;
  quiet.sessions.say(id, REPORT);
  quiet.sessions.end(id);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(quiet.cards.length, 0);
  assert.equal(quiet.gate.taintFor('momo-chat').tainted(), false);
  // the card was kept owed: once the sink names its chat it is posted, after the chat is marked
  quiet.binding.chat.chatId = () => 'momo-chat';
  await quiet.tasks.deliver();
  assert.equal(quiet.cards.length, 1);
  assert.equal(quiet.gate.taintFor('momo-chat').tainted(), true);
});

test('after a restart with the app closed (no dialler bound), a task running on another machine is not lost and Stop does not claim to have stopped it', async (t) => {
  const w = await tasksWorld(t);
  const l = link();
  w.tasks.bindHostLink({ dial: l.dial });
  await w.tasks.allowMachine(OTHER);
  const { item } = await w.tasks.create({ ...ask, where: { machineId: 'm1', harness: 'claude' } });
  assert.equal(item.state, 'working');
  // the home restarts and nothing has bound a dialler yet
  await w.home.lifecycle('pause');
  w.tasks.bindHostLink(null);
  await w.home.lifecycle('start');
  await new Promise((r) => setTimeout(r, 100));
  const [view] = await w.tasks.view();
  assert.notEqual(view.state, 'failed', 'the task is not marked lost: it keeps running on the other machine');
  assert.doesNotMatch(JSON.stringify(view), /restarted|session-gone|interrupted/);
  assert.equal(w.sessions.cancelled.length, 0, 'nothing was cancelled on this machine, which never had the session');
  // Stop asks the other machine, cannot reach it, and says so
  const stopped = await w.tasks.stop(item.id);
  assert.match(JSON.stringify(stopped), /stop/i);
  assert.equal(w.sessions.cancelled.length, 0);
});

test('while the host-link switch is off the home neither makes a key, allows a machine nor takes a dialler', async (t) => {
  const w = await tasksWorld(t);
  const before = process.env.MOPILOT_MOMO_HOST_LINK;
  try {
    delete process.env.MOPILOT_MOMO_HOST_LINK;
    for (const call of [
      () => w.tasks.homeKey(),
      () => w.tasks.allowMachine(OTHER),
      () => w.tasks.keyContract(),
      () => w.tasks.keyRegistered('m1'),
      async () => w.tasks.bindHostLink({ dial: link().dial }),
    ])
      await assert.rejects(Promise.resolve().then(call), (e: any) => e.code === 'home_not_allowed');
    // taking a dialler away is always allowed
    w.tasks.bindHostLink(null);
    process.env.MOPILOT_MOMO_HOST_LINK = '1';
    assert.ok(await w.tasks.homeKey());
  } finally {
    if (before === undefined) delete process.env.MOPILOT_MOMO_HOST_LINK;
    else process.env.MOPILOT_MOMO_HOST_LINK = before;
  }
});

test('a card is not posted when MoMo has no gate to mark its chat with, and stays owed', async (t) => {
  const w = await tasksWorld(t);
  const service = w.home.service.bind(w.home);
  w.home.service = (name: string) => (name === 'gate' ? undefined : service(name));
  await w.tasks.create(ask);
  const id = w.sessions.sent[0].key;
  w.sessions.say(id, REPORT);
  w.sessions.end(id);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(w.cards.length, 0);
  w.home.service = service;
  await w.tasks.deliver();
  assert.equal(w.cards.length, 1);
});

test('with the host-link switch off a started home leaves no key or machine file behind, and nothing is rotated', async (t) => {
  const before = process.env.MOPILOT_MOMO_HOST_LINK;
  try {
    delete process.env.MOPILOT_MOMO_HOST_LINK;
    const w = await tasksWorld(t);
    assert.equal(fs.existsSync(path.join(w.momoDir, 'home-key.json')), false);
    assert.equal(fs.existsSync(path.join(w.momoDir, 'task-machines.json')), false);
  } finally {
    if (before === undefined) delete process.env.MOPILOT_MOMO_HOST_LINK;
    else process.env.MOPILOT_MOMO_HOST_LINK = before;
  }
});
