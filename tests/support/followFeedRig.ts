// The scripted feed the follow-feed tests read from: reads that answer what they are told, a live event to hand in, and timers that only run when the test moves the clock.
const feedPath = '../../mobile/src/presentation/followFeed';
const { createFollowFeed } = await import(feedPath);

export const snap = (over: object = {}) => ({
  rev: 1,
  feedSeq: 0,
  session: { turn: 'idle' },
  itemsShape: 'rows',
  items: [{ id: 'a', role: 'user', text: 'hi' }],
  ...over,
});

/** A feed on scripted reads and manual timers: `reads` is what each read answers (a value, an Error or a promise to settle later). */
export function rig(
  reads: any[],
  extra: {
    accepts?: (e: any, s: any) => boolean;
    foreground?: (fn: () => void) => () => void;
    now?: () => number;
    final?: (message: string) => boolean;
  } = {},
) {
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let id = 0;
  let now = 0;
  const shown: { thread: any; reread: boolean }[] = [];
  const failed: { message: string; quiet: boolean }[] = [];
  let handle: (e: any) => void = () => {};
  let subscribed = 0;
  let unsubscribed = 0;
  let asked = 0;
  const feed = createFollowFeed({
    read: () => {
      const next = reads[asked++];
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    },
    subscribe: (h: any) => {
      handle = h;
      subscribed++;
      return () => {
        unsubscribed++;
      };
    },
    on: {
      thread: (thread: any, reread: boolean) => shown.push({ thread, reread }),
      failed: (message: string, quiet: boolean) => failed.push({ message, quiet }),
    },
    timers: {
      set: (fn: () => void, ms: number) => {
        timers.push({ at: now + ms, fn, id: ++id });
        return id;
      },
      clear: (t: number) => {
        const at = timers.findIndex((x) => x.id === t);
        if (at >= 0) timers.splice(at, 1);
      },
    },
    ...extra,
  });
  /** Moves the clock; whatever is due runs, with the reads it starts settled. */
  const tick = async (ms: number) => {
    now += ms;
    for (const t of timers.filter((x) => x.at <= now).sort((a, b) => a.at - b.at)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
    await settle();
  };
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return {
    feed,
    shown,
    failed,
    event: (e: any) => handle(e),
    tick,
    settle,
    timers: () => timers.length,
    reads: () => asked,
    subscribed: () => subscribed,
    unsubscribed: () => unsubscribed,
  };
}
export const live = (feedSeq: number, extra: object = {}) => ({
  ev: 'items.append',
  feedSeq,
  live: true,
  items: [{ id: `i${feedSeq}`, type: 'agentMessage', text: 'x' }],
  ...extra,
});
