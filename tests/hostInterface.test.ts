// The Host interface (electron/host): the local Host and a hand-written remote one pass one suite (send, stop, subscribe replay,
// ownership, dispose), and the local Host's own routing, permit and patch-log limits are covered on their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SessionStore } = require('../electron/session/state.cjs');
const { PatchLog } = require('../electron/host/patchLog.cjs');
const { createLocalHost } = require('../electron/host/local.cjs');
const { HOST_METHODS, HostError, assertHost, localHostInfo } = require('../electron/host/interface.cjs');

type Patch = { chatId: string; rev: number; patch: any };

/** What each implementation hands the shared suite: a Host plus the way to run a turn's worth of changes under it. */
interface World {
  host: any;
  /** chats the Host owns; "other" is never one of them */
  sent: string[];
  stopped: string[];
}

function localWorld(
  opts: { family?: string; turnIs?: boolean } = {},
): World & { log: any; store: any; claudeStops: string[]; permits: any[] } {
  const log = new PatchLog(3);
  const store = new SessionStore({ publish: (p: Patch) => log.record(p) });
  const sent: string[] = [];
  const stopped: string[] = [];
  const claudeStops: string[] = [];
  const permits: any[] = [];
  const owned = new Set(['a', 'b']);
  const controller = {
    send: async (chatId: string, item: any, origin: unknown, wait: boolean) => {
      sent.push(`${chatId}:${item.text}:${origin}:${wait}`);
      store.patch(chatId, { turn: 'running', queued: [item.text] });
      return { ok: true };
    },
    stopChat: async (chatId: string) => {
      stopped.push(chatId);
      store.patch(chatId, { turn: 'idle' });
      return true;
    },
    turnIs: () => opts.turnIs ?? true,
  };
  const host = createLocalHost({
    controller: () => controller,
    state: () => store,
    claudeTurns: () => ({ stop: (id: string) => (claudeStops.push(id), store.patch(id, { turn: 'idle' }), 'claude-stopped') }),
    family: () => opts.family ?? 'codex',
    log,
    owns: (id: string) => owned.has(id),
    list: () => [...owned],
    permit: (p: any) => (permits.push(p), 'permitted'),
  });
  return { host, sent, stopped, log, store, claudeStops, permits };
}

/** A Host that lives elsewhere: every call is a message to a machine that owns its own chats, revs and log. */
function remoteWorld(): World {
  const chats = new Map<string, { rev: number; patches: Patch[]; state: any }>([
    ['a', { rev: 0, patches: [], state: {} }],
    ['b', { rev: 0, patches: [], state: {} }],
  ]);
  const listeners = new Set<(p: Patch) => void>();
  const sent: string[] = [];
  const stopped: string[] = [];
  let gone = false;
  const take = (id: string) => {
    if (gone) throw new HostError('disposed', 'gone');
    const c = chats.get(id);
    if (!c) throw new HostError('not-owned', 'not mine');
    return c;
  };
  const change = (id: string, patch: any) => {
    const c = take(id);
    c.rev++;
    c.state = { ...c.state, ...patch };
    const p = { chatId: id, rev: c.rev, patch };
    c.patches.push(p);
    for (const fn of listeners) fn(p);
  };
  const host = {
    hostInfo: () => ({ id: 'box', kind: 'ssh', capabilities: { iab: true, cu: false, bu: false, shell: true } }),
    chats: () => [...chats.keys()],
    send: async (id: string, item: any) => {
      take(id);
      sent.push(item.text);
      change(id, { turn: 'running' });
      await Promise.resolve();
      take(id);
      return { ok: true };
    },
    stop: async (id: string) => {
      take(id);
      stopped.push(id);
      change(id, { turn: 'idle' });
    },
    permit: async () => undefined,
    subscribe: (id: string, from?: number) => {
      const c = take(id);
      return { snapshot: { ...c.state, rev: c.rev }, patches: typeof from === 'number' ? c.patches.filter((p) => p.rev > from) : null };
    },
    events: { onPatch: (fn: (p: Patch) => void) => (listeners.add(fn), () => listeners.delete(fn)) },
    dispose: () => {
      gone = true;
      listeners.clear();
    },
  };
  return { host: assertHost(host), sent, stopped };
}

for (const [name, make] of [
  ['local', () => localWorld()],
  ['fake remote', () => remoteWorld()],
] as const) {
  test(`${name}: send arrives as patches with increasing rev, and the live feed hears them`, async () => {
    const w = make();
    const heard: Patch[] = [];
    w.host.events.onPatch((p: Patch) => heard.push(p));
    await w.host.send('a', { text: 'one' });
    await w.host.send('a', { text: 'two' });
    assert.ok(heard.length >= 1 && heard.every((p) => p.chatId === 'a'));
    assert.deepEqual(
      heard.map((p) => p.rev),
      [...heard.map((p) => p.rev)].sort((x, y) => x - y),
    );
    assert.ok(w.host.subscribe('a').snapshot.rev >= 1);
  });

  test(`${name}: stop ends the running turn`, async () => {
    const w = make();
    await w.host.send('a', { text: 'go' });
    await w.host.stop('a');
    assert.equal(w.host.subscribe('a').snapshot.turn, 'idle');
  });

  test(`${name}: subscribe from an old rev replays exactly the missing patches`, async () => {
    const w = make();
    await w.host.send('a', { text: 'one' });
    const mid = w.host.subscribe('a').snapshot.rev;
    await w.host.stop('a');
    await w.host.send('a', { text: 'two' });
    const { snapshot, patches } = w.host.subscribe('a', mid);
    assert.deepEqual(
      patches.map((p: Patch) => p.rev),
      Array.from({ length: snapshot.rev - mid }, (_, i) => mid + 1 + i),
    );
    assert.deepEqual(w.host.subscribe('a', snapshot.rev).patches ?? [], []);
  });

  test(`${name} I2: every method refuses a chat it does not own`, async () => {
    const w = make();
    const refused = (e: any) => e instanceof HostError && e.code === 'not-owned';
    await assert.rejects(async () => w.host.send('other', { text: 'x' }), refused);
    await assert.rejects(async () => w.host.stop('other'), refused);
    await assert.rejects(async () => w.host.subscribe('other'), refused);
    assert.equal(w.sent.length, 0);
    assert.deepEqual(w.host.chats(), ['a', 'b']);
  });

  test(`${name} A3: disposing a Host while a send is in flight silences its feed and refuses further calls`, async () => {
    const w = make();
    const heard: Patch[] = [];
    w.host.events.onPatch((p: Patch) => heard.push(p));
    const sending = w.host.send('a', { text: 'slow' });
    w.host.dispose();
    await sending.catch(() => undefined);
    const before = heard.length;
    assert.throws(
      () => w.host.subscribe('a'),
      (e: any) => e.code === 'disposed',
    );
    assert.equal(heard.length, before);
  });
}

test('the interface names every method a Host must have, and assertHost rejects a Host missing one', () => {
  assert.deepEqual([...HOST_METHODS].sort(), ['chats', 'dispose', 'hostInfo', 'permit', 'send', 'stop', 'subscribe']);
  const w = localWorld();
  assert.equal(assertHost(w.host), w.host);
  for (const name of HOST_METHODS) assert.throws(() => assertHost({ ...w.host, [name]: undefined }), HostError);
  assert.throws(() => assertHost({ ...w.host, events: {} }), /onPatch/);
  assert.throws(() => assertHost(null), HostError);
});

test('the local Host reports itself as the local machine with every capability', () => {
  assert.deepEqual(localWorld().host.hostInfo(), {
    id: 'local',
    kind: 'local',
    capabilities: { iab: true, cu: true, bu: true, shell: true },
  });
  assert.deepEqual(localHostInfo(), localWorld().host.hostInfo());
});

test('local send passes the caller, waits for delivery on request, and defaults to neither', async () => {
  const w = localWorld();
  assert.deepEqual(await w.host.send('a', { text: 'hi' }, { origin: 7, waitForDelivery: true }), { ok: true });
  await w.host.send('b', { text: 'yo' });
  assert.deepEqual(w.sent, ['a:hi:7:true', 'b:yo:null:false']);
});

test('local stop routes by family, and a stale turn id retires without stopping', async () => {
  const claude = localWorld({ family: 'claude' });
  await claude.host.stop('a', 't1');
  assert.deepEqual(claude.claudeStops, ['a']);
  assert.deepEqual(claude.stopped, []);
  const codex = localWorld({ family: 'codex' });
  await codex.host.stop('a');
  assert.deepEqual(codex.stopped, ['a']);
  const stale = localWorld({ turnIs: false });
  assert.equal(await stale.host.stop('a', 'old'), 'retired');
  assert.deepEqual(stale.stopped, []);
});

test('local permit refuses a chat it does not own, and passes the value through', async () => {
  const w = localWorld();
  assert.equal(await w.host.permit({ value: 'default' }), 'permitted');
  assert.equal(await w.host.permit({ chatId: 'a', value: 'read-only' }), 'permitted');
  await assert.rejects(w.host.permit({ chatId: 'other', value: 'default' }), /does not own/);
  assert.equal(w.permits.length, 2);
});

test('ids that are not chat ids are invalid, not merely unowned', () => {
  const w = localWorld();
  for (const bad of [undefined, '', 5])
    assert.throws(
      () => w.host.subscribe(bad),
      (e: any) => e.code === 'invalid',
    );
});

test('the patch log keeps a bounded tail, and subscribe falls back to the snapshot alone when it lost patches', () => {
  const w = localWorld();
  for (let i = 0; i < 6; i++) w.store.patch('a', { turn: i % 2 ? 'idle' : 'running' });
  const { snapshot, patches } = w.host.subscribe('a', 0);
  assert.equal(patches, null);
  assert.equal(snapshot.rev, 6);
  assert.equal(w.host.subscribe('a', 4).patches.length, 2);
  w.log.forget('a');
  assert.equal(w.host.subscribe('a', 4).patches, null);
});

test("a listener that unsubscribes stops hearing, and another chat's patches are not delivered to a Host that does not own it", () => {
  const w = localWorld();
  const heard: string[] = [];
  const off = w.host.events.onPatch((p: Patch) => heard.push(p.chatId));
  w.store.patch('a', { turn: 'running' });
  w.store.patch('stranger', { turn: 'running' });
  off();
  w.store.patch('b', { turn: 'running' });
  assert.deepEqual(heard, ['a']);
});

test('the wired local Host owns recorded or tracked chats, lists all but MoMo’s, and takes only permissions the app has', async () => {
  const { localHostFor } = require('../electron/host/wiring.cjs');
  const records = new Map<string, any>([
    ['a', {}],
    ['m', { meta: { momo: 'main' } }],
  ]);
  const prefs: any[] = [];
  const tracked = new Set(['t']);
  const stopped: string[] = [];
  const kinds: Record<string, string> = { a: 'claude', t: 'acp:goose' };
  const published: number[] = [];
  const sessions: any = { has: (id: string) => tracked.has(id), snapshot: () => ({ rev: 1 }), publish: (p: any) => published.push(p.rev) };
  const host = localHostFor({
    live: { chats: { records }, patchPrefs: (p: any) => prefs.push(p) },
    controller: {
      turnIs: () => true,
      stopChat: (id: string) => stopped.push(id),
      ref: (id: string) => ({ kind: kinds[id] }),
      send: async () => 'sent',
    },
    sessions,
    claudeTurns: { stop: (id: string) => `claude:${id}` },
  });
  sessions.publish({ chatId: 'a', rev: 1, patch: { turn: 'running' } });
  assert.deepEqual(published, [1], 'the store still publishes to the windows');
  assert.deepEqual(host.subscribe('a', 0).patches, [{ chatId: 'a', rev: 1, patch: { turn: 'running' } }], 'the Host logged it');
  assert.deepEqual(host.chats(), ['a']);
  assert.equal(await host.send('t', { text: 'x' }), 'sent');
  assert.equal(host.stop('a'), 'claude:a');
  host.stop('t');
  assert.deepEqual(stopped, ['t']);
  assert.equal(host.subscribe('a').snapshot.rev, 1);
  tracked.add('odd');
  host.stop('odd');
  assert.deepEqual(stopped, ['t', 'odd'], 'a kind with no family takes the generic Stop');
  await host.permit({ value: 'read-only' });
  assert.deepEqual(prefs, [{ permission: 'read-only' }]);
  await assert.rejects(host.permit({ value: 'root' }), /isn't one/);
});

test('a throwing subscriber does not keep other subscribers or the publisher from the patch; a client ahead of the Host resyncs', () => {
  const log = new PatchLog();
  const heard: number[] = [];
  log.listen(() => {
    throw new Error('boom');
  });
  log.listen((p: Patch) => heard.push(p.rev));
  log.record({ chatId: 'a', rev: 1, patch: {} });
  assert.deepEqual(heard, [1]);
  assert.equal(log.since('a', 9, 1), null);
  assert.deepEqual(log.since('a', 1, 1), []);
});
