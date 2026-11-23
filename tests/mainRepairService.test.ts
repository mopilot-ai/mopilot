// Checks durable repair ownership and uncertain starts at actual asynchronous boundaries without launching an app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairWorld } from './support/main-repair.ts';
import { useFakeClock } from './support/ports/clock.ts';
import { claim, retire } from '../shared/mainRedClaims.mjs';
import { RESERVATION_MS, WORKER_LEASE_MS } from '../shared/mainRepairClaim.mjs';
const NOW = Date.parse('2026-11-05T00:00:00Z');
const deferred = () => {
  let resolve!: (v?: any) => void;
  const promise = new Promise<any>((r) => {
    resolve = r;
  });
  return { resolve, promise };
};

test('one persisted reservation precedes allocation, binding precedes the small brief, and merge waits for recovery', async (t) => {
  useFakeClock(t, NOW);
  const f = repairWorld();
  const one = f.service.tick();
  assert.equal(f.service.tick(), one);
  await one;
  assert.equal(f.job().phase, 'running');
  const ops = f.calls.map((c) => c[0]);
  assert.ok(ops.indexOf('reserve') < ops.indexOf('prepare'));
  assert.ok(ops.indexOf('bind') < ops.indexOf('deliver'));
  const brief = f.calls.find((c) => c[0] === 'deliver');
  assert.ok(Buffer.byteLength(brief[2]) <= 4096);
  assert.ok(brief[2].includes(`Reservation: ${f.job().id}`));
  assert.equal(f.held().worker.chatId, 'worker');
  f.state.liveCI = true;
  f.state.pr = 7;
  await f.service.tick();
  assert.equal(f.job().phase, 'waiting');
  f.state.merged = true;
  await f.service.tick();
  assert.equal(f.job().phase, 'verifying');
  const restarted = f.restart();
  await restarted.tick();
  assert.equal(f.calls.filter((c) => c[0] === 'deliver').length, 1);
  f.state.recovered = true;
  await restarted.tick();
  assert.equal(restarted.status('o/r').jobs[0].phase, 'complete');
  assert.equal(f.held().state, 'unclaimed');
  await restarted.tick();
  assert.equal(f.calls.filter((c) => c[0] === 'prepare').length, 1);
  assert.equal(restarted.status('unknown').policy, null);
});

test('another owner gets no repair worker and unreadable ownership never becomes unclaimed', async (t) => {
  useFakeClock(t, NOW);
  const f = repairWorld();
  claim({ gh: f.hub.gh, repo: 'o/r', issue: 5, claimant: 'other', now: NOW });
  await f.service.tick();
  assert.equal(f.job().phase, 'reserving');
  assert.equal(
    f.calls.some((c) => c[0] === 'prepare'),
    false,
  );
  const unknown = repairWorld({ remote: async () => ({ state: 'unknown' }) });
  await unknown.service.tick();
  assert.equal(unknown.job().phase, 'reserving');
  assert.match(unknown.job().error, /could not be read/);
});

test('ambiguous reservation and binding acknowledgements reconcile from durable identity before dispatch', async (t) => {
  useFakeClock(t, NOW);
  const f = repairWorld(),
    remote = f.options.remote;
  let first = true;
  f.options.remote = async (op: string, a: any) => {
    const result = await remote(op, a);
    if (op === 'reserve' && first) {
      first = false;
      return { ok: false, claim: { state: 'unknown' }, why: 'lost ack' };
    }
    if (op === 'bind' && first === false) {
      first = true;
      throw new Error('binding ack lost');
    }
    return result;
  };
  await f.service.tick();
  assert.equal(f.job().phase, 'reserving');
  await f.service.tick();
  assert.equal(f.job().phase, 'prepared');
  await f.service.tick();
  assert.equal(f.job().phase, 'running');
  assert.equal(f.calls.filter((c) => c[0] === 'prepare').length, 1);
  assert.equal(f.calls.filter((c) => c[0] === 'reserve').length, 1);
});

test('lost dispatch acknowledgements never replay the prompt and idle uncertain workers expire', async (t) => {
  const clock = useFakeClock(t, NOW);
  const f = repairWorld({
    deliver: async () => {
      throw new Error('send outcome unknown');
    },
  });
  f.state.activity = 'idle';
  await f.service.tick();
  assert.equal(f.job().phase, 'uncertain');
  await f.service.tick();
  assert.equal(f.job().phase, 'uncertain');
  f.options.observe = async () => [];
  clock.advance(WORKER_LEASE_MS);
  await f.service.tick();
  assert.equal(f.job().phase, 'lost');
  assert.equal(f.held().state, 'unclaimed');
  const denied = repairWorld({ deliver: async () => ({ accepted: false, error: 'native refusal' }) });
  await denied.service.tick();
  assert.equal(denied.job().phase, 'failed');
  assert.equal(denied.held().state, 'unclaimed');
});

test('failed preparation releases only its reservation and automatic attempts are bounded', async (t) => {
  useFakeClock(t, NOW);
  const f = repairWorld({
    prepare: async () => {
      throw new Error('setup failed');
    },
  });
  for (let i = 0; i < 5; i++) await f.service.tick();
  assert.equal(Object.keys(f.store.data.jobs).length, 3);
  assert.equal(f.job().phase, 'failed');
  assert.equal(f.held().state, 'unclaimed');
});

test('revocation during preparation stops only the prepared worker, preserves work and never dispatches', async (t) => {
  useFakeClock(t, NOW);
  const wait = deferred(),
    entered = deferred();
  const f = repairWorld({
    prepare: async () => {
      entered.resolve();
      await wait.promise;
      return { chatId: 'worker', cwd: '/repair', baseSha: 'b'.repeat(40) };
    },
  });
  const run = f.service.tick();
  await entered.promise;
  f.service.configure({ ...f.policy, enabled: false });
  wait.resolve();
  await run;
  assert.equal(f.job().phase, 'lost');
  assert.equal(f.held().state, 'unclaimed');
  assert.equal(f.calls.filter((c) => c[0] === 'stop').length, 1);
  assert.equal(
    f.calls.some((c) => c[0] === 'deliver'),
    false,
  );
  await f.service.tick();
  assert.equal(Object.keys(f.store.data.jobs).length, 1);
});

test('closing the app preserves the lease and prepared identity for a fresh process', async (t) => {
  useFakeClock(t, NOW);
  const wait = deferred(),
    entered = deferred();
  const f = repairWorld({
    prepare: async () => {
      entered.resolve();
      await wait.promise;
      return { chatId: 'worker', cwd: '/repair', baseSha: 'b'.repeat(40) };
    },
  });
  const run = f.service.tick();
  await entered.promise;
  f.service.dispose();
  wait.resolve();
  await run;
  assert.equal(f.held().state, 'claimed');
  assert.equal(f.job().phase, 'prepared');
  assert.equal(
    f.calls.some((c) => c[0] === 'stop'),
    false,
  );
  await f.service.tick();
  const next = f.restart();
  await next.tick();
  assert.equal(next.status('o/r').jobs[0].phase, 'running');
});

test('superseded incidents, stopped chats and ownership replacements have explicit exits', async (t) => {
  const clock = useFakeClock(t, NOW);
  const f = repairWorld();
  await f.service.tick();
  f.state.activity = 'user';
  await f.service.tick();
  f.state.activity = 'paused';
  await f.service.tick();
  f.state.activity = 'idle';
  f.state.superseded = true;
  f.options.observe = async () => [];
  await f.service.tick();
  assert.equal(f.job().phase, 'lost');
  const replaced = repairWorld();
  await replaced.service.tick();
  replaced.service.patch(replaced.job(), { phase: 'bound' });
  retire({ gh: replaced.hub.gh, repo: 'o/r', issue: 5, from: replaced.held().sha, reason: 'lease expired', now: NOW });
  claim({ gh: replaced.hub.gh, repo: 'o/r', issue: 5, claimant: 'new owner', now: NOW });
  replaced.options.observe = async () => [];
  clock.advance(1);
  await replaced.service.tick();
  assert.equal(replaced.job().phase, 'lost');
  assert.equal(replaced.held().claimant, 'new owner');
});

test('a reservation that expires before allocation never starts a worker', async (t) => {
  const clock = useFakeClock(t, NOW);
  const f = repairWorld(),
    remote = f.options.remote;
  f.options.remote = async (op: string, a: any) => {
    const r = await remote(op, a);
    if (op === 'reserve') clock.advance(RESERVATION_MS);
    return r;
  };
  await f.service.tick();
  assert.equal(f.job().phase, 'lost');
  assert.equal(
    f.calls.some((c) => c[0] === 'prepare'),
    false,
  );
});

test('ownership replaced while inspecting an active worker cancels only the old worker', async (t) => {
  useFakeClock(t, NOW);
  const f = repairWorld();
  await f.service.tick();
  f.options.observe = async () => [];
  f.options.inspect = async () => {
    retire({ gh: f.hub.gh, repo: 'o/r', issue: 5, from: f.held().sha, reason: 'replacement', now: NOW });
    claim({ gh: f.hub.gh, repo: 'o/r', issue: 5, claimant: 'replacement', now: NOW });
    return { claim: f.held() };
  };
  await f.service.tick();
  assert.equal(f.job().phase, 'lost');
  assert.equal(f.held().claimant, 'replacement');
});

test('a claim replaced during awaited repository readiness never receives the brief', async (t) => {
  useFakeClock(t, NOW);
  const f = repairWorld();
  f.options.assertScope = async () => {
    retire({ gh: f.hub.gh, repo: 'o/r', issue: 5, from: f.held().sha, reason: 'replacement', now: NOW });
    claim({ gh: f.hub.gh, repo: 'o/r', issue: 5, claimant: 'replacement', now: NOW });
  };
  await f.service.tick();
  assert.equal(
    f.calls.some((c) => c[0] === 'deliver'),
    false,
  );
  assert.equal(f.held().claimant, 'replacement');
});

test('authority revocation at every awaited transition fences later work and releases only that generation', async (t) => {
  useFakeClock(t, NOW);
  for (const stage of [
    'read:1',
    'reserve',
    'findPrepared',
    'prepare',
    'read:2',
    'bind',
    'inspect',
    'assertScope',
    'read:3',
    'deliver',
    'heartbeat',
    'observe',
  ]) {
    const f = repairWorld(),
      remote = f.options.remote;
    let reads = 0,
      changed = false;
    const revoke = () => {
      if (!changed) {
        changed = true;
        f.service.configure({ ...f.policy, enabled: false });
      }
    };
    f.options.remote = async (op: string, args: any) => {
      const r = await remote(op, args);
      if (stage === (op === 'read' ? `read:${++reads}` : op)) revoke();
      return r;
    };
    for (const port of ['findPrepared', 'prepare', 'inspect', 'assertScope', 'deliver', 'observe']) {
      const fn = f.options[port];
      f.options[port] = async (...args: any[]) => {
        const r = await fn(...args);
        if (stage === port) revoke();
        return r;
      };
    }
    await f.service.tick();
    await f.service.tick();
    assert.equal(f.store.data.policies['o/r'].enabled, false, stage);
    assert.equal(f.held().state, 'unclaimed', stage);
    assert.equal(f.calls.filter((c) => c[0] === 'deliver').length, stage === 'deliver' || stage === 'heartbeat' ? 1 : 0, stage);
  }
});

test('unknown bind/inspection outcomes reconcile without sending, and a replacement before binding survives', async (t) => {
  useFakeClock(t, NOW);
  const f = repairWorld(),
    remote = f.options.remote;
  let blocked = true;
  f.options.remote = async (op: string, args: any) =>
    op === 'bind' && blocked ? { ok: false, why: 'unknown binding', claim: { state: 'unknown' } } : remote(op, args);
  await f.service.tick();
  assert.equal(f.job().phase, 'prepared');
  assert.equal(
    f.calls.some((c) => c[0] === 'deliver'),
    false,
  );
  blocked = false;
  f.options.inspect = async () => ({ claim: { state: 'unknown' } });
  await f.service.tick();
  assert.equal(f.job().phase, 'bound');
  f.options.inspect = async () => ({ claim: f.held() });
  await f.service.tick();
  assert.equal(f.calls.filter((c) => c[0] === 'deliver').length, 1);
  const replaced = repairWorld();
  replaced.options.prepare = async () => {
    retire({ gh: replaced.hub.gh, repo: 'o/r', issue: 5, from: replaced.held().sha, reason: 'replacement', now: NOW });
    claim({ gh: replaced.hub.gh, repo: 'o/r', issue: 5, claimant: 'new', now: NOW });
    return { chatId: 'worker', cwd: '/repair', baseSha: 'a'.repeat(40) };
  };
  await replaced.service.tick();
  assert.equal(replaced.job().phase, 'lost');
  assert.equal(replaced.held().claimant, 'new');
});

test('prepared native identity is recovered once, uncertain sends stay uncertain, and observation errors recover', async (t) => {
  useFakeClock(t, NOW);
  const f = repairWorld({
    findPrepared: async () => ({ chatId: 'worker', cwd: '/repair', baseSha: 'a'.repeat(40) }),
    deliver: async () => ({ accepted: null }),
  });
  f.state.activity = 'idle';
  await f.service.tick();
  assert.equal(f.job().phase, 'uncertain');
  assert.equal(
    f.calls.some((c) => c[0] === 'prepare'),
    false,
  );
  f.options.observe = async () => {
    throw new Error('offline');
  };
  await f.service.tick();
  assert.match(f.service.status('o/r').error, /Offline/);
  f.options.observe = async () => [];
  await f.service.tick();
  assert.equal(f.service.status('o/r').error, null);
  const closing = repairWorld();
  closing.options.prepare = async () => {
    closing.service.dispose();
    throw new Error('application closed');
  };
  await closing.service.tick();
  assert.equal(closing.job().phase, 'preparing');
  assert.equal(closing.held().state, 'claimed');
});

test('unrelated or earlier completed failures never suppress a new incident in the same repository', async (t) => {
  useFakeClock(t, NOW);
  const f = repairWorld();
  const old = {
    ...f.incident,
    id: 'old',
    repo: 'o/r',
    generation: 'old',
    briefId: 'old',
    createdAt: NOW,
    updatedAt: NOW,
    phase: 'complete',
  };
  f.store.change((d: any) => {
    d.jobs.old = { ...old, failedSha: 'b'.repeat(40) };
    d.jobs.other = { ...old, id: 'other', issue: 6 };
    d.jobs.foreign = { ...old, id: 'foreign', repo: 'other/r' };
  });
  await f.service.tick();
  assert.equal(f.calls.filter((c) => c[0] === 'deliver').length, 1);
  const oldPolicy = f.store.data.policies['o/r'];
  f.service.configure({ ...f.policy, enabled: true });
  assert.equal(f.service.current(oldPolicy), false);
  f.options.observe = async () => [];
  await f.service.tick();
  assert.equal(f.held().state, 'unclaimed');
});
