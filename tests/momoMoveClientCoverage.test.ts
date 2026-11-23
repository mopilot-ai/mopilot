// The client side of a move on its edges (shared/momoMove.mjs, shared/momoMoveRunner.mjs, shared/momoHomeView.mjs): a machine that is gone, a target that answers oddly, and the fixes a view names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { recoverMove } from '../shared/momoMove.mjs';
// @ts-ignore
import { createMoveRunner } from '../shared/momoMoveRunner.mjs';
// @ts-ignore
import { agentProblem, updateFix } from '../shared/momoHomeView.mjs';

const target = { homeId: 'home-bbbb-2222', name: 'Mac mini' };
const side = (calls: Record<string, (p: any) => any>) => ({
  call: async (op: string, p: any) => (calls[op] ? calls[op](p) : { ok: true }),
  status: async () => ({ home: null }),
});

test('the fixes a view names: install on a machine with no agent known, sign in on an agent that has no id, update a machine', () => {
  const m = (agents: object[]) => ({ id: 'studio', name: 'Studio', agents }) as any;
  assert.equal(agentProblem(m([]))!.fix.id, 'install-agent:studio:');
  assert.equal(agentProblem(m([{ name: 'Codex', installed: false, signedIn: false }]))!.fix.id, 'install-agent:studio:Codex');
  assert.equal(agentProblem(m([{ name: 'Codex', id: 'codex', installed: false, signedIn: false }]))!.fix.id, 'install-agent:studio:codex');
  assert.equal(agentProblem(m([{ name: 'Codex', installed: true, signedIn: false }]))!.fix.id, 'sign-in-agent:studio:Codex');
  assert.equal(agentProblem(m([{ name: 'Codex', id: 'codex', installed: true, signedIn: false }]))!.fix.id, 'sign-in-agent:studio:codex');
  assert.equal(agentProblem(m([{ name: 'Codex', installed: true, signedIn: true }])), null);
  assert.deepEqual(updateFix({ id: 'studio', name: 'Studio' } as any), { id: 'update-machine:studio', label: 'Update Studio' });
});

test('settling a move: a target that switched without naming its machine is the machine the app knows, a refusal is never reclaimed from, and a failing reclaim says why', async () => {
  const from = (extra: Record<string, (p: any) => any> = {}) => side({ finish: () => ({ ok: true }), ...extra });
  const moved = await recoverMove({
    moveId: 'move-0001',
    from: from(),
    to: side({ discard: () => ({ committed: true, leaseEpoch: 2, receipt: 'r' }) }),
    target,
  });
  assert.equal(moved.state === 'switched' && moved.homeId, target.homeId, 'no homeId in the answer: the app’s own');
  // a Host that refused with its own code is not "unreachable"; a thrown nothing is
  const refusing = side({
    discard: () => Promise.reject(Object.assign(new Error('no'), { code: 'move_unknown' })),
  });
  assert.equal((await recoverMove({ moveId: 'move-0001', from: from(), to: refusing, target, ownerAccepts: true })).state, 'uncertain');
  const nothing = side({ discard: () => Promise.reject(null) });
  assert.equal((await recoverMove({ moveId: 'move-0001', from: from(), to: nothing, target, ownerAccepts: true })).state, 'resumed');
  const failing = from({ reclaim: () => Promise.reject(Object.assign(new Error('The copy is gone.'), { code: 'home_copy_missing' })) });
  const down = side({ discard: () => Promise.reject(new Error('connect ECONNREFUSED')) });
  const r: any = await recoverMove({ moveId: 'move-0001', from: failing, to: down, target, ownerAccepts: true });
  assert.deepEqual([r.state, r.code], ['uncertain', 'home_copy_missing']);
});

/** A runner whose one move ended stuck: the old home is paused and the target is not known to have switched. */
async function stuck(over: { machines?: Record<string, any>; run?: any; home?: any } = {}) {
  const machines: Record<string, any> = {
    studio: { id: 'studio', name: 'Studio', side: side({}) },
    mini: { id: 'mini', name: 'Mac mini', side: side({ discard: () => ({ discarded: true, proof: 'p' }) }) },
    ...over.machines,
  };
  let changes = 0;
  const runner = createMoveRunner({
    home: over.home ?? (() => ({ id: 'studio', name: 'Studio' })),
    machine: (id: string) => machines[id] ?? null,
    newId: () => 'move-0001',
    changed: () => void changes++,
    run: over.run ?? (async () => ({ ok: false, step: 'switching', code: 'x', message: 'No answer.', rolledBack: false, uncertain: true })),
  });
  await runner.start('mini');
  while (runner.result() === null) await new Promise((r) => setTimeout(r, 1));
  return { runner, machines, changes: () => changes };
}

test('the runner settles a stuck move only with both machines, and says why when the target cannot settle it', async () => {
  const w = await stuck();
  // a machine that went away while the move was stuck
  delete w.machines.mini;
  await assert.rejects(w.runner.recover(), /not available/);
  await assert.rejects(w.runner.reclaim(), /not available/);
  w.machines.mini = { id: 'mini', name: 'Mac mini', side: side({ discard: () => ({ discarded: true, proof: null }) }) };
  await assert.rejects(w.runner.recover(), /could not say it gave the move up/);
  w.machines.studio.side = side({
    reclaim: () => Promise.reject(Object.assign(new Error('The copy is gone.'), { code: 'home_copy_missing' })),
  });
  await assert.rejects(w.runner.reclaim(), /copy is gone/);
  w.machines.studio.side = side({});
  // a device that never ran the move (or restarted) names it; with no home to ask from there is nothing to do
  const home = { v: { id: 'studio', name: 'Studio' } as { id: string; name: string } | null };
  const fresh = await stuck({ home: () => home.v });
  fresh.runner.acknowledge();
  home.v = null;
  await assert.rejects(fresh.runner.reclaim({ moveId: 'move-0009', toId: 'mini' }), /not available/);
  await assert.rejects(fresh.runner.reclaim(), /name the move/);
  // the same, with a home to ask from: the move is named by the device
  const withHome = await stuck();
  withHome.runner.acknowledge();
  assert.deepEqual(await withHome.runner.reclaim({ moveId: 'move-0001', toId: 'mini' }), { outcome: 'resumed' });
  assert.deepEqual(await w.runner.reclaim({ moveId: 'move-0001', toId: 'mini' }), { outcome: 'resumed' });
});

test('clearing the old machine later: a machine that went away is refused, and the home id comes from the receipt, the Host’s id or the app’s', async () => {
  const done = (homeId?: string) => async () => ({
    ok: true,
    oldHome: 'offline',
    leaseEpoch: 2,
    receipt: 'r',
    ...(homeId ? { homeId } : {}),
  });
  for (const [homeId, hostId, want] of [
    ['host-from-receipt', 'host-id', 'host-from-receipt'],
    [undefined, 'host-id', 'host-id'],
    [undefined, undefined, 'mini'],
  ] as const) {
    let seen = '';
    const w = await stuck({
      run: done(homeId),
      machines: {
        mini: { id: 'mini', ...(hostId ? { hostId } : {}), name: 'Mac mini', side: side({}) },
        studio: { id: 'studio', name: 'Studio', side: side({ finish: (p) => ((seen = p.homeId), { ok: true }) }) },
      },
    });
    await w.runner.retryPending();
    assert.equal(seen, want);
  }
  const gone = await stuck({ run: done() });
  delete gone.machines.mini;
  await assert.rejects(gone.runner.retryPending(), /not available/);
});

test('a retry that finds the move had switched after all says so and does not move again', async () => {
  const w = await stuck({
    machines: {
      mini: {
        id: 'mini',
        name: 'Mac mini',
        side: side({ discard: () => ({ committed: true, leaseEpoch: 2, receipt: 'r', homeId: 'x' }) }),
      },
    },
  });
  await assert.rejects(w.runner.retry(), /already moved to Mac mini/);
});
