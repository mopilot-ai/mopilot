// Codex on a Host runs a chat on the credential it was recorded on (#4667 H3): a chat on a credential the main app-server is not running on gets an app-server of its own for it, started with its first thread, so the machine's own login runs beside a key the app lent, neither using the other's. Real AppServers over fake processes, through the family's own prepare and the adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createCodexFamily, LANE, LANE_IDLE_MS, NOT_SIGNED_IN } from '../host/src/codexFamily.mjs';
import { createChatCredentials } from '../host/src/chatCredentials.mjs';
import { CODEX_TOKEN_ENV } from '../shared/host/orgAccess.mjs';
import { fakeCodexSpawn } from './support/codex-harness/fakeCodexProcess.ts';
import { deferred, tick } from './support/async-scenarios.ts';
import { HostRefusal } from '../host/src/hostFs.mjs';
import { useFakeClock } from './support/ports/clock.ts';

const { SessionStore } = createRequire(import.meta.url)('../electron/session/state.cjs');
const { AppServer } = createRequire(import.meta.url)('../electron/harness/codexProcess.cjs');

const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await tick();
};
const EPHEMERAL = 'cli_auth_credentials_store="ephemeral"';
const ORG = { identity: 'acme', token: 'org-token', gateways: { openai: 'https://gw.example/v1' } };

type Source = 'own' | 'key' | 'org';

function world(
  o: {
    key?: string | null;
    org?: typeof ORG | null;
    probe?: () => Promise<boolean>;
    recorded?: Record<string, Source>;
    holdLane?: boolean;
    holdDelete?: boolean;
    fork?: () => unknown;
  } = {},
) {
  let n = 0;
  let initialized = 0;
  const fake = fakeCodexSpawn('main', {
    initialize: () => (++initialized > 1 && o.holdLane ? undefined : { userAgent: 'codex_cli_rs/0.162.1' }),
    'account/login/start': () => ({ type: 'apiKey' }),
    'thread/start': () => ({ thread: { id: `th-${++n}`, cwd: '/w', ephemeral: false } }),
    'thread/fork': () => (o.fork ? o.fork() : { thread: { id: `th-${++n}`, cwd: '/w', ephemeral: false } }),
    'thread/delete': () => (o.holdDelete ? undefined : {}),
    'turn/start': (p: any) => ({ turn: { id: `turn-of-${p.threadId}` } }),
    // a request nobody answers yet
    'slow/call': () => undefined,
  });
  const lent = { key: o.key === undefined ? null : o.key, org: o.org ?? null };
  const kept = new Map<string, Source>(Object.entries(o.recorded ?? {}));
  const threadChat = new Map<string, string>();
  const committed: any[] = [];
  // the adapter's own read of Codex's config is not what these tests are about
  const requestsOf = (p: any) => (p.lines as any[]).filter((m) => m.method && m.method !== 'config/read').map((m) => m.method);
  const controller: any = {
    chatOf: (id: string) => threadChat.get(id) ?? id,
    requestChat: (id: string) => threadChat.get(id) ?? id,
    isCurrentSource: () => true,
    ref: () => ({ kind: 'codex' }),
    onCodexMessage: () => undefined,
    onCodexExit: () => [],
    codexStopped: () => undefined,
    onCodexOutgoing: () => true,
    invalidate: () => undefined,
  };
  const ctx: any = {
    paths: { dataDir: '/data' },
    state: new SessionStore(),
    chats: {
      records: new Map(),
      get: () => null,
      names: (nativeId: string) => threadChat.has(nativeId),
      record: (id: string) => ({ id, meta: {} }),
      patchMeta: () => undefined,
      commit: (r: any) => !!committed.push(r),
    },
    controller: () => controller,
    emit: () => undefined,
  };
  const leases: any = { loginKey: () => lent.key, orgLease: () => lent.org, onChange: () => undefined };
  const family = createCodexFamily({
    env: { CODEX_HOME: '/Users/me/.codex' },
    which: () => '/bin/codex',
    probe: (o.probe ?? (async () => true)) as any,
    leases,
    credentials: { sourceOf: (chat: string) => kept.get(chat) ?? null },
    spawn: fake.spawn,
  })(ctx);
  /** Starts a chat's thread and tells the controller which chat it is. */
  const begin = async (chatId: string) => {
    await family.prepare({ chatId, cwd: '/w' });
    const nativeId = JSON.stringify(committed.at(-1)).match(/th-\d+/)![0];
    threadChat.set(nativeId, chatId);
    return nativeId;
  };
  /** What kind of credential the nth process was started for. */
  const kindOf = (i: number) => {
    const c = fake.calls[i];
    return c.opts.env[CODEX_TOKEN_ENV] ? 'org' : c.args.includes(EPHEMERAL) ? 'ephemeral' : 'own';
  };
  return { fake, family, begin, kept, lent, kindOf, requestsOf, threadChat, ctx };
}

test('the marker is a symbol, so it never reaches the app-server', () => {
  assert.equal(typeof LANE, 'symbol');
  assert.equal(JSON.stringify({ [LANE]: 'own', cwd: '/w' }), '{"cwd":"/w"}');
});

test('a guarded Codex fork rechecks policy after the credential lane starts and releases its queued request', async (t) => {
  const w = world({ key: 'sk-test', recorded: { own: 'own', keyed: 'key' }, holdLane: true });
  t.after(() => w.family.close());
  await w.begin('keyed');
  const parent = 'own-native-thread';
  w.threadChat.set(parent, 'own');
  const source = { chatId: 'own', id: parent, binding: 'source' };
  let allowed = true;
  const refusal = new HostRefusal('policy_refused', 'The organization no longer permits Codex.');
  const check = () => {
    if (!allowed) throw refusal;
  };
  const opening = w.family.prepare({ chatId: 'side', cwd: '/w', source, check });
  const refused = assert.rejects(opening, (error) => error === refusal);
  await settle();
  const initialize = w.fake.sent('initialize', 1)[0];
  assert.ok(initialize, 'the source credential lane was cold');
  assert.equal(w.family.codex.server.isolated?.busy(), true);
  allowed = false;
  w.fake.procs[1].say({ id: initialize.id, result: { userAgent: 'codex_cli_rs/0.162.1' } });
  await refused;
  assert.deepEqual(w.fake.sent('thread/fork', 1), []);
  assert.equal(w.family.codex.server.isolated?.busy(), false);
  allowed = true;
  const commit = w.ctx.chats.commit;
  w.ctx.chats.commit = () => false;
  await assert.rejects(w.family.prepare({ chatId: 'side', cwd: '/w', source, check }), /record the new chat/);
  await settle();
  assert.equal(w.fake.sent('thread/delete', 1)[0].params.threadId, 'th-2');
  w.ctx.chats.commit = commit;
  assert.equal(await w.family.prepare({ chatId: 'side', cwd: '/w', source, check }), true);
  assert.equal(w.fake.sent('thread/fork', 1)[0].params.threadId, parent);
  assert.equal(w.fake.sent('thread/fork', 0).length, 0);
});

test('a fork waiting for a provider never starts the credential lane after revocation', async (t) => {
  const w = world({ key: 'sk-test', recorded: { own: 'own', keyed: 'key' } });
  t.after(() => w.family.close());
  await w.begin('keyed');
  const ready = deferred<void>();
  const waiting = deferred<void>();
  w.family.codex.providerPending = () => (waiting.resolve(), ready.promise);
  let allowed = true;
  const refusal = new HostRefusal('policy_refused', 'The organization no longer permits Codex.');
  const opening = w.family.prepare({
    chatId: 'side',
    cwd: '/w',
    source: { chatId: 'own', id: 'own-native-thread', binding: 'source' },
    check() {
      if (!allowed) throw refusal;
    },
  });
  const refused = assert.rejects(opening, (error) => error === refusal);
  await waiting.promise;
  allowed = false;
  ready.resolve();
  await refused;
  assert.equal(w.fake.procs.length, 1);
  assert.deepEqual(w.fake.sent('thread/fork', 0), []);
});

test('fork receipts are checked before native bookkeeping and an expired fork lets its lane go idle', async (t) => {
  const clock = useFakeClock(t);
  let answer: () => unknown = () => ({ thread: { id: 'replacement', name: 'malformed' } });
  const w = world({ key: 'sk-test', recorded: { parent: 'own', keyed: 'key' }, fork: () => answer(), holdDelete: true });
  t.after(() => w.family.close());
  await w.begin('keyed');
  w.threadChat.set('replacement', 'parent');
  const adapter = w.family.codex;
  const lanes = adapter.server.isolated!;
  const request = { chatId: 'side', cwd: '/w', source: { chatId: 'parent', id: 'earlier', binding: 'source' } };
  await assert.rejects(w.family.prepare(request), { code: 'unsupported' });
  assert.equal(adapter.meta.has('replacement'), false);
  assert.equal(adapter.leases.has('replacement'), false);
  assert.deepEqual(w.fake.sent('thread/delete', 1), []);
  assert.equal(lanes.busy(), false);

  answer = () => {
    throw new Error('Native fork refused');
  };
  await assert.rejects(w.family.prepare(request), /Native fork refused/);
  assert.equal(lanes.busy(), false);

  answer = () => undefined;
  const opening = w.family.prepare(request);
  const refused = assert.rejects(opening, { code: 'side_chat_fork_timeout' });
  await settle();
  assert.equal(lanes.busy(), true);
  const fork = w.fake.sent('thread/fork', 1).at(-1);
  clock.advance(30_000);
  await refused;
  assert.equal(lanes.busy(), false);
  w.fake.procs[1].say({ id: fork.id, result: { thread: { id: 'late-child' } } });
  await settle();
  assert.equal(w.fake.sent('thread/delete', 1)[0].params.threadId, 'late-child');
  assert.equal(lanes.busy(), false);
  clock.advance(5_000);
  await settle();
  assert.equal(adapter.pending.size, 0);
});

test('with a key lent, a chat on the machine’s own login gets an app-server of its own and a chat on the key stays on the main one', async () => {
  const w = world({ key: 'sk-test', recorded: { own: 'own', keyed: 'key' } });
  const keyed = await w.begin('keyed');
  assert.equal(w.fake.procs.length, 1, 'the key chat needs no second process');
  const own = await w.begin('own');
  assert.equal(w.fake.procs.length, 2);
  // the main one runs on the lent key (ephemeral store, told the key after initialize); the lane on the machine's login (nothing lent)
  assert.deepEqual([w.kindOf(0), w.kindOf(1)], ['ephemeral', 'own']);
  assert.deepEqual(w.requestsOf(w.fake.procs[0]), ['initialize', 'initialized', 'account/login/start', 'thread/start']);
  assert.deepEqual(w.requestsOf(w.fake.procs[1]), ['initialize', 'initialized', 'thread/start']);
  assert.equal(w.fake.calls[1].opts.env.CODEX_HOME, '/Users/me/.codex');
  assert.deepEqual(w.fake.sent('initialize', 1)[0].params, w.fake.sent('initialize', 0)[0].params);
  // each turn goes to the process its thread lives in, and both are running at once
  const a = w.family.codex.request('turn/start', { threadId: own, input: [] });
  const b = w.family.codex.request('turn/start', { threadId: keyed, input: [] });
  await Promise.all([a, b]);
  assert.deepEqual(
    w.fake.sent('turn/start', 1).map((m: any) => m.params.threadId),
    [own],
  );
  assert.deepEqual(
    w.fake.sent('turn/start', 0).map((m: any) => m.params.threadId),
    [keyed],
  );
  w.family.close();
});

test('a key chat runs on its own app-server while an organization lease runs the main one, and the lease’s token reaches only the lease’s process', async () => {
  const w = world({ key: 'sk-test', org: ORG, recorded: { keyed: 'key', leased: 'org', own: 'own' } });
  await w.begin('leased');
  await w.begin('keyed');
  await w.begin('own');
  assert.deepEqual([0, 1, 2].map(w.kindOf), ['org', 'ephemeral', 'own']);
  assert.equal(w.fake.calls[0].opts.env[CODEX_TOKEN_ENV], 'org-token');
  assert.equal(w.fake.calls[1].opts.env[CODEX_TOKEN_ENV], undefined);
  assert.equal(w.fake.calls[2].opts.env[CODEX_TOKEN_ENV], undefined);
  // the lease's gateway is the main one's provider; the key's process is told the key after initialize, never on its command line
  assert.ok(w.fake.calls[0].args.some((a: string) => a.includes('https://gw.example/v1')));
  assert.equal(w.fake.calls[1].args.join(' ').includes('sk-test'), false);
  assert.deepEqual(w.fake.sent('account/login/start', 1)[0].params, { type: 'apiKey', apiKey: 'sk-test' });
  assert.deepEqual(w.fake.sent('account/login/start', 0), []);
  assert.deepEqual(w.fake.sent('account/login/start', 2), []);
  w.family.close();
});

test('a lease that arrives after the main app-server started runs in an app-server of its own, and a lane whose credential is gone starts with an empty store', async () => {
  const w = world({ key: 'sk-test', recorded: { keyed: 'key', leased: 'org', gone: 'key' } });
  await w.begin('keyed');
  w.lent.org = ORG;
  // the running one was started for the key and is not restarted under a chat: the lease's chat gets a process for the lease
  await w.begin('leased');
  assert.deepEqual([w.kindOf(0), w.kindOf(1)], ['ephemeral', 'org']);
  assert.equal(w.fake.calls[1].opts.env[CODEX_TOKEN_ENV], 'org-token');
  assert.ok(w.fake.calls[1].args.some((a: string) => a.includes('https://gw.example/v1')));
  w.family.close();
  // the key was taken back before a chat recorded on it reached its process: it runs with nothing, never on the machine's own login
  const n = world({ recorded: { own: 'own', gone: 'key' } });
  await n.begin('own');
  await n.begin('gone');
  assert.equal(n.kindOf(1), 'ephemeral');
  assert.deepEqual(n.fake.sent('account/login/start', 1), []);
  n.family.close();
});

test('an idle lane is let go, but never one with a turn running or a request on its way', async () => {
  const w = world({ key: 'sk-test', recorded: { own: 'own', keyed: 'key', other: 'own' } });
  await w.begin('keyed');
  const own = await w.begin('own');
  const far = Date.now() + LANE_IDLE_MS + 1_000;
  assert.equal(w.family.reapLanes(Date.now()), 0, 'just used');
  // a turn running keeps it, however quiet
  w.fake.procs[1].say({ method: 'turn/started', params: { threadId: own, turn: { id: 't1' } } });
  await settle();
  assert.equal(w.family.reapLanes(far), 0);
  w.fake.procs[1].say({ method: 'turn/completed', params: { threadId: own, turn: { id: 't1', status: 'completed' } } });
  await settle();
  // so does a request nobody has answered
  void w.family.codex.request('slow/call', { threadId: own }).catch(() => undefined);
  await settle();
  assert.equal(w.family.reapLanes(far), 0);
  w.fake.procs[1].say({ id: w.fake.procs[1].lines.at(-1).id, result: {} });
  await settle();
  assert.equal(w.family.reapLanes(far), 1);
  assert.equal(w.fake.procs[1].kills, 1);
  assert.equal(w.fake.procs[0].kills, 0, 'the main one is not a lane');
  w.family.close();
});

test('with nothing lent every chat runs on the main one, and a chat with no record does too', async () => {
  const w = world({ recorded: { own: 'own' } });
  await w.begin('own');
  await w.begin('unrecorded');
  assert.equal(w.fake.procs.length, 1);
  assert.deepEqual(w.requestsOf(w.fake.procs[0]), ['initialize', 'initialized', 'thread/start', 'thread/start']);
  w.family.close();
});

test('a lane that exits ends only its own turns; the other chats go on, and the next request starts it again', async () => {
  const w = world({ key: 'sk-test', recorded: { own: 'own', keyed: 'key' } });
  const keyed = await w.begin('keyed');
  const own = await w.begin('own');
  const seen: any[] = [];
  w.family.codex.server.listeners.add((e: any) => e.kind === 'message' && seen.push(e.msg));
  const turn = w.family.codex.request('turn/start', { threadId: own, input: [] });
  await turn;
  w.fake.procs[1].say({ method: 'turn/started', params: { threadId: own, turn: { id: `turn-of-${own}` } } });
  await settle();
  // the lane's process quits mid-turn
  w.fake.procs[1].emit('exit', 1, null);
  await settle();
  const completed = seen.filter((m) => m.method === 'turn/completed');
  assert.deepEqual(
    completed.map((m) => [m.params.threadId, m.params.turn.status]),
    [[own, 'failed']],
  );
  assert.equal(seen.filter((m) => m.method === 'thread/closed').length, 1);
  assert.equal(w.fake.procs[0].kills, 0, 'the main one is untouched');
  await w.family.codex.request('turn/start', { threadId: keyed, input: [] });
  assert.equal(w.fake.sent('turn/start', 0).length, 1);
  // a request for the lane's thread starts a new process
  await w.family.codex.request('turn/start', { threadId: own, input: [] });
  assert.equal(w.fake.procs.length, 3);
  assert.equal(w.kindOf(2), 'own');
  w.family.close();
});

test('the lane’s server requests carry an id of its own and the answer goes back to it; the main one’s ids are untouched', async () => {
  const w = world({ key: 'sk-test', recorded: { own: 'own', keyed: 'key' } });
  await w.begin('keyed');
  const own = await w.begin('own');
  const seen: any[] = [];
  w.family.codex.server.listeners.add((e: any) => e.kind === 'message' && seen.push(e.msg));
  w.fake.procs[1].say({ id: 0, method: 'item/commandExecution/requestApproval', params: { threadId: own, turnId: 't' } });
  w.fake.procs[0].say({ id: 0, method: 'item/commandExecution/requestApproval', params: { threadId: 'th-other', turnId: 't' } });
  await settle();
  const requests = seen.filter((m) => m.method === 'item/commandExecution/requestApproval');
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].id, requests[1].id, 'two processes numbering from 0, as the real app-server does, never share a card');
  const laneId = requests.find((m) => m.params.threadId === own).id;
  assert.match(String(laneId), /^lane-own:/);
  w.family.codex.server.send({ id: laneId, result: { decision: 'accept' } });
  assert.deepEqual(w.fake.procs[1].lines.at(-1), { id: 0, result: { decision: 'accept' } });
  w.family.codex.server.send({ id: 0, result: { decision: 'decline' } });
  assert.deepEqual(w.fake.procs[0].lines.at(-1), { id: 0, result: { decision: 'decline' } });
  w.family.close();
});

test('the main one signing out does not sign a lane out: each credential is its own', async () => {
  const w = world({ key: 'sk-test', recorded: { own: 'own', keyed: 'key' } });
  await w.begin('keyed');
  await w.begin('own');
  await w.family.codex.request('account/logout', {}).catch(() => undefined);
  await settle();
  assert.deepEqual(w.fake.sent('account/logout', 1), []);
  w.family.close();
});

test('every process is known to the tool channel, and a thread’s tool session names the process holding it', async () => {
  const w = world({ key: 'sk-test', recorded: { own: 'own', keyed: 'key' } });
  const keyed = await w.begin('keyed');
  const own = await w.begin('own');
  const server = w.family.codex.server;
  assert.deepEqual(server.pids(), [w.fake.procs[0].pid, w.fake.procs[1].pid]);
  assert.equal(server.pidFor({ threadId: own }), w.fake.procs[1].pid);
  assert.equal(server.pidFor({ threadId: keyed }), w.fake.procs[0].pid);
  assert.equal(server.pidFor({ threadId: 'unknown' }), w.fake.procs[0].pid);
  assert.equal(server.isolated.running(), true);
  assert.equal(server.isolated.busy(), false);
  server.isolated.recycle();
  assert.equal(server.isolated.running(), false);
  w.family.close();
});

test('a chat on the machine’s own login is checked against Codex’s sign-in even while a key is lent; a chat on the key is not', async () => {
  const w = world({ key: 'sk-test', recorded: { own: 'own', keyed: 'key' }, probe: async () => false });
  await w.family.check('keyed');
  await w.family.check();
  await assert.rejects(w.family.check('own'), (e: any) => e.code === 'harness_not_configured' && e.message === NOT_SIGNED_IN);
  w.family.close();
});

test('a family built with a stand-in app-server runs every chat on it', async () => {
  const sent: any[] = [];
  const family = createCodexFamily({
    env: {},
    which: () => '/bin/codex',
    server: { send: (m: any) => sent.push(m), stop: () => undefined, listeners: new Set(), on: () => undefined },
    credentials: { sourceOf: () => 'own' },
  } as any)({
    paths: { dataDir: '/d' },
    state: { has: () => false, get: () => ({}), all: () => [] },
    chats: { records: new Map(), get: () => null, patchMeta: () => undefined, commit: () => true },
    controller: () => ({ chatOf: (i: string) => i, requestChat: (i: string) => i, isCurrentSource: () => false, ref: () => ({}) }),
    emit: () => undefined,
  } as any);
  assert.equal(typeof family.check, 'function');
  // with no credential bookkeeping there are no lanes to let go
  assert.equal(family.reapLanes(), 0);
});

test('a lane for an organization lease that is gone starts with an empty store, and a chat whose process is not running can change credential', async () => {
  const w = world({ recorded: { own: 'own', leased: 'org' } });
  await w.begin('own');
  await w.begin('leased');
  assert.equal(w.kindOf(1), 'ephemeral', 'no lease is lent: nothing of the machine’s login, nothing of a lease');
  w.family.close();
  // the main app-server has not started: a chat last sent to it is not held to it
  const k = world({ key: 'sk-test', recorded: { c: 'key' } });
  await k.family.check('c');
  k.kept.set('c', 'own');
  await k.family.check('c');
  k.family.close();
});

test('an app-server with no lanes lists only its own process', () => {
  const server = new AppServer({ spawn: fakeCodexSpawn('main', {}).spawn, findBin: () => '/bin/codex', env: () => ({}), args: () => [] });
  assert.deepEqual(server.pids(), []);
});

test('the credentials a chat is kept on: Codex follows the default order, a legacy chat keeps what it has been using, and a gone credential is refused', () => {
  const lent = { key: true, org: false };
  const leases: any = { has: () => lent.key || lent.org, hasKey: () => lent.key, hasOrg: () => lent.org };
  const c = createChatCredentials({ leases });
  // signed in, key lent: new Codex chats begin on the machine's own login, as Claude Code's do
  assert.equal(c.stateOf('codex', true).using, 'own');
  c.admit({ chatId: 'th-new', harness: 'codex' });
  assert.equal(c.sourceOf('th-new'), 'own');
  assert.equal(c.choiceOf('th-new'), null, 'where a chat began is not a choice');
  // a chat that began before chats were kept: what the lent key put it on
  c.check('th-old', 'codex');
  assert.equal(c.sourceOf('th-old'), 'key');
  // Codex has a process per credential: a person can pick the machine's login, or the key under a lease
  assert.doesNotThrow(() => c.admit({ chatId: 'th-pick', harness: 'codex', credential: { source: 'own' } }));
  lent.org = true;
  assert.doesNotThrow(() => c.admit({ chatId: 'th-key', harness: 'codex', credential: { source: 'key' } }));
  // a chat that began on a key that is gone is refused rather than run on another credential
  lent.key = false;
  lent.org = false;
  assert.throws(
    () => c.check('th-old', 'codex'),
    (e: any) => e.code === 'credential_unavailable',
  );
  // the other shared agents still use what is lent
  assert.equal(c.stateOf('gemini', true).using, 'own');
});

test('a chat whose credential changes while its thread is open on the old one is refused, in both directions, and a thread whose process is gone moves', async () => {
  const w = world({ key: 'sk-test', recorded: { c1: 'own', c2: 'key' } });
  // c1 on the machine's login (its own lane), c2 on the key (the main app-server)
  const t1 = await w.begin('c1');
  const t2 = await w.begin('c2');
  await w.family.check('c1');
  await w.family.check('c2');
  // own -> key: the thread is loaded in the own lane, so the turn is not sent to a process that does not hold it
  w.kept.set('c1', 'key');
  await assert.rejects(
    w.family.check('c1'),
    (e: any) => e.code === 'credential_unavailable' && /another sign-in/.test(e.message) && e.details?.cause === 'other_signin',
  );
  // key -> own: the reverse, the main app-server holds it
  w.kept.set('c2', 'own');
  await assert.rejects(
    w.family.check('c2'),
    (e: any) => e.code === 'credential_unavailable' && /machine's own login/.test(e.message) && e.details?.cause === 'other_signin',
  );
  // the turn that was sent after the refusal went where the thread lives, nowhere else
  assert.deepEqual(w.fake.sent('turn/start', 0), []);
  w.kept.set('c1', 'own');
  await w.family.check('c1');
  // once the process holding the thread is gone (its lane idled out), the thread loads again where the chat is now recorded
  await w.family.codex.request('turn/start', { threadId: t1, input: [] });
  w.family.reapLanes(Date.now() + LANE_IDLE_MS + 1);
  w.kept.set('c1', 'key');
  await w.family.check('c1');
  assert.equal(t2.startsWith('th-'), true);
  w.family.close();
});

test('a chat that ends no longer keeps its thread in a lane, and the lane idles by the clock the reaper reads', async () => {
  const w = world({ key: 'sk-test', recorded: { c1: 'own' } });
  const t1 = await w.begin('c1');
  const lane: any = (w.family.codex as any).server?.isolated?.lanes.get('own');
  assert.equal(lane.threads.has(t1), true);
  await w.family.codex.request('thread/archive', { threadId: t1 });
  await settle();
  assert.equal(lane.threads.has(t1), false, 'archived: the lane holds no thread of it');
  // one clock: a lane that was last active at the family's `now` is idle LANE_IDLE_MS later by that same clock
  const at = lane.activeAt;
  assert.equal(w.family.reapLanes(at + LANE_IDLE_MS - 1), 0);
  assert.equal(w.family.reapLanes(at + LANE_IDLE_MS), 1);
  w.family.close();
});
