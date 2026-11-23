// A Codex thread before its first user message (#2276): Codex keeps nothing of it on disk, so it lists no turns ("not
// materialized yet"), takes no memory mode ("no rollout found") and is gone once unloaded ("thread not loaded"). The
// real adapter over a fake app-server that keeps threads that way: an isolated (MoMo) chat shows an empty history, is
// never let go of before its first message, runs its first turn and has its memory turned off once Codex has the thread.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, settle, recentIgnored, clearIgnored, SHELL_OFF_CONFIG } from './support/codex-harness/fixture.ts';
import { codexThreads, MEMORY_OFF } from './support/codex-harness/threadLifecycle.ts';

const require = createRequire(import.meta.url);
const { ISOLATED_THREAD, STRICTEST, CodexIsolation } = require('../electron/harness/codexIsolation.cjs');
const { turnsOrEmpty, unrecordedError } = require('../electron/harness/codexUnrecorded.cjs');

const ref = (id: string) => ({ kind: 'codex', id });

/** A main-started (no window) thread, as MoMo's ChatStarter makes it: isolated, or not. */
async function started(a: any, isolated = true) {
  const r = await a.startThread({ ...(isolated ? { [ISOLATED_THREAD]: true } : {}), cwd: '/momo', ephemeral: false });
  return r.thread.id as string;
}

test('#2276 repro: an isolated Codex chat shows no error before its first message, is kept loaded, and runs its first turn', async () => {
  const codex = codexThreads();
  const { a, server, clock, of } = setup(codex.handlers, { isolated: () => true });
  a.isolation.wait = async () => undefined;
  const id = await started(a);
  // the Chat tab's history read: an empty chat, not "not materialized yet"
  assert.deepEqual(await a.threadTurns(id, { limit: 20 }), { data: [], nextCursor: null, backwardsCursor: null });
  // the user takes a while to type: the idle sweep keeps the thread, since unloading it would lose it
  clock.t += 60_000;
  a.releaseIdle();
  await settle();
  assert.equal(server.methods().includes('thread/unsubscribe'), false);
  assert.equal(a.leases.has(id), true);

  const r = await a.startTurn(id, ref(id), { text: 'remember that I prefer green tea and my sister is Ana' });
  await settle();
  assert.equal(r.started, true);
  assert.equal(of('turnFailed').length, 0);
  // still in the strictest sandbox, and its memory off as soon as Codex has the thread
  assert.deepEqual(
    server.params('turn/start').map((p: any) => [p.sandboxPolicy, p.approvalPolicy]),
    [[STRICTEST.sandboxPolicy, STRICTEST.approvalPolicy]],
  );
  assert.deepEqual(
    server.methods().filter((m: string) => m === MEMORY_OFF || m === 'turn/start'),
    [MEMORY_OFF, 'turn/start', MEMORY_OFF],
  );
  assert.equal(codex.threads.get(id)?.memory, 'disabled');
  // an isolated chat gets no title helper thread, so its first message goes to no second thread
  assert.equal(server.params('thread/start').length, 1, 'no title helper thread for an isolated chat');
  assert.equal(a.unrecorded.has(id), false);
  assert.deepEqual(await a.threadTurns(id), { data: [], nextCursor: null, backwardsCursor: null });

  // from the second turn on, memory goes off first as before, and a refusal stops the turn
  await a.startTurn(id, ref(id), { text: 'and my brother is Ben' });
  await settle();
  assert.deepEqual(
    server.methods().filter((m: string) => m === MEMORY_OFF || m === 'turn/start'),
    [MEMORY_OFF, 'turn/start', MEMORY_OFF, MEMORY_OFF, 'turn/start'],
  );
});

test('#2276: an ordinary main-started Codex chat (a linked session) is kept loaded and lists no turns until its first message', async () => {
  const codex = codexThreads();
  const { a, server, clock } = setup(codex.handlers);
  const id = await started(a, false);
  assert.deepEqual((await a.threadTurns(id)).data, []);
  clock.t += 60_000;
  a.releaseIdle();
  await settle();
  assert.equal(a.leases.has(id), true);
  assert.equal((await a.startTurn(id, ref(id), { text: 'go' })).started, true);
  assert.equal(server.methods().includes(MEMORY_OFF), false);
  // recorded now: an idle thread is let go of as any other, and Codex keeps it
  clock.t += 60_000;
  a.releaseIdle();
  await settle(20);
  assert.equal(server.methods().includes('thread/unsubscribe'), true);
  assert.equal(codex.threads.has(id), true);
});

test('#2276: a first turn’s memory goes off on a later try while Codex writes the thread out; when every try fails the next run asks again', async () => {
  let failFirst = 2;
  const codex = codexThreads({
    memory: () => {
      if (failFirst-- > 0) throw new Error('no rollout found for thread id (still writing)');
    },
  });
  const { a, server } = setup(codex.handlers, { isolated: () => true });
  const waits: number[] = [];
  a.isolation.wait = async (ms: number) => void waits.push(ms);
  const id = await started(a);
  await a.startTurn(id, ref(id), { text: 'hi' });
  await settle(20);
  // the gate's try, then the first try after the answer failed; the second went through
  assert.deepEqual(waits, [0, 1_000]);
  assert.equal(codex.threads.get(id)?.memory, 'disabled');

  // every try fails: noted, and the thread's next turn refuses to run without it
  clearIgnored();
  const never = codexThreads();
  // Codex's answer for a thread it hasn't recorded, then another failure once it has
  never.handlers[MEMORY_OFF] = (p: any) => {
    throw new Error(never.threads.get(p.threadId)?.recorded ? 'memory store is down' : `no rollout found for thread id ${p.threadId}`);
  };
  const b = setup(never.handlers, { isolated: () => true });
  b.a.isolation.wait = async () => undefined;
  const other = await started(b.a);
  assert.equal((await b.a.startTurn(other, ref(other), { text: 'hi' })).started, true);
  await settle(20);
  assert.equal(b.server.params(MEMORY_OFF).length, 4);
  assert.ok(recentIgnored().some((x: any) => /turn off Codex memory after a MoMo chat's first turn/.test(x.context)));
  const r = await b.a.startTurn(other, ref(other), { text: 'again' });
  assert.equal(r.started, false);
  assert.match(r.error, /Couldn't turn off Codex memory for this chat, so it doesn't run: memory store is down/);
  assert.equal(b.server.params('turn/start').length, 1);
  assert.equal(server.params('turn/start').length, 1);
});

test('#2276: only a first turn goes before memory is off, and only on Codex’s own "not recorded" answer', async () => {
  const codex = codexThreads();
  const { a, server } = setup(
    { ...codex.handlers, 'thread/goal/set': () => ({ goal: { objective: 'g', status: 'active' } }) },
    { isolated: () => true },
  );
  const id = await started(a);
  // a goal on a thread with no message yet: refused, memory can't be turned off
  const g = await a.startGoal(id, ref(id), { text: '/goal g', opts: { goal: 'g' } });
  assert.equal(g.started, false);
  assert.equal(server.methods().includes('thread/goal/set'), false);
  // any other failure of the memory switch stops even the first turn
  codex.handlers[MEMORY_OFF] = () => {
    throw new Error('unknown method');
  };
  const { a: b, server: s2 } = setup(codex.handlers, { isolated: () => true });
  const other = await started(b);
  const r = await b.startTurn(other, ref(other), { text: 'hi' });
  assert.equal(r.started, false);
  assert.match(r.error, /unknown method/);
  assert.equal(s2.methods().includes('turn/start'), false);
});

test('#2276: a goal’s turn records its thread too, and an app-server exit forgets every unrecorded thread', async () => {
  const codex = codexThreads();
  const { a, server } = setup(codex.handlers);
  const one = await started(a, false);
  const two = await started(a, false);
  server.notify('turn/started', { threadId: one, turn: { id: 'g1' } });
  await settle();
  assert.deepEqual([...a.unrecorded], [two]);
  server.emit({ kind: 'exit', code: 1 });
  await settle();
  assert.equal(a.unrecorded.size, 0);
});

test('codexUnrecorded: an empty page only for "not materialized"; a lost thread’s missing rollout stays an error', async () => {
  assert.deepEqual(await turnsOrEmpty(Promise.reject(new Error('thread x is not materialized yet; …'))), {
    data: [],
    nextCursor: null,
    backwardsCursor: null,
  });
  // an ephemeral thread (a side chat) has no turns to list: the same empty page, so a phone that follows one sees an empty chat
  assert.deepEqual(await turnsOrEmpty(Promise.reject(new Error('ephemeral threads do not support thread/turns/list'))), {
    data: [],
    nextCursor: null,
    backwardsCursor: null,
  });
  await assert.rejects(turnsOrEmpty(Promise.reject(new Error('no rollout found for thread id x'))), /no rollout found/);
  await assert.rejects(turnsOrEmpty(Promise.reject('down')), /down/);
  assert.equal(unrecordedError(new Error('no rollout found for thread id x')), true);
  assert.equal(unrecordedError('thread x is not materialized yet'), true);
  assert.equal(unrecordedError(new Error('thread not loaded: x')), false);
});

test('CodexIsolation alone: the first-turn exception needs the adapter to say the thread is unrecorded; its default wait is a timer', async () => {
  const calls: string[] = [];
  let recorded = false;
  const iso = new CodexIsolation({
    isolated: () => true,
    chatOf: (t: string) => t,
    unrecorded: () => !recorded,
    call: async (method: string) => {
      // the shell check before each run (CodexIsolation.shellOff) is no memory call
      if (method === 'config/read') return SHELL_OFF_CONFIG;
      calls.push(method);
      if (!recorded) throw new Error('no rollout found for thread id t');
      return {};
    },
  });
  const params = await iso.gate('turn/start', { threadId: 't' });
  assert.equal(params.approvalPolicy, 'never');
  recorded = true;
  await iso.turnStarted('t');
  // owed once: a second answer turns nothing off again
  await iso.turnStarted('t');
  assert.deepEqual(calls, [MEMORY_OFF, MEMORY_OFF]);
});

test('#2276: a steer into the first turn joins it while Codex writes the thread out; a run that turns memory off ends the retries', async () => {
  let writing = true;
  const calls: string[] = [];
  let release: () => void = () => undefined;
  const iso = new CodexIsolation({
    isolated: () => true,
    chatOf: (t: string) => t,
    unrecorded: () => true,
    wait: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    call: async (method: string) => {
      if (method === 'config/read') return SHELL_OFF_CONFIG;
      calls.push(method);
      if (writing) throw new Error('no rollout found for thread id t');
      return {};
    },
  });
  // a steer on a thread whose first turn didn't go first: refused
  await assert.rejects(iso.gate('turn/steer', { threadId: 't' }), /so it doesn't run: no rollout found/);
  await iso.gate('turn/start', { threadId: 't' });
  // the first turn runs; a steer into it while the thread is written out goes along
  assert.deepEqual(await iso.gate('turn/steer', { threadId: 't', input: [] }), { threadId: 't', input: [] });
  const retries = iso.turnStarted('t');
  // Codex has the thread: the next run's gate turns memory off, and the pending retry sends nothing more
  writing = false;
  await iso.gate('turn/steer', { threadId: 't' });
  release();
  await retries;
  assert.deepEqual(calls, [MEMORY_OFF, MEMORY_OFF, MEMORY_OFF, MEMORY_OFF]);
  // nothing owed now: a later failure refuses a steer as before
  writing = true;
  await assert.rejects(iso.gate('turn/steer', { threadId: 't' }), /so it doesn't run/);
});

test('#2276: a thread Codex unloads before its first message is forgotten with it', async () => {
  const { a, server } = setup(codexThreads().handlers);
  const id = await started(a, false);
  server.notify('thread/closed', { threadId: id });
  await settle();
  assert.equal(a.unrecorded.has(id), false);
  assert.equal(a.leases.has(id), false);
});
