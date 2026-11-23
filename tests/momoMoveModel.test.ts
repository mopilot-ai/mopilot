// Model test of moving MoMo's home: every interleaving (up to a depth) of two devices' steps, the clocks and a target that restarts, over the same pure rules the Host applies (shared/host/momoMovePhases.mjs), asserting that two Hosts never hold the same lease, a home is never lost, and the owner can always end a move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { oldHome, target, MOVE_TTL_MS, MOVE_GRACE_MS } from '../shared/host/momoMovePhases.mjs';

const TICK = MOVE_TTL_MS / 2;
const MOVES = ['m1', 'm2'];
const DEPTH = 9;

type Old = {
  state: 'none' | 'running' | 'moving';
  leaseEpoch: number;
  moveId: string | null;
  bundleHash: string | null;
  moveDeadline: number | null;
  targetSignKey: string | null;
  closedMoves: string[];
  movedTo: unknown;
};
type Tgt = { phase: 'offered' | 'received' | 'committed' | 'discarded'; expiresAt: number; key: string | null; epoch: number | null };
type World = {
  t: number; // A's clock; B's is t + skew
  a: Old;
  b: { state: 'none' | 'running'; leaseEpoch: number; moves: Record<string, Tgt>; keys: number };
  begun: Record<string, number>; // the epoch a client saw at `begin`
  sealed: Record<string, true>; // a bundle exists for the move (it may outlive the move on the old home)
};

const fresh = (): World => ({
  t: 0,
  a: {
    state: 'running',
    leaseEpoch: 1,
    moveId: null,
    bundleHash: null,
    moveDeadline: null,
    targetSignKey: null,
    closedMoves: [],
    movedTo: null,
  },
  b: { state: 'none', leaseEpoch: 0, moves: {}, keys: 0 },
  begun: {},
  sealed: {},
});
const clone = (w: World): World => JSON.parse(JSON.stringify(w));

/** The old home applies a rule's outcome the way the Host does inside its write. */
function applyOld(w: World, outcome: any) {
  if (outcome.set) {
    Object.assign(w.a, outcome.set);
    if (typeof outcome.epoch === 'number') w.a.leaseEpoch = outcome.epoch;
  } else if (outcome.wipe) {
    Object.assign(w.a, { state: 'none', moveId: null, bundleHash: null, moveDeadline: null, targetSignKey: null, movedTo: 'B' });
  }
}

/** All the steps; each returns the world after it (or null when the step cannot happen at all). The rules decide what is refused. */
function steps(w: World, skew: number): { label: string; next: World }[] {
  const out: { label: string; next: World }[] = [];
  const add = (label: string, f: (n: World) => void) => {
    const n = clone(w);
    f(n);
    out.push({ label, next: n });
  };
  const nowA = w.t;
  const nowB = w.t + skew;
  add('tick', (n) => void (n.t += TICK));
  add('crash B', (n) => {
    // a restarted target loses the offers and bundles it had not switched or given up
    for (const [id, m] of Object.entries(n.b.moves)) if (m.phase === 'offered' || m.phase === 'received') delete n.b.moves[id];
  });
  add('expire A', (n) => applyOld(n, oldHome.expire(n.a, { now: nowA })));
  for (const m of MOVES) {
    add(`begin ${m}`, (n) => {
      const o: any = oldHome.begin(n.a, { moveId: m, now: nowA });
      applyOld(n, o);
      if (o.set) n.begun[m] = n.a.leaseEpoch;
    });
    add(`offer ${m}`, (n) => {
      const o: any = target.offer(n.b.moves[m], { homeState: n.b.state, now: nowB });
      if (o.error || n.b.moves[m]?.phase === o.phase) return;
      n.b.moves[m] = { phase: 'offered', expiresAt: nowB + MOVE_TTL_MS, key: `k${m}${++n.b.keys}`, epoch: null };
    });
    add(`seal ${m}`, (n) => {
      const key = n.b.moves[m]?.key ?? `k${m}0`; // the client holds the key the offer gave it
      const o: any = oldHome.seal(n.a, { moveId: m, signKey: key, hash: `h${m}`, now: nowA });
      applyOld(n, o);
      if (o.set) n.sealed[m] = true;
    });
    add(`receive ${m}`, (n) => {
      if (!n.sealed[m]) return; // only a bundle that was sealed can arrive
      const o: any = target.receive(n.b.moves[m], { now: nowB });
      if (!o.error) n.b.moves[m]!.phase = 'received';
    });
    add(`commit ${m}`, (n) => {
      const t = n.b.moves[m];
      const o: any = target.commit(t, { now: nowB, stageOwned: t?.phase === 'received' });
      if (o.error || o.answer || n.b.state !== 'none' || n.begun[m] === undefined) return;
      t!.phase = 'committed';
      t!.epoch = n.begun[m]! + 1;
      n.b.state = 'running';
      n.b.leaseEpoch = t!.epoch;
    });
    add(`discard ${m}`, (n) => {
      const t = n.b.moves[m];
      const o: any = target.discard(t);
      if (o.ok) n.b.moves[m] = { phase: 'discarded', expiresAt: t?.expiresAt ?? 0, key: t?.key ?? null, epoch: null };
    });
    add(`cancel ${m}`, (n) => {
      const t = n.b.moves[m];
      const proofOk = t?.phase === 'discarded' && t.key !== null && t.key === n.a.targetSignKey;
      applyOld(n, oldHome.cancel(n.a, { moveId: m, proofOk }));
    });
    add(`reclaim ${m}`, (n) => applyOld(n, oldHome.reclaim(n.a, { moveId: m })));
    add(`finish ${m}`, (n) => {
      const t = n.b.moves[m];
      const receiptOk = t?.phase === 'committed' && t.key === n.a.targetSignKey && t.epoch !== null;
      applyOld(n, oldHome.finish(n.a, { moveId: m, leaseEpoch: t?.epoch ?? n.a.leaseEpoch + 1, receiptOk }));
    });
  }
  return out;
}

/** What must hold in every reachable world. */
function violation(w: World): string | null {
  const bRunning = w.b.state === 'running';
  const aRuns = w.a.state === 'running';
  // two running homes are allowed only when the old one reclaimed: its lease is then above anything the new one holds, so every receiver refuses the new one's stamps
  if (aRuns && bRunning && !(w.a.leaseEpoch > w.b.leaseEpoch))
    return 'two Hosts could stamp: the old home runs at a lease no newer than the new one';
  if (w.a.state === 'none' && !bRunning) return 'the home is lost';
  if (w.a.state === 'none' && w.a.leaseEpoch >= w.b.leaseEpoch && bRunning)
    return 'the new home holds a lease no newer than the one it replaced';
  if (w.a.state === 'moving') {
    // the owner can always end a move: reclaim gives a lease above anything the target could hold
    const probe = clone(w);
    const o: any = oldHome.reclaim(probe.a, { moveId: w.a.moveId! });
    if (!o.set || o.epoch !== w.a.leaseEpoch + 2) return 'the owner cannot end the move';
    if (bRunning && !(o.epoch > w.b.leaseEpoch)) return 'a reclaimed lease is not above the target’s';
  }
  return null;
}

for (const skew of [-(MOVE_TTL_MS + MOVE_GRACE_MS), 0, MOVE_TTL_MS + MOVE_GRACE_MS]) {
  test(`every interleaving of two devices, the clocks and a restarting target keeps one home, never loses it and lets the owner end a move (target clock ${skew / 60_000} min off)`, () => {
    let frontier = [fresh()];
    const seen = new Set<string>([JSON.stringify(frontier[0])]);
    const reached: Record<string, boolean> = {};
    for (let depth = 0; depth < DEPTH; depth++) {
      const next: World[] = [];
      for (const w of frontier) {
        for (const s of steps(w, skew)) {
          const key = JSON.stringify(s.next);
          if (seen.has(key)) continue;
          seen.add(key);
          const bad = violation(s.next);
          assert.equal(bad, null, `${bad} after "${s.label}" from ${JSON.stringify(w)}`);
          if (s.next.a.state === 'none') reached['moved'] = true;
          if (s.next.a.state === 'running' && s.next.a.leaseEpoch > 1) reached['reclaimed or back'] = true;
          if (s.next.b.state === 'running' && s.next.a.state === 'running') reached['two running at different leases'] = true;
          next.push(s.next);
        }
      }
      frontier = next;
    }
    assert.ok(seen.size > 500, `explored ${seen.size} worlds`);
    // the model reaches both ends of a move and the fenced-twin case, so its invariants are not vacuous
    assert.ok(reached['moved'], 'a move completes');
    assert.ok(reached['reclaimed or back'], 'the owner reclaims');
    assert.ok(reached['two running at different leases'], 'a reclaimed home and a late target coexist at different leases');
  });
}
