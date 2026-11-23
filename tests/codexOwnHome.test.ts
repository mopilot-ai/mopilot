// #2326: every Codex path resolves a thread's home from the chat (MoMo's own CODEX_HOME for a MoMo chat's thread, the
// user's for any other), never assuming ~/.codex: rollout reads, the idle recycler, and a resume of a thread made before
// MoMo had a home. A MoMo thread is never read from, or resumed on, the user's side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeCodexSpawn } from './support/codex-harness/fakeCodexProcess.ts';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { createCodexRollouts, codexRollouts, setThreadHomes, homeOfThread } = require('../electron/harness/codexRollout.cjs');
const { adoptRollout } = require('../electron/harness/codexMomoHome.cjs');
const { AppServer } = require('../electron/harness/codex.cjs');
const { IsolatedServer } = require('../electron/harness/codexIsolatedServer.cjs');
const { codexRecycler, IDLE_MS } = require('../electron/harness/codexRecycle.cjs');
const { ISOLATED_THREAD } = require('../electron/harness/codexIsolation.cjs');

const at = new Date(2026, 9, 21, 12, 0, 0);
const idAt = (tail: string) => {
  const hex = at.getTime().toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${tail}`;
};
const MOMO_ID = idAt('7000-8000-0000000000a1');
const USER_ID = idAt('7000-8000-0000000000b2');
const pad = (n: number) => String(n).padStart(2, '0');
const rel = (id: string) =>
  path.join('sessions', String(at.getFullYear()), pad(at.getMonth() + 1), pad(at.getDate()), `rollout-2026-10-21T12-00-00-${id}.jsonl`);
const rollout = (id: string, cwd: string) =>
  `${[
    { type: 'session_meta', payload: { id, cwd } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 't0', started_at: 0 } },
    {
      type: 'event_msg',
      payload: { type: 'item_completed', turn_id: 't0', item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text: 'hi' }] } },
    },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't0', completed_at: 1, duration_ms: 1 } },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n')}\n`;
const put = (home: string, id: string, cwd: string) => {
  const f = path.join(home, rel(id));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, rollout(id, cwd));
  return f;
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'own-home-'));

test('#2326 rollout reads: a thread is read from its own home only, a MoMo thread never from the user’s and the reverse', async () => {
  const user = tmp();
  const momo = tmp();
  const mine = put(momo, MOMO_ID, '/momo');
  put(user, USER_ID, '/work');
  const stray = put(user, MOMO_ID, '/user-copy');
  const reader = createCodexRollouts({ codexHome: (id: string) => (id === MOMO_ID ? momo : user) });
  assert.equal((await reader.history(MOMO_ID)).path, mine);
  assert.equal((await reader.history(USER_ID)).cwd, '/work');
  assert.equal((await reader.history(MOMO_ID)).cwd, '/momo');
  // a hint naming the user's file for a MoMo thread is refused (fail closed), and the thread's own home answers
  assert.equal((await reader.history(MOMO_ID, { hint: stray })).path, mine);
  // a thread with a rollout only in the other home reads as missing
  const lone = createCodexRollouts({ codexHome: () => momo });
  assert.equal(await lone.history(USER_ID), null);
});

test('#2326 the shared reader asks which home holds the thread: MoMo’s chats resolve to MoMo’s, others to the user’s', async () => {
  const momo = tmp();
  put(momo, MOMO_ID, '/momo');
  try {
    setThreadHomes((id: string) => (id === MOMO_ID ? momo : null));
    assert.equal(homeOfThread(MOMO_ID), momo);
    assert.notEqual(homeOfThread(USER_ID), momo);
    assert.notEqual(homeOfThread(''), momo);
    assert.equal((await codexRollouts().history(MOMO_ID)).cwd, '/momo');
  } finally {
    setThreadHomes(null);
  }
  assert.notEqual(homeOfThread(MOMO_ID), momo);
});

test('#2326 a MoMo chat’s thread made before MoMo had a home is copied into it, once, and never overwritten', async () => {
  const user = tmp();
  const momo = tmp();
  const src = put(user, MOMO_ID, '/old');
  assert.equal(await adoptRollout({ threadId: MOMO_ID, home: momo, userHome: user }), true);
  const copy = path.join(momo, rel(MOMO_ID));
  assert.equal(fs.readFileSync(copy, 'utf8'), fs.readFileSync(src, 'utf8'));
  // already there: nothing is copied again
  fs.writeFileSync(copy, rollout(MOMO_ID, '/newer'));
  assert.equal(await adoptRollout({ threadId: MOMO_ID, home: momo, userHome: user }), false);
  assert.match(fs.readFileSync(copy, 'utf8'), /newer/);
  // a thread in neither home copies nothing, and is not searched for again
  const gone = idAt('7000-8000-0000000000c3');
  assert.equal(await adoptRollout({ threadId: gone, home: momo, userHome: user }), false);
  put(user, gone, '/late');
  assert.equal(await adoptRollout({ threadId: gone, home: momo, userHome: user }), false);
  // a copy that fails is reported, not thrown
  const other = idAt('7000-8000-0000000000d4');
  put(user, other, '/x');
  const broken = {
    ...fs,
    copyFileSync: () => {
      throw new Error('disk full');
    },
  };
  assert.equal(await adoptRollout({ threadId: other, home: momo, userHome: user, fileFs: broken as any }), false);
});

test('#2326 a forked thread brings the rollout it was forked from (Codex refuses a fork without its source), a loop ends, and a name that is no thread id is never looked for', async () => {
  const user = tmp();
  const momo = tmp();
  const source = idAt('7000-8000-0000000000e5');
  const fork = idAt('7000-8000-0000000000f6');
  put(user, source, '/src');
  const forkFile = put(user, fork, '/fork');
  const forkedFrom = (file: string, from: string) =>
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"payload":{', `"payload":{"forked_from_id":"${from}",`));
  forkedFrom(forkFile, source);
  assert.equal(await adoptRollout({ threadId: fork, home: momo, userHome: user }), true);
  assert.ok(fs.existsSync(path.join(momo, rel(source))));
  // a rollout that names itself as its source ends at the depth limit; one whose first line is no JSON has no source
  const loop = idAt('7000-8000-000000000107');
  forkedFrom(put(user, loop, '/loop'), loop);
  assert.equal(await adoptRollout({ threadId: loop, home: momo, userHome: user }), true);
  const odd = idAt('7000-8000-000000000118');
  fs.writeFileSync(put(user, odd, '/odd'), 'not json\n');
  assert.equal(await adoptRollout({ threadId: odd, home: momo, userHome: user }), true);
  // only a thread id is looked for
  assert.equal(await adoptRollout({ threadId: '../../etc/passwd', home: momo, userHome: user }), false);
});

test('#2326 only a MoMo chat’s thread is ever brought in: a resume of any other thread on MoMo’s server copies nothing', async () => {
  const asked: string[] = [];
  const r = rig(async (id: string) => asked.push(id));
  r.iso.owns = (t: string) => t === 'old';
  r.server.send({ id: 1, method: 'initialize', params: {} });
  // a thread MoMo's server holds but that no MoMo chat owns (marked start): its resume is not adopted
  r.server.send({ id: 2, method: 'thread/resume', params: { threadId: 'theirs', [ISOLATED_THREAD]: true } });
  r.server.send({ id: 3, method: 'thread/resume', params: { threadId: 'old' } });
  await settle();
  assert.deepEqual(asked, ['old']);
  r.server.stop();
});

const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await tick();
};
const methods = (p: any) => p.sent().map((m: any) => m.method);

function rig(adopt?: (id: string) => Promise<unknown>) {
  const main = fakeCodexSpawn('main', { initialize: () => ({ userAgent: 'codex_cli_rs/0.162.1' }) });
  const momo = fakeCodexSpawn('momo', {
    initialize: () => ({ userAgent: 'codex_cli_rs/0.162.1' }),
    'thread/resume': () => ({ thread: { id: 'old' } }),
  });
  const server = new AppServer({ spawn: main.spawn, findBin: () => '/bin/codex', env: () => ({}) });
  const iso = new IsolatedServer({
    main: server,
    server: new AppServer({ spawn: momo.spawn, findBin: () => '/bin/codex', env: () => ({}) }),
    owns: (t: string) => t === 'old',
    prepare: () => {},
    login: async () => null,
    adopt,
  });
  return { server, iso, main, momo };
}

test('#2326 a resume on MoMo’s app-server waits for the thread to be brought in, and goes to MoMo’s server only', async () => {
  let release!: () => void;
  const r = rig(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  r.server.send({ id: 1, method: 'initialize', params: {} });
  r.server.send({ id: 2, method: 'thread/resume', params: { threadId: 'old' } });
  await settle();
  assert.equal(methods(r.momo).includes('thread/resume'), false);
  release();
  await settle();
  assert.equal(methods(r.momo).includes('thread/resume'), true);
  assert.equal(methods(r.main).includes('thread/resume'), false);
  r.server.stop();
});

test('#2326 an adoption that fails still sends the resume (Codex says why); one a process exit overtook sends nothing', async () => {
  const r = rig(async () => {
    throw new Error('no space');
  });
  r.server.send({ id: 1, method: 'initialize', params: {} });
  r.server.send({ id: 2, method: 'thread/resume', params: { threadId: 'old' } });
  await settle();
  assert.equal(methods(r.momo).includes('thread/resume'), true);
  r.server.stop();
  const late = rig(async () => {});
  late.server.send({ id: 1, method: 'initialize', params: {} });
  late.server.send({ id: 2, method: 'thread/resume', params: { threadId: 'old' } });
  late.iso.sent.clear();
  await settle();
  assert.equal(methods(late.momo).includes('thread/resume'), false);
  late.server.stop();
  // with no adopt wired, a resume goes straight there
  assert.equal(await rig().iso.adopt('x'), false);
});

function recyclerRig(o: { mine?: string[]; theirs?: string[]; running?: boolean; busy?: boolean } = {}) {
  const log: string[] = [];
  const calls: any[] = [];
  const iso: any = { running: () => o.running ?? true, busy: () => o.busy ?? false, recycle: () => log.push('recycle-momo') };
  const server: any = { proc: { pid: 1 }, stop: () => log.push('stop'), isolated: iso };
  const codex: any = {
    lastActivity: 0,
    down: false,
    restartTimer: null,
    recovering: null,
    running: new Set(),
    leases: new Map(),
    pending: new Map(),
    heldRequests: new Map(),
    prewarmed: new Set(),
    titling: new Map(),
    hidden: new Map(),
    realtime: new Set(),
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === 'thread/loaded/list') return { data: params[ISOLATED_THREAD] ? (o.theirs ?? []) : (o.mine ?? []) };
      return { data: [] };
    },
    connect: async () => log.push('connect'),
    onStatus: (e: any) => log.push(e.kind),
  };
  const r = codexRecycler({ server: () => server, codex: () => codex, now: () => 10 * IDLE_MS });
  return { r, log, calls };
}

test('#2326 the idle recycler lets go of MoMo’s own app-server alone when only it holds threads, leaving the user’s running', async () => {
  const { r, log, calls } = recyclerRig({ theirs: ['m1'] });
  assert.equal(await r.check(), true);
  assert.deepEqual(log, ['recycle-momo']);
  // MoMo's list is asked by its mark, and its thread's terminals are read too
  assert.deepEqual(
    calls.filter((c) => c.method === 'thread/loaded/list').map((c) => !!c.params[ISOLATED_THREAD]),
    [false, true],
  );
  assert.ok(calls.some((c) => c.method === 'thread/backgroundTerminals/list' && c.params.threadId === 'm1'));
});

test('#2326 when the user’s app-server holds threads too, the usual restart ends both; a MoMo app-server not running is not asked', async () => {
  const both = recyclerRig({ mine: ['u1'], theirs: ['m1'] });
  assert.equal(await both.r.check(), true);
  assert.deepEqual(both.log, ['stop', 'connect', 'ready']);
  const off = recyclerRig({ theirs: ['m1'], running: false });
  assert.equal(await off.r.check(), false);
  assert.deepEqual(
    off.calls.filter((c) => c.params[ISOLATED_THREAD]),
    [],
  );
  assert.deepEqual(off.log, []);
});

test('#2326 a request on its way to MoMo’s app-server, or a thread coming into its home, keeps it from being let go', async () => {
  const busy = recyclerRig({ theirs: ['m1'], busy: true });
  assert.equal(await busy.r.check(), false);
  assert.deepEqual(busy.log, []);
  const r = rig(async () => {});
  assert.equal(r.iso.busy(), false);
  r.server.send({ id: 1, method: 'initialize', params: {} });
  r.server.send({ id: 2, method: 'thread/resume', params: { threadId: 'old' } });
  assert.equal(r.iso.busy(), true);
  await settle();
  r.server.stop();
});

test('#2326 what is asked of a thread after its resume goes out after it, while the thread is being brought in', async () => {
  let release!: () => void;
  const r = rig(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  r.server.send({ id: 1, method: 'initialize', params: {} });
  r.server.send({ id: 2, method: 'thread/resume', params: { threadId: 'old' } });
  r.server.send({ id: 3, method: 'thread/read', params: { threadId: 'old' } });
  await settle();
  assert.equal(methods(r.momo).includes('thread/read'), false);
  release();
  await settle();
  const sent = methods(r.momo);
  assert.ok(sent.indexOf('thread/resume') >= 0 && sent.indexOf('thread/read') > sent.indexOf('thread/resume'));
  r.server.stop();
});

test('#2326 a copy is written under another name and renamed, a long first line still names the fork’s source, and a miss is retried after a while', async (t) => {
  const user = tmp();
  const momo = tmp();
  // a copy that fails leaves nothing a lookup would take for the thread
  const cut = idAt('7000-8000-000000000129');
  put(user, cut, '/x');
  const failing = {
    ...fs,
    renameSync: () => {
      throw new Error('cut short');
    },
  };
  assert.equal(await adoptRollout({ threadId: cut, home: momo, userHome: user, fileFs: failing as any }), false);
  assert.equal(fs.existsSync(path.join(momo, rel(cut))), false);
  // a first line far longer than a read's chunk
  const source = idAt('7000-8000-00000000013a');
  const fork = idAt('7000-8000-00000000014b');
  put(user, source, '/src');
  const file = put(user, fork, '/fork');
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, 'utf8')
      .replace('"payload":{', `"payload":{"forked_from_id":"${source}","base_instructions":"${'x'.repeat(300_000)}",`),
  );
  assert.equal(await adoptRollout({ threadId: fork, home: momo, userHome: user }), true);
  assert.ok(fs.existsSync(path.join(momo, rel(source))));
  // a thread in neither home is looked for again after a minute
  t.mock.timers.enable({ apis: ['Date'] });
  const late = idAt('7000-8000-00000000015c');
  assert.equal(await adoptRollout({ threadId: late, home: momo, userHome: user }), false);
  put(user, late, '/late');
  assert.equal(await adoptRollout({ threadId: late, home: momo, userHome: user }), false);
  t.mock.timers.tick(61_000);
  assert.equal(await adoptRollout({ threadId: late, home: momo, userHome: user }), true);
});

test('#2326 recycle: its threads close for the adapter, its process stops, and the next request starts it again', async () => {
  const r = rig(async () => {});
  r.server.send({ id: 1, method: 'initialize', params: {} });
  r.server.send({ id: 2, method: 'thread/resume', params: { threadId: 'old' } });
  await settle();
  assert.equal(r.iso.running(), true);
  const heard: any[] = [];
  r.server.listeners.add((e: any) => e.kind === 'message' && heard.push(e.msg));
  r.iso.recycle();
  assert.equal(r.iso.running(), false);
  assert.ok(heard.some((m) => m.method === 'thread/closed' && m.params.threadId === 'old'));
  r.server.send({ id: 3, method: 'thread/resume', params: { threadId: 'old' } });
  await settle();
  assert.equal(r.momo.procs.length, 2);
  r.server.stop();
});
