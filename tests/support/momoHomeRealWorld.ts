// Two real in-process Hosts behind the ports of MoMo's real home (shared/momoHomeReal.mjs): the app's machine list, a call to a machine that reaches that machine's real `host.momo*` handlers, a way to take a machine down or to answer one method differently, and this device's outbox and highest-lease memory in memory.
// @ts-ignore
import { parseParams } from '../../shared/host/schema.mjs';
import momoMethods from '../../host/src/methods/momo.mjs';
// @ts-ignore: plain ESM without declarations
import { createRealHome } from '../../shared/momoHomeReal.mjs';
// @ts-ignore
import { createMomoOutbox } from '../../shared/momoOutbox.mjs';
import { A, B, host } from './host/momoMoveWorld.ts';

export { A, B };

export const record = (id: string, name: string, hostId: string, over: object = {}) => ({
  id,
  hostId,
  name,
  isThisDevice: false,
  reachable: true,
  current: true,
  stays: 'on',
  setUp: true,
  agents: [{ id: 'claude', name: 'Claude Code', installed: true, signedIn: true }],
  ...over,
});

/** The app's side: the machine list, and a call to a machine that reaches that machine's real Host handlers. The stores of the app (where MoMo lives, the newest lease, the unsent messages) outlive a restart of the composition. */
export async function world(
  t: any,
  opts: {
    second?: boolean;
    google?: any;
    timeouts?: { status?: number; call?: number };
    wire?: boolean;
    noAct?: boolean;
    ids?: (key: string) => string;
  } = {},
) {
  // `wire`: the Hosts hold no grant to begin with, every call passes the Host's own veil as an owner desktop, and what comes back is parsed as JSON, as over the wire
  const a = await host(t, A, { granted: !opts.wire });
  const b = opts.second ? await host(t, B, { granted: !opts.wire }) : null;
  const hosts: Record<string, any> = { studio: a, ...(b ? { mini: b } : {}) };
  const methods = Object.fromEntries(Object.entries(hosts).map(([id, h]) => [id, (momoMethods as any)({ momo: h.home })]));
  const handlers = Object.fromEntries(Object.entries(methods).map(([id, m]: any) => [id, m.handlers]));
  const down = new Set<string>();
  /** Machines that take a call and never answer. */
  const hung = new Set<string>();
  const acts: any[] = [];
  let actFails = '';
  const overrides = new Map<string, (method: string, p: any) => any>();
  const calls: { id: string; method: string; params: any }[] = [];
  // the id the app lists a machine under: a real one has `:` and `@` in it (`ssh:user@host`), which a spec asks for with `ids`
  const ext = (key: string) => (opts.ids ? opts.ids(key) : key);
  const keyOf = (id: string) => (id === ext('studio') ? 'studio' : id === ext('mini') ? 'mini' : id);
  const machines = [record(ext('studio'), A.name, A.homeId), ...(b ? [record(ext('mini'), B.name, B.homeId)] : [])];
  const clock = { at: a.clock.at };
  // what the app keeps across a restart
  const entries: any[] = [];
  let seen = 0;
  let kept: string[] = [];
  let note: any = null;
  const sentKept: any[] = [];
  /** What the Mac can no longer keep (no system key): a write says why. */
  let storageBroken = '';
  const outbox = createMomoOutbox({
    store: {
      read: () => entries.slice(),
      write: (e: any[]) => {
        if (storageBroken) throw new Error(storageBroken);
        entries.splice(0, entries.length, ...e);
      },
    },
    now: () => clock.at,
  });
  /** The clock of the debounce: a timer waits here until a test runs it. */
  const timers: (() => void)[] = [];
  const changed: (() => void)[] = [];
  const asHost = (id: string, method: string, params: any) => {
    // a Host that does not have the method says so as a Host does
    if (typeof handlers[id][method] !== 'function')
      throw Object.assign(new Error(`Unknown request: ${method}`), { code: 'unknown_request' });
    if (!opts.wire) return handlers[id][method](params, 'desktop', { principal: () => ({ fingerprint: 'test-device' }) });
    const principal = { kind: 'desktop', fingerprint: 'test-device' };
    if (!methods[id].veils[method]?.(principal)) throw Object.assign(new Error(`Unknown request: ${method}`), { code: 'unknown_request' });
    return Promise.resolve(handlers[id][method](params, 'desktop', { principal: () => principal })).then((r) =>
      r === undefined ? r : JSON.parse(JSON.stringify(r)),
    );
  };
  const granted: string[] = [];
  let ids = 0;
  /** What the composition told as a failure nobody else is told of, and the waits it gave up. */
  const reports: unknown[] = [];
  const cancelled: unknown[] = [];

  const build = () =>
    createRealHome({
      hosts: {
        machines: () => machines.map((m: any) => ({ ...m, reachable: !down.has(keyOf(m.id)) })),
        call: async (named: string, method: string, params: any = {}) => {
          const id = keyOf(named);
          calls.push({ id, method, params });
          if (down.has(id)) throw new Error('Could not reach the machine.');
          if (hung.has(id)) return new Promise(() => undefined);
          const o = overrides.get(id);
          if (o) {
            const r = o(method, params);
            if (r !== undefined) return r;
          }
          if (method === 'host.momoChat') return { chatId: 'claude:c1', epoch: 1 };
          // the protocol's own parser of every request (shared/host/schema.mjs): what it would refuse as malformed (a chat request with no epoch or key) is refused here
          parseParams(method, params);
          if (method === 'chat.send') {
            // the chat veil's acceptance into the turn ledger, as the Host's guard does it (host/src/momoChats.mjs)
            const h = hosts[id].home;
            const stamp = h.stamp();
            if (!stamp) throw Object.assign(new Error("MoMo's home is not running on this machine."), { code: 'momo_home_away' });
            await h.stores().turns.accept({ turnId: params.key, chatId: params.chatId, deviceId: 'mac', leaseEpoch: stamp.leaseEpoch });
            return { sent: true };
          }
          return asHost(id, method, params);
        },
        heardAt: () => null,
        grant: async (named: string) => {
          const id = keyOf(named);
          granted.push(id);
          if (opts.wire && overrides.get(id)?.('host.momoGrant', {}) === undefined)
            await asHost(id, 'host.momoGrant', { account: 'a1', features: ['momo'] });
        },
        onChange: (fn: () => void) => (changed.push(fn), () => void changed.splice(changed.indexOf(fn), 1)),
        ...(opts.noAct
          ? {}
          : {
              act: async (intent: any) => {
                if (actFails) throw new Error(actFails);
                acts.push(intent);
              },
            }),
      },
      now: () => clock.at,
      seen: { read: () => seen, write: (n: number) => void (seen = n) },
      kept: { read: () => kept.slice(), write: (list: string[]) => void (kept = list) },
      memory: { read: () => note, write: (n: any) => void (note = n) },
      sent: {
        read: () => sentKept.slice(),
        write: (l: any[]) => {
          if (storageBroken) throw new Error(storageBroken);
          sentKept.splice(0, sentKept.length, ...l);
        },
      },
      outbox,
      newId: () => `id-${String(++ids).padStart(6, '0')}`,
      report: (e: unknown) => void reports.push(e),
      schedule: (fn: () => void) => timers.push(fn),
      cancel: (h: unknown) => void cancelled.push(h),
      ...(opts.timeouts ? { timeouts: opts.timeouts } : {}),
      ...(opts.google ? { google: opts.google } : {}),
    });
  let real = build();
  return {
    acts,
    /** The ids the app lists the machines under. */
    ids: { studio: ext('studio'), mini: ext('mini') },
    granted,
    reports,
    cancelled,
    failActs: (why: string) => void (actFails = why),
    a,
    b,
    hosts,
    handlers,
    asHost,
    down,
    hung,
    overrides,
    calls,
    get real() {
      return real;
    },
    /** The app is closed and opened again: the composition is new, what the app kept is not. */
    restart() {
      real.dispose();
      real = build();
      return real;
    },
    outbox,
    entries,
    sentKept,
    breakStorage: (why: string) => void (storageBroken = why),
    clock,
    machines,
    stored: { seen: () => seen, note: () => note, kept: () => kept },
    /** A lease this app saw in its past (a home that is gone now). */
    saw: (stamp: { homeId: string; leaseEpoch: number }) => void (seen = Math.max(seen, stamp.leaseEpoch)),
    /** A newly installed app: nothing of what it kept is there. */
    wipe() {
      seen = 0;
      note = null;
      entries.length = 0;
      sentKept.length = 0;
    },
    /** A machine's row changed (a heartbeat), and what the debounce waits for. */
    fireChange: () => [...changed].forEach((fn) => fn()),
    runTimers: () => {
      const due = timers.splice(0);
      due.forEach((fn) => fn());
      return due.length;
    },
    view: async () => (await real.api.view()).view,
    intent: (i: any): Promise<any> => real.api.intent(i),
  };
}
