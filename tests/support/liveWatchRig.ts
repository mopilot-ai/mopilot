// The phone's net under a followed chat's live events, as a test sees it: scripted reads, a manual clock and timers, and the counters.
import { createFollowFeed } from '../../mobile/src/presentation/followFeed';
import { liveNetCounts } from '../../mobile/src/presentation/liveWatch';

export const snap = (over: object = {}) => ({
  rev: 1,
  feedSeq: 0,
  session: { turn: 'running' },
  itemsShape: 'rows',
  items: [{ id: 'a', role: 'user', text: 'hi' }],
  ...over,
});
/** What the Mac holds after `n` live rows: the rows a phone that got no live events lacks. */
export const grown = (n: number, over: object = {}) =>
  snap({
    rev: 1 + n,
    feedSeq: n,
    items: [{ id: 'a', role: 'user', text: 'hi' }, ...Array.from({ length: n }, (_, i) => ({ id: `r${i}`, role: 'assistant', text: 'x' }))],
    ...over,
  });
export const live = (feedSeq: number) => ({
  ev: 'items.append',
  feedSeq,
  live: true,
  items: [{ id: `i${feedSeq}`, type: 'agentMessage', text: 'x' }],
});

/** A feed with the net on, on scripted reads (a value, an Error or a promise) and a manual clock and timers. */
export const front = { on: true };
export function rig(reads: any[] | (() => any), extra: { watch?: object } = {}) {
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let id = 0;
  let now = 1000;
  let asked = 0;
  const shown: any[] = [];
  let handle: (e: any) => void = () => {};
  let foreground: () => void = () => {};
  let off = 0;
  const feed = createFollowFeed({
    read: () => {
      const next = typeof reads === 'function' ? (asked++, reads()) : reads[Math.min(asked++, reads.length - 1)];
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    },
    subscribe: (h: any) => {
      handle = h;
      return () => {};
    },
    on: { thread: (thread: any, reread: boolean) => shown.push({ thread, reread }), failed: () => {} },
    timers: {
      set: (fn: () => void, ms: number) => {
        timers.push({ at: now + ms, fn, id: ++id });
        return id;
      },
      clear: (t: unknown) => {
        const at = timers.findIndex((x) => x.id === t);
        if (at >= 0) timers.splice(at, 1);
      },
    },
    watch: extra.watch ?? {
      now: () => now,
      visible: () => front.on,
      key: 'c',
      foreground: (fn: () => void) => {
        foreground = fn;
        return () => void off++;
      },
    },
  });
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const tick = async (ms: number) => {
    now += ms;
    for (const t of timers.filter((x) => x.at <= now).sort((a, b) => a.at - b.at)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
    await settle();
  };
  return {
    feed,
    shown,
    settle,
    tick,
    event: (e: any) => handle(e),
    foreground: () => foreground(),
    reads: () => asked,
    timers: () => timers.length,
    offCount: () => off,
  };
}
export const counts = () => ({ ...liveNetCounts() });
export const since = (before: { missed: number; quiet: number }) => {
  const now = liveNetCounts();
  return { missed: now.missed - before.missed, quiet: now.quiet - before.quiet };
};
