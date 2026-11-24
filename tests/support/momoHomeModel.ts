// The model of the home's safety, shared by tests/momoHomeSafetyModel.test.ts and tests/momoHomeClientRules.test.ts: Hosts and clients built over the real pure rules (shared/host/momoHomeSafety.mjs, shared/host/momoHomeClient.mjs, shared/host/momoMovePhases.mjs), the events a world can go through and the invariants checked after each.
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { adoptRule, lookOf, resetRule, standDownRule, startRule } from '../../shared/host/momoHomeSafety.mjs';
// @ts-ignore
import { oldHome } from '../../shared/host/momoMovePhases.mjs';
// @ts-ignore
import { createSteps, decide, execute, reviveSteps } from '../../shared/host/momoHomeClient.mjs';

export type Rec = {
  homeId: string | null;
  leaseEpoch: number;
  state: 'none' | 'running' | 'moving';
  name: string;
  movedTo: any;
  retired: any;
  account: string | null;
  moveId: string | null;
  bundleHash: string | null;
  targetSignKey: string | null;
  moveDeadline: number | null;
  closedMoves: string[];
};
export type Host = {
  id: string;
  rec: Rec;
  grantLive: boolean;
  reachable: boolean;
  readable: boolean;
  moveTo: string | null;
  known: number;
  data: boolean;
  lookFeature: boolean;
  version: string;
};
export type Client = { seen: number; chosen: string | null; deleting?: { host: string; epoch: number } | null };
export type World = { hosts: Host[]; clients: Client[]; leases: string[] };

export const none = (): Rec => ({
  homeId: null,
  leaseEpoch: 0,
  state: 'none',
  name: '',
  movedTo: null,
  retired: null,
  account: null,
  moveId: null,
  bundleHash: null,
  targetSignKey: null,
  moveDeadline: null,
  closedMoves: [],
});
export const running = (id: string, epoch: number): Rec => ({ ...none(), homeId: id, leaseEpoch: epoch, state: 'running', name: id });
export const host = (id: string, rec: Rec, data = false): Host => ({
  id,
  rec,
  grantLive: true,
  reachable: true,
  readable: true,
  moveTo: null,
  known: 0,
  data,
  lookFeature: true,
  version: '9.9.9',
});
/** `ids`: the Hosts' ids; the first runs MoMo at epoch 1. Walked in both orders so the greater id is each Host in turn. */
export const fresh = (ids: [string, string, string]): World => ({
  hosts: [host(ids[0], running(ids[0], 1), true), host(ids[1], none()), host(ids[2], none())],
  clients: [
    { seen: 1, chosen: null },
    { seen: 1, chosen: null },
  ],
  leases: [`${ids[0]}:1`],
});
export const clone = (w: World): World => JSON.parse(JSON.stringify(w));
export const live = (h: Host) => h.rec.state === 'running' || h.rec.state === 'moving';
export const heard = (h: Host) => h.reachable && h.readable && h.lookFeature;

export const machines = (w: World) =>
  w.hosts.map((h) => ({
    id: h.id,
    hasHost: true,
    reachable: h.reachable,
    lookFeature: h.lookFeature,
    version: h.version,
    versionFresh: true,
    look: h.reachable && h.lookFeature ? lookOf(h.readable ? (h.rec as any) : null, h.grantLive) : null,
  }));

/** The Host's start (host/src/momoHome.mjs `start`), through the same pure rule. */
export function hostStart(w: World, h: Host, p: { name: string; floor?: number; revive?: boolean }) {
  if (!heard(h)) return { ok: false as const, code: 'unreachable' };
  const out = startRule(h.rec as any, { hostId: h.id, name: p.name, floor: p.floor, known: h.known, revive: p.revive });
  if ('refuse' in out) return { ok: false as const, code: out.refuse.code };
  if ('set' in out) {
    Object.assign(h.rec, out.set);
    h.rec.leaseEpoch = out.epoch;
    h.data = true;
    w.leases.push(`${h.id}:${out.epoch}`);
  }
  return { ok: true as const, leaseEpoch: h.rec.leaseEpoch, homeId: h.rec.homeId ?? '' };
}
/** The Host's stand-down (host/src/momoHomeSafety.mjs): the record, keeping the data. */
export function hostStandDown(h: Host, lease: { homeId: string; leaseEpoch: number; name?: string }) {
  if (!heard(h)) return { ok: false as const, code: 'unreachable' };
  const out = standDownRule(h.rec as any, lease, 0, h.known);
  if ('refused' in out) return { ok: false as const, code: out.refused };
  if ('retire' in out) Object.assign(h.rec, out.retire);
  if ('raise' in out) h.rec.leaseEpoch = out.raise;
  return { ok: true as const, leaseEpoch: h.rec.leaseEpoch };
}
/** A client runs steps through the Hosts. */
export const run = (w: World, steps: any[]) =>
  execute(steps, async (step: any) => {
    const h = w.hosts.find((x) => x.id === step.host)!;
    return step.call === 'host.momoHomeStart' ? hostStart(w, h, step.params) : hostStandDown(h, step.params);
  });

/** A client's sync: look at every Host, remember what it saw, run the steps the shared rules say. */
export async function sync(w: World, c: number) {
  const d = decide(machines(w), w.clients[c]!);
  w.clients[c]!.seen = Math.max(w.clients[c]!.seen, d.floor);
  await run(w, d.steps);
  return d;
}

export type Event = { label: string; run: (w: World) => Promise<void> | void };
export const events = (hosts: number[]): Event[] => {
  const out: Event[] = [];
  for (const c of [0, 1]) {
    out.push({ label: `client ${c} restarts with no memory`, run: (w) => void (w.clients[c] = { seen: 0, chosen: null }) });
    out.push({ label: `client ${c} syncs`, run: async (w) => void (await sync(w, c)) });
    for (const h of hosts) {
      const create = (remember: boolean) => async (w: World) => {
        const d = decide(machines(w), w.clients[c]!);
        if (!d.offerChoose && !d.offerStartFresh) return;
        const target = w.hosts[h]!;
        await run(w, createSteps(d, { id: target.id, name: target.id, own: target.rec.leaseEpoch }));
        if (remember) w.clients[c]!.seen = Math.max(w.clients[c]!.seen, d.floor);
      };
      out.push({ label: `client ${c} starts a home on Host ${h} (choose, or Start fresh after the owner confirmed)`, run: create(true) });
      out.push({ label: `client ${c} starts a home on Host ${h} and crashes before it remembers`, run: create(false) });
      out.push({
        label: `client ${c} takes back the retired home on Host ${h}`,
        run: async (w) => {
          const d = decide(machines(w), w.clients[c]!);
          const target = w.hosts[h]!;
          if (!d.older.some((o: any) => o.host === target.id)) return;
          const liveHomes = w.hosts
            .filter((x) => live(x) && heard(x))
            .map((x) => ({ id: x.id, name: x.id, homeId: x.rec.homeId!, leaseEpoch: x.rec.leaseEpoch }));
          await run(w, reviveSteps(d, { id: target.id, name: target.id, own: target.rec.leaseEpoch }, liveHomes));
        },
      });
    }
    out.push({
      label: `client ${c} accepts the lease of the older copy`,
      run: (w) => {
        const homes = w.hosts.filter((h) => live(h) && heard(h));
        if (homes.length < 2) return;
        w.clients[c]!.chosen = homes.reduce((a, b) => (a.rec.leaseEpoch <= b.rec.leaseEpoch ? a : b)).rec.homeId;
      },
    });
  }
  for (const h of hosts) {
    out.push({ label: `Host ${h} unreachable`, run: (w) => void (w.hosts[h]!.reachable = false) });
    out.push({ label: `Host ${h} reachable`, run: (w) => void (w.hosts[h]!.reachable = true) });
    out.push({ label: `Host ${h} unreadable`, run: (w) => void (w.hosts[h]!.readable = false) });
    out.push({ label: `Host ${h} readable`, run: (w) => void (w.hosts[h]!.readable = true) });
    out.push({ label: `Host ${h} grant lapses`, run: (w) => void (w.hosts[h]!.grantLive = false) });
    out.push({ label: `Host ${h} grant sent again`, run: (w) => void (w.hosts[h]!.grantLive = true) });
    out.push({
      label: `Host ${h} sees the newest stamp`,
      run: (w) => void (w.hosts[h]!.known = Math.max(0, ...w.hosts.filter(live).map((x) => x.rec.leaseEpoch))),
    });
    out.push({
      label: `Host ${h} is Reset (record kept, tombstone and retirement cleared, epoch kept, data deleted)`,
      run: (w) => {
        const r = w.hosts[h]!.rec;
        Object.assign(r, { ...none(), leaseEpoch: r.leaseEpoch });
        w.hosts[h]!.data = false;
      },
    });
    out.push({
      label: `Host ${h} is an older build that cannot say what it holds (version "dev")`,
      run: (w) => {
        w.hosts[h]!.lookFeature = false;
        w.hosts[h]!.version = 'dev';
      },
    });
    out.push({
      label: `Host ${h} is an up to date build again`,
      run: (w) => void ((w.hosts[h]!.lookFeature = true), (w.hosts[h]!.version = '9.9.9')),
    });
    for (const c of [0, 1]) {
      out.push({
        label: `client ${c} confirms "Delete the old MoMo" on Host ${h} (it saw the copy retired)`,
        run: (w) => {
          const target = w.hosts[h]!;
          if (target.rec.retired) w.clients[c]!.deleting = { host: target.id, epoch: target.rec.leaseEpoch };
        },
      });
      out.push({
        label: `client ${c}'s delete of the old MoMo on Host ${h} reaches it`,
        run: (w) => {
          const target = w.hosts[h]!;
          const pending = w.clients[c]!.deleting;
          if (!pending || pending.host !== target.id || !heard(target)) return;
          w.clients[c]!.deleting = null;
          // the Host's own rule: only a copy still retired at the epoch the owner saw is deleted
          if (resetRule(target.rec as any, { ifRetired: true, expectEpoch: pending.epoch })) return;
          Object.assign(target.rec, { ...none(), leaseEpoch: target.rec.leaseEpoch });
          target.data = false;
        },
      });
    }
    out.push({
      label: `the home begins a move to Host ${h}`,
      run: (w) => {
        const from = w.hosts.find((x) => x.rec.state === 'running' && x !== w.hosts[h]);
        const to = w.hosts[h]!;
        if (from && to.rec.state === 'none' && !to.rec.retired) {
          Object.assign(from.rec, { state: 'moving', moveId: 'm1', bundleHash: 'hash', targetSignKey: 'key' });
          from.moveTo = to.id;
        }
      },
    });
  }
  out.push({
    label: 'the move commits on its target, and the old home finishes',
    run: (w) => {
      const from = w.hosts.find((x) => x.moveTo);
      const to = from && w.hosts.find((x) => x.id === from.moveTo);
      if (!from || !to || !heard(to)) return;
      const epoch = from.rec.leaseEpoch + 1;
      // the target adopts only above the newest stamp it saw and its own record (the same rule as the Host's canAdopt)
      if (adoptRule(to.rec as any, epoch, to.known)) return;
      Object.assign(to.rec, { homeId: to.id, name: to.id, state: 'running', leaseEpoch: epoch, movedTo: null, retired: null });
      to.data = true;
      w.leases.push(`${to.id}:${epoch}`);
      from.moveTo = null;
      // the old home's finish, by the real rule: a moving home is tombstoned and its copy deleted; a home that was retired meanwhile keeps its data
      if (!heard(from)) return;
      const outcome = oldHome.finish(from.rec, { moveId: 'm1', leaseEpoch: epoch, receiptOk: true });
      if ('wipe' in outcome) {
        Object.assign(from.rec, { ...none(), leaseEpoch: epoch, movedTo: { name: to.id, homeId: to.id, at: 0 } });
        from.data = false;
      }
    },
  });
  return out;
};

/** What must hold after every event. */
export function check(w: World, trail: string[]) {
  const where = `after: ${trail.join(' > ')}`;
  const liveHosts = w.hosts.filter(live);
  const retiredHosts = w.hosts.filter((h) => h.rec.retired);
  for (let c = 0; c < w.clients.length; c++) {
    const d = decide(machines(w), w.clients[c]!);
    // a client never offers to create while a home may exist
    if (d.offerChoose)
      assert.ok(liveHosts.length === 0 && retiredHosts.length === 0, `choose offered while a home or a kept MoMo exists, ${where}`);
    if (d.offerStartFresh)
      for (const h of liveHosts) assert.ok(!heard(h), `Start fresh offered while Host ${h.id} answered with a home, ${where}`);
  }
  // a retired home keeps its data, and the lease it was retired by was a lease some Host actually granted
  for (const h of retiredHosts) {
    assert.ok(h.data, `a retired home lost its data, ${where}`);
    assert.ok(
      w.leases.includes(`${h.rec.movedTo.homeId}:${h.rec.leaseEpoch}`),
      `${h.id} was retired at a lease nobody granted (${h.rec.movedTo.homeId}:${h.rec.leaseEpoch}), ${where}`,
    );
  }
}
/** After a client syncs: at most one live home among the Hosts that answer, and never two at one epoch. */
export async function checkSynced(w: World, c: number, trail: string[]) {
  const s = clone(w);
  await sync(s, c);
  const homes = s.hosts.filter((h) => live(h) && heard(h));
  assert.ok(
    homes.length <= 1,
    `two live homes after a sync: ${trail.join(' > ')} => ${JSON.stringify(homes.map((h) => [h.id, h.rec.leaseEpoch]))}`,
  );
}
