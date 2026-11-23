// A session store with a turn per chat, a clock, timers that run when the test says, and a remote that records snapshots: the rig of the Live Activity bridge's tests.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tick } from './async-scenarios.ts';

const require = createRequire(import.meta.url);
const { createActivityBridge } = require('../../electron/remote/activityBridge.cjs');

/** A session store with a turn per chat, a clock, timers that run when the test says, and a remote that records snapshots. */
export function rig(o: { pairs?: string[]; status?: string; reject?: boolean; titles?: Record<string, string>; seal?: boolean } = {}) {
  const turns = new Map<string, string>();
  const owned = new Set<string>();
  let clock = 1_900_000_000_000;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const sent: any[] = [];
  const remote: any = {
    devices: { list: () => (o.pairs ?? ['p_one', 'p_one', 'p_two']).map((pairId) => ({ pairId })) },
    pushTitles: o.seal ? { seal: (pair: string, ref: string, title: string) => `S(${pair},${ref},${title})` } : null,
    activityUpdate: (req: any) => {
      sent.push(req);
      return o.reject ? Promise.reject(new Error('relay down')) : Promise.resolve(o.status ?? 'sent');
    },
  };
  let live: any = remote;
  const bridge = createActivityBridge({
    state: { all: () => [...turns.keys()], get: (id: string) => ({ turn: turns.get(id) }) },
    owns: (id: string) => owned.has(id),
    titleOf: (id: string) => o.titles?.[id] ?? null,
    remote: () => live,
    now: () => clock,
    setTimer: (fn: () => void, ms: number) => (timers.set(next, { fn, ms }), next++),
    clearTimer: (t: number) => void timers.delete(t),
  });
  const chat = (id: string, turn: string, own = true) => {
    turns.set(id, turn);
    if (own) owned.add(id);
  };
  return {
    bridge,
    sent,
    timers,
    chat,
    end: (id: string) => turns.set(id, 'idle'),
    advance: (ms: number) => (clock += ms),
    setRemote: (r: any) => (live = r),
    /** Runs the timer with this delay. */
    fire: async (ms: number) => {
      const [id, t] = [...timers].find(([, v]) => v.ms === ms) ?? [];
      assert.ok(t, `a timer of ${ms} ms`);
      timers.delete(id!);
      t.fn();
      await tick();
    },
  };
}
