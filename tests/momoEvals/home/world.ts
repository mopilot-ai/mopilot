// Two (or three) simulated machines, a fake clock, a fault-injecting link and invariant checks for the MoMo home evals; the real home, move and turn-ledger code runs on every machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createMomoHome, HOST_OWN } from '../../../host/src/momoHome.mjs';
// @ts-ignore
import { createMomoMove, MOVE_TTL_MS, MOVE_GRACE_MS } from '../../../host/src/momoMove.mjs';
// @ts-ignore
import { collectFiles } from '../../../host/src/momoBundle.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../../../host/src/secretStore.mjs';
// @ts-ignore
import { createStampSink } from '../../../shared/momoStamp.mjs';
// @ts-ignore
import { createMomoTurns } from '../../../host/src/momoTurns.mjs';
// @ts-ignore
import { moveHome, recoverMove } from '../../../shared/momoMove.mjs';
import { realRmSync, victim, forget, type Victim } from './faultFs.ts';

export { MOVE_TTL_MS, MOVE_GRACE_MS };
export const MOMO = ['momo'];
export const IDS = {
  A: { homeId: 'home-aaaa-1111', name: 'Studio' },
  B: { homeId: 'home-bbbb-2222', name: 'Mac mini' },
  C: { homeId: 'home-cccc-3333', name: 'Laptop' },
} as const;
export type Key = keyof typeof IDS;
export const FACT = 'Lives in Berlin';
export const OPEN_TURN = 'key-00000001';
const T0 = 1_700_000_000_000;

/** One simulated machine: its own folder, Host key and MoMo data key, killable at any state change of its files. */
export class Machine {
  home: any;
  readonly v: Victim;
  readonly dir: string;
  readonly momoDir: string;
  readonly keyDir: string;
  readonly w: World;
  readonly key: Key;
  readonly skewMs: number;
  constructor(w: World, key: Key, skewMs = 0) {
    this.w = w;
    this.key = key;
    this.skewMs = skewMs;
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), `momo-home-eval-${key}-`));
    this.momoDir = path.join(this.dir, 'data', 'momo');
    this.keyDir = path.join(this.dir, 'config', 'momo');
    this.v = victim(this.dir);
    this.build();
  }
  get id() {
    return IDS[this.key];
  }
  get alive() {
    return !this.v.dead;
  }
  private make(): any {
    const clock = { now: () => this.w.at + this.skewMs };
    const home: any = createMomoHome({
      hostId: this.id.homeId,
      dataDir: path.join(this.dir, 'data'),
      safeStorage: createFileSafeStorage(path.join(this.dir, 'config')),
      dataSafeStorage: createFileSafeStorage(this.keyDir),
      dataKeyDir: this.keyDir,
      clock,
      isMomoChat: (c: string) => c === 'momo-chat',
      report: () => undefined,
    });
    home.move = createMomoMove({ home });
    home.chats = { isMomoChat: () => true };
    return home;
  }
  private build() {
    this.home = this.make();
  }
  /** What a Host has before it was ever a home: granted, empty. */
  async granted() {
    await this.home.grant({ account: 'a1', features: MOMO });
    return this;
  }
  /** The machine is MoMo's home with a fact, an audit entry and a turn in flight (epoch 1). */
  async asHome() {
    await this.home.start(this.id);
    const s = this.home.stores();
    await s.memory.save({ text: FACT, source: { chatId: 'momo-chat', harness: 'claude' } });
    const { id } = await s.audit.intent({
      action: 'mail_send',
      args: { to: 'ann@example.com' },
      chatId: 'momo-main',
      harness: 'claude',
      account: 'work',
      decision: 'asked:once',
    });
    await s.audit.outcome(id, { result: 'done', note: 'ok' });
    await s.turns.accept({ turnId: OPEN_TURN, chatId: 'claude:c1', deviceId: 'phone', leaseEpoch: 1 });
    return this;
  }
  /** A turn as the ledger on disk keeps it (readable while the home is paused or down); `unknown` when this machine never saw it. */
  turnState(turnId: string): string {
    return createMomoTurns({ dir: this.momoDir, safeStorage: createFileSafeStorage(this.keyDir), now: () => this.w.at }).status(turnId)
      .state;
  }
  /** Whether the audit log of the running home carries the "moved" entry of its move. */
  async movedEntry(): Promise<boolean> {
    return /momo\.home\.moved/.test(await this.home.stores().audit.exportJsonl());
  }
  kill() {
    this.v.dead = true;
  }
  /** Power back on: a new process over the same folders (what was only in memory is gone; a dead owner's lock files are taken over). */
  restart() {
    this.v.dead = false;
    this.v.countdown = null;
    const walk = (d: string) => {
      for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.lock')) realRmSync(p, { force: true });
      }
    };
    walk(this.dir);
    this.build();
  }
  /** A read-only view of a machine that is down: its record as it is on disk. */
  record(): any {
    return this.alive ? this.home.record() : this.make().record();
  }
  hasData() {
    return (
      fs.existsSync(this.momoDir) &&
      collectFiles(this.momoDir, (rel: string) => HOST_OWN.includes(rel) || /\.(lock|tmp)$/.test(rel) || rel.startsWith('.')).length > 0
    );
  }
  hasKey() {
    return fs.existsSync(path.join(this.keyDir, 'safe-storage.key'));
  }
  /** Whether it may act right now (the stamp is what every write, turn and push of a home carries). */
  acts() {
    return this.alive && this.home.stamp() !== null;
  }
  stamp(): { homeId: string; leaseEpoch: number } | null {
    return this.alive ? this.home.stamp() : null;
  }
  dispose() {
    forget(this.v);
    realRmSync(this.dir, { recursive: true, force: true });
  }
}

/** `flush`: first deliver every frame the link was holding, then carry this one normally (a late frame overtakes the step after it). */
export type FaultKind = 'drop-req' | 'drop-resp' | 'dup' | 'delay' | 'kill-before' | 'kill-at' | 'flush';
export type Fault = { machine: Key; op: string; kind: FaultKind; nth?: number; k?: number };
const lost = (code = 'timeout') => Object.assign(new Error('the link dropped the frame'), { code });

/** The link between the app and each Host: every `host.momoMove` step goes through it, and a script of faults decides what happens to a frame. */
export class Net {
  faults: Fault[] = [];
  held: { machine: Key; op: string; run: () => Promise<unknown> }[] = [];
  log: { machine: Key; op: string; params: object; ok: boolean; out?: any; code?: string }[] = [];
  private counts = new Map<string, number>();
  readonly w: World;
  constructor(w: World) {
    this.w = w;
  }
  side(key: Key) {
    const m = this.w.m[key]!;
    return {
      call: (op: string, p: object = {}) => this.send(m, op, p),
      status: async () => {
        if (!m.alive) throw lost('offline');
        const f = this.pick(key, 'status');
        if (f && f.kind !== 'dup') throw lost();
        return m.home.status();
      },
    };
  }
  /** The number the next frame of this step will have, so a fault can be aimed at the next attempt rather than the first. */
  nextNth(key: Key, op: string) {
    return (this.counts.get(`${key}:${op}`) ?? 0) + 1;
  }
  private pick(key: Key, op: string) {
    const n = (this.counts.get(`${key}:${op}`) ?? 0) + 1;
    this.counts.set(`${key}:${op}`, n);
    return this.faults.find((f) => f.machine === key && f.op === op && (f.nth ?? 1) === n);
  }
  private async send(m: Machine, op: string, p: object) {
    const f = this.pick(m.key, op);
    this.w.tick(40);
    if (!m.alive) throw lost('offline');
    const run = () => (m.home.move[op] as (x: object) => Promise<any>)({ op, ...p, ...(op === 'reclaim' ? { by: 'test-device' } : {}) });
    const record = async (go: () => Promise<any>) => {
      try {
        const out = await go();
        this.log.push({ machine: m.key, op, params: p, ok: true, out });
        return out;
      } catch (e: any) {
        this.log.push({ machine: m.key, op, params: p, ok: false, code: e?.code });
        throw e;
      }
    };
    switch (f?.kind) {
      case 'flush':
        await this.deliverHeld();
        return record(run);
      case 'drop-req':
        throw lost();
      case 'kill-before':
        m.kill();
        throw lost();
      case 'delay':
        this.held.push({ machine: m.key, op, run });
        throw lost();
      case 'drop-resp':
        await record(run);
        throw lost();
      case 'dup': {
        const out = await record(run);
        await run().catch(() => undefined);
        return out;
      }
      case 'kill-at': {
        m.v.countdown = f.k ?? 1;
        try {
          const out = await record(run);
          if (m.v.dead) throw lost();
          return out;
        } catch (e) {
          if (m.v.dead) throw lost();
          throw e;
        } finally {
          m.v.countdown = null;
        }
      }
      default:
        return record(run);
    }
  }
  /** Deliver every frame the link was holding, in the order they were sent (they answer nobody). */
  async deliverHeld() {
    const frames = this.held.splice(0);
    for (const f of frames) await f.run().catch(() => undefined);
  }
}

export class World {
  at = T0;
  m: Partial<Record<Key, Machine>> = {};
  net = new Net(this);
  /** Every stamp any machine was seen acting with. */
  issued: { key: Key; homeId: string; leaseEpoch: number }[] = [];
  /** Every machine that accepted a turn id as new (a run), by turn id. */
  turnRuns = new Map<string, Key[]>();
  tick(ms: number) {
    this.at += ms;
  }
  add(key: Key, skewMs = 0) {
    return (this.m[key] = new Machine(this, key, skewMs));
  }
  all(): Machine[] {
    return Object.values(this.m) as Machine[];
  }
  dispose() {
    for (const m of this.all()) m.dispose();
  }
  /** A device sends a turn to a machine the way the chat guard does: only a running, granted home accepts, and the ledger decides whether it is new. */
  async sendTurn(key: Key, turnId: string, chatId = 'claude:c1') {
    const m = this.m[key]!;
    if (!m.alive) return 'offline' as const;
    const stamp = m.home.stamp();
    const turns = m.home.stores()?.turns;
    if (!stamp || !turns) return 'away' as const;
    try {
      const r = await turns.accept({ turnId, chatId, deviceId: 'phone', leaseEpoch: stamp.leaseEpoch });
      if (!r.duplicate) this.turnRuns.set(turnId, [...(this.turnRuns.get(turnId) ?? []), key]);
      return r.duplicate ? ('duplicate' as const) : ('run' as const);
    } catch {
      // the machine was killed under the device's feet, or the ledger refused (busy): the device sees an error and the turn did not run
      return 'offline' as const;
    }
  }
}

/** A two-machine world: A is the home with data and a turn in flight, B is a granted machine that holds nothing. */
export async function twoMachines(opts: { skewB?: number; third?: boolean } = {}) {
  const w = new World();
  const a = await w.add('A').granted();
  await a.asHome();
  w.turnRuns.set(OPEN_TURN, ['A']);
  await w.add('B', opts.skewB ?? 0).granted();
  if (opts.third) await w.add('C').granted();
  observe(w); // A's first stamp (epoch 1) is on record, so a later machine that honours it is caught
  return w;
}

export type Obs = {
  key: Key;
  alive: boolean;
  state: string;
  epoch: number;
  moveId: string | null;
  acts: boolean;
  data: boolean;
  keyFile: boolean;
  hash: string | null;
  movedTo: any;
};
export function observe(w: World): Obs[] {
  return w.all().map((m) => {
    const r = m.record() ?? {};
    const acts = m.acts();
    const s = m.stamp();
    if (s) w.issued.push({ key: m.key, ...s });
    return {
      key: m.key,
      alive: m.alive,
      state: r.state ?? 'unreadable',
      epoch: r.leaseEpoch ?? 0,
      moveId: r.moveId ?? null,
      acts,
      data: m.hasData(),
      keyFile: m.hasKey(),
      hash: r.bundleHash ?? null,
      movedTo: r.movedTo ?? null,
    };
  });
}

/** Whether a receiver that sees these stamps in any order refuses every one older than the newest (the real sink, shared/momoStamp.mjs). */
export function fencedBy(stamps: { homeId: string; leaseEpoch: number }[]): boolean {
  const top = Math.max(...stamps.map((s) => s.leaseEpoch));
  for (const order of [[...stamps].sort((a, b) => a.leaseEpoch - b.leaseEpoch), [...stamps].sort((a, b) => b.leaseEpoch - a.leaseEpoch)]) {
    let newest: any = null;
    const sink = createStampSink({ read: () => newest, write: (n: any) => void (newest = n) });
    for (const s of order) sink.accept(s);
    for (const s of stamps) if (s.leaseEpoch < top && sink.accept(s).ok) return false;
  }
  return true;
}

/** The invariants that must hold after every injected fault. Returns violations (empty = fine). */
export async function violations(w: World, sealedHashes: string[] = []): Promise<string[]> {
  const out: string[] = [];
  const obs = observe(w);
  const acting = obs.filter((o) => o.acts);
  // never two homes acting: at most one machine is willing to accept a write, a turn or a push at the newest lease; an older one (a reclaimed
  // move's target) may still run, but only where every receiver refuses its stamps
  const top = Math.max(0, ...acting.map((o) => o.epoch));
  const highs = acting.filter((o) => o.epoch === top);
  const lows = acting.filter((o) => o.epoch < top);
  if (highs.length > 1) out.push(`two homes act: ${acting.map((o) => `${o.key}@${o.epoch}`).join(', ')}`);
  if (lows.length && !fencedBy(acting.map((o) => ({ homeId: IDS[o.key].homeId, leaseEpoch: o.epoch }))))
    out.push(`an older home acts and its stamps are not refused: ${lows.map((o) => `${o.key}@${o.epoch}`).join(', ')}`);
  let accepted = 0;
  for (const m of w.all()) {
    if (!m.alive || !m.acts() || m.stamp()!.leaseEpoch < top) continue;
    const r = await m.home
      .stores()
      ?.turns.accept({ turnId: `probe-${m.key}-${w.at}`, chatId: `probe:${m.key}`, deviceId: null, leaseEpoch: m.home.stamp().leaseEpoch });
    if (r) {
      accepted++;
      await m.home.stores().turns.settle(`probe:${m.key}`, 'completed');
    }
  }
  if (accepted > 1) out.push(`${accepted} machines accepted a turn`);
  // stale epoch writes refused: a stamp older than the highest epoch any machine acts at is refused everywhere (a fenced older home still honours its own)
  for (const s of w.issued)
    if (s.leaseEpoch < top)
      for (const m of w.all())
        if (m.alive && !(m.acts() && m.stamp()!.leaseEpoch < top) && m.home.current({ homeId: s.homeId, leaseEpoch: s.leaseEpoch }))
          out.push(`${m.key} honours the stale stamp ${s.key}@${s.leaseEpoch}`);
  // never a lost home: some machine acts, or holds the data and key in a stated state (moving / running) a recovery can start from
  if (!acting.length && !obs.some((o) => (o.state === 'moving' || o.state === 'running') && o.data && o.keyFile))
    out.push('no home: nobody acts and nobody holds the data in a stated state');
  // no wipe without a target receipt: a machine that holds no data any more needs a running home of a newer epoch that adopted a bundle that was sealed
  for (const o of obs) {
    const wiped = (o.state === 'none' && o.movedTo) || (o.state === 'moving' && (!o.data || !o.keyFile));
    if (!wiped) continue;
    // a tombstone's receipt is the machine that took over and still holds MoMo (running, or moving it on again or back after a cut move: its hash is reset then)
    const receipt = obs.find(
      (n) =>
        n.key !== o.key &&
        n.data &&
        n.keyFile &&
        (o.state === 'none'
          ? (n.state === 'running' || n.state === 'moving') && n.epoch >= o.epoch
          : n.state === 'running' && n.epoch > o.epoch && !!n.hash && (!sealedHashes.length || sealedHashes.includes(n.hash))),
    );
    if (!receipt) out.push(`${o.key} deleted its data but no target holds a receipt`);
  }
  // a turn runs once: no turn id was accepted as new on two machines
  for (const [id, keys] of w.turnRuns) if (keys.length > 1) out.push(`turn ${id} ran on ${keys.join(' and ')}`);
  return out;
}

/** The sealed bundles' hashes seen on the link, as receipts. */
export const sealedHashes = (w: World) => w.net.log.filter((l) => l.op === 'seal' && l.ok).map((l) => l.out.bundleHash as string);

/** One move of the home from A to `to`, the way the app drives it. */
export function drive(w: World, o: { moveId?: string; to?: Key; from?: Key; cancelled?: () => boolean; step?: (s: string) => void } = {}) {
  const to = o.to ?? 'B';
  const from = o.from ?? 'A';
  return moveHome({
    moveId: o.moveId ?? 'move-0001',
    from: w.net.side(from),
    to: w.net.side(to),
    target: IDS[to],
    fromName: IDS[from].name,
    cancelled: o.cancelled,
    step: o.step,
  }) as Promise<any>;
}

/**
 * What the app does after any fault (settling a move on the target's signed word): power everything back on, then every machine stuck in
 * `moving` is settled with each other machine (`recoverMove`: switched -> cleared, gave up -> resumed); a target that holds nothing of the
 * move is confirmed by the owner (`ownerAccepts`); leftovers on targets are discarded.
 */
export async function recover(w: World, moveIds: string[], o: { faults?: Fault[]; restart?: boolean } = {}) {
  if (o.restart !== false) for (const m of w.all()) if (!m.alive) m.restart();
  const net = new Net(w);
  net.faults = o.faults ?? [];
  for (const o of observe(w)) {
    if (o.state !== 'moving' || !o.moveId) continue;
    for (const other of w.all()) {
      if (other.key === o.key) continue;
      for (const ownerAccepts of [false, true]) {
        // a target that lost the move cannot sign: the person waits for the move's time to run out, then confirms
        if (ownerAccepts) w.tick(MOVE_TTL_MS + MOVE_GRACE_MS + 1000);
        const r = await recoverMove({
          moveId: o.moveId,
          from: net.side(o.key),
          to: net.side(other.key),
          target: IDS[other.key],
          ownerAccepts,
        });
        if (r.state !== 'uncertain') break;
      }
      if (w.m[o.key]!.record().state !== 'moving') break;
    }
  }
  for (const m of w.all())
    for (const id of moveIds)
      await net
        .side(m.key)
        .call('discard', { moveId: id })
        .catch(() => undefined);
}

/** After a recovery: exactly one home acts, with the fact and an audit chain that verifies. */
export async function healthy(w: World, o: { strays?: boolean } = {}): Promise<string[]> {
  const out: string[] = [];
  const acting = w.all().filter((m) => m.acts());
  if (acting.length !== 1) return [`${acting.length} homes act after recovery`];
  const s = acting[0].home.stores();
  if (!s.memory.list().facts.some((f: any) => f.text === FACT)) out.push('the fact is gone');
  if (!(await s.audit.verify()).ok) out.push('the audit chain is broken');
  for (const m of w.all())
    for (const d of [m.momoDir, m.keyDir]) if (fs.existsSync(`${d}.incoming`)) out.push(`${m.key} keeps a staged copy`);
  // no stray copy: a machine that is not the home holds no MoMo data and no data key
  if (o.strays !== false)
    for (const m of w.all())
      if (!m.acts() && (m.hasData() || m.hasKey())) out.push(`${m.key} keeps a copy of MoMo's data though it is not the home`);
  return out;
}
