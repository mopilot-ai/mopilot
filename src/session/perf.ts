// The streaming performance probe in a window (docs/performance/measurement.md): store commits per thread, long tasks, frame intervals, first-token latency, reveal steps and React commit time, sent to main's probe once a second while shared.perf.probe is on.
import type { ProfilerOnRenderCallback } from 'react';
import type { AppState } from '../store/state';
import type { TurnState } from '../store/types';
import { focusedChat, visibleChats } from '../store/split';

/** How often a window sends its samples to main. */
export const FLUSH_MS = 1000;
/** Samples a window holds between sends; past this they are dropped and counted. */
export const MAX_PENDING = 5000;
/** First-token turns remembered, so a turn is measured once. */
const SEEN_TURNS = 500;

/** A Long Animation Frame, with the script that took longest in it. */
export type LongFrame = {
  ms: number;
  blocking: number;
  script: { url: string; fn: string; invoker: string; ms: number } | null;
};
/** An input event that took at least SLOW_EVENT_MS to respond to. */
export type SlowEvent = { name: string; ms: number; delay: number; processing: number };

/** Input events slower than this are sampled (keydown, input and pointer events). */
export const SLOW_EVENT_MS = 100;
/** A renderer task this long counts as a stall in the always-on counter. */
export const STALL_MS = 200;

export type PerfSample = { t: number; kind: string } & Record<string, unknown>;

type Store = {
  getState(): AppState;
  subscribe(listener: (state: AppState, prev: AppState) => void): () => void;
};

export interface PerfDeps {
  store: Store;
  send(batch: PerfSample[]): void;
  /** wall clock for the samples' `t` */
  now(): number;
  /** a monotonic clock in ms (performance.now) */
  clock(): number;
  raf(cb: (ts: number) => void): number;
  cancelRaf(id: number): void;
  setInterval(cb: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  /** watches long tasks; returns the stop, or null where the browser has no longtask entries */
  observeLongTasks(cb: (ms: number) => void): (() => void) | null;
  /** watches Long Animation Frame entries (Chromium); null where the browser has none */
  observeLongFrames?(cb: (frame: LongFrame) => void): (() => void) | null;
  /** watches slow input events (Event Timing); null where the browser has none */
  observeSlowEvents?(cb: (event: SlowEvent) => void): (() => void) | null;
  /** the window's first contentful paint, from the buffered paint entries; null where the browser has none */
  observeFirstPaint?(cb: (startTime: number) => void): (() => void) | null;
  /** the wall-clock time the window's clock counts from (performance.timeOrigin), for its startup marks */
  timeOrigin?(): number;
  visible(): boolean;
  focused(): boolean;
  /** calls back when the window is hidden (frames stop until it is shown); returns the unsubscribe */
  onHidden(cb: () => void): () => void;
}

/** The reply text of a turn: its last agent message. */
function replyText(turn: TurnState | undefined): string {
  const items = turn?.items ?? [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i] as { type?: string; text?: unknown };
    if (it.type === 'agentMessage') return typeof it.text === 'string' ? it.text : '';
  }
  return '';
}

/** The turn a thread is streaming: its active turn, else its last turn while that one runs. */
function streamingTurn(turns: TurnState[], activeTurnId: string | null): TurnState | undefined {
  const active = activeTurnId ? turns.find((t) => t.id === activeTurnId) : undefined;
  if (active) return active;
  const last = turns.at(-1);
  return last?.status === 'inProgress' ? last : undefined;
}

/** What the user would have been looking at: the window's state and the open thread's size. */
function context(deps: PerfDeps) {
  const s = deps.store.getState();
  const id = focusedChat(s);
  const rt = id ? s.runtime[id] : undefined;
  return {
    visible: deps.visible(),
    focused: deps.focused(),
    turns: rt?.turns.length ?? 0,
    streaming: rt ? replyText(streamingTurn(rt.turns, rt.activeTurnId)).length : 0,
  };
}

/** Starts a probe over `deps`; returns its stop, which sends what it holds. */
export function startPerfProbe(deps: PerfDeps): () => void {
  let pending: PerfSample[] = [];
  let dropped = 0;
  let reportedStalls = rendererStalls.count;
  const commits = new Map<string, number>();
  const seen = new Set<string>();
  /** first deltas waiting for the frame that paints them: thread → when the delta was committed */
  const firstDeltas = new Map<string, number>();
  const push = (s: Record<string, unknown> & { kind: string }) => {
    if (pending.length >= MAX_PENDING) dropped++;
    else pending.push({ t: deps.now(), ...context(deps), ...s });
  };

  // the startup timeline's window marks (electron/perf/startup.cjs): sent as wall-clock time, which main puts on its own
  const mark = (name: string, at: number) => push({ kind: 'mark', name, at: Math.round(at * 100) / 100 });
  const origin = deps.timeOrigin;
  const stopPaint = origin ? (deps.observeFirstPaint?.((startTime) => mark('firstPaint', origin() + startTime)) ?? null) : null;
  /** whether a chat on screen has loaded its history yet: the first chat interactive */
  let interactive = !origin;
  const checkInteractive = (state: AppState) => {
    if (interactive || !visibleChats(state).some((id) => state.runtime[id]?.loaded)) return;
    interactive = true;
    if (origin) mark('chatInteractive', origin() + deps.clock());
  };
  checkInteractive(deps.store.getState());

  const unsubscribe = deps.store.subscribe((state, prev) => {
    checkInteractive(state);
    if (state.runtime === prev.runtime) return;
    for (const [id, rt] of Object.entries(state.runtime)) {
      if (rt === prev.runtime[id]) continue;
      commits.set(id, (commits.get(id) ?? 0) + 1);
      // a first token is painted only in a window on screen with a pane showing that chat
      const shown = deps.visible() && visibleChats(state).includes(id);
      const turn = streamingTurn(rt.turns, rt.activeTurnId);
      if (!shown || !turn || seen.has(turn.id) || !replyText(turn)) continue;
      seen.add(turn.id);
      if (seen.size > SEEN_TURNS) seen.delete(seen.values().next().value as string);
      firstDeltas.set(id, deps.clock());
    }
  });

  let last: number | null = null;
  let frame = 0;
  const onFrame = (ts: number) => {
    if (last !== null) push({ kind: 'frame', ms: Math.round((ts - last) * 100) / 100 });
    last = ts;
    const at = deps.clock();
    for (const [chat, since] of firstDeltas) push({ kind: 'firstToken', chat, ms: Math.round((at - since) * 100) / 100 });
    firstDeltas.clear();
    frame = deps.raf(onFrame);
  };
  frame = deps.raf(onFrame);
  // no frames while hidden: the first one after is not an interval
  const offHidden = deps.onHidden(() => {
    last = null;
  });

  const stopLongTasks = deps.observeLongTasks((ms) => push({ kind: 'longtask', ms }));
  const stopLongFrames = deps.observeLongFrames?.((f) => push({ kind: 'loaf', ...f })) ?? null;
  const stopEvents = deps.observeSlowEvents?.((e) => push({ kind: 'event', ...e })) ?? null;

  const flush = () => {
    for (const [thread, count] of commits) push({ kind: 'commit', thread, count });
    commits.clear();
    // the always-on counter, reported when it moved since the last send
    if (rendererStalls.count !== reportedStalls) {
      reportedStalls = rendererStalls.count;
      push({ kind: 'stalls', count: rendererStalls.count, maxMs: rendererStalls.maxMs });
    }
    if (dropped) pending.push({ t: deps.now(), kind: 'dropped', count: dropped });
    dropped = 0;
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    deps.send(batch);
  };
  const timer = deps.setInterval(flush, FLUSH_MS);

  active = push;
  return () => {
    if (active === push) active = null;
    unsubscribe();
    deps.cancelRaf(frame);
    offHidden();
    stopLongTasks?.();
    stopLongFrames?.();
    stopEvents?.();
    stopPaint?.();
    deps.clearInterval(timer);
    flush();
  };
}

/** The running probe's sample sink, for the React profiler. */
let active: ((s: Record<string, unknown> & { kind: string }) => void) | null = null;

/** A streaming reply showed `chars` more characters (arrival.tsx): the cadence the reader sees. */
export function noteReveal(chars: number) {
  active?.({ kind: 'reveal', chars });
}

/** A sidebar badge started reading its chat's pull request, and what made it (the effect's changed inputs, or the shared poll). */
export function noteBadgeRead(trigger: string) {
  active?.({ kind: 'badgeRead', trigger });
}

/** The <Profiler> callback: React reports commit times in development builds only. */
export const reactCommit: ProfilerOnRenderCallback = (id, _phase, actualDuration) => {
  active?.({ kind: 'react', ms: Math.round(actualDuration * 100) / 100, components: id });
};

/** Long tasks through PerformanceObserver, where the browser reports them. */
export function observeLongTasks(cb: (ms: number) => void, Observer = globalThis.PerformanceObserver): (() => void) | null {
  if (!Observer?.supportedEntryTypes?.includes('longtask')) return null;
  const o = new Observer((list) => {
    for (const e of list.getEntries()) cb(Math.round(e.duration * 100) / 100);
  });
  o.observe({ type: 'longtask' });
  return () => o.disconnect();
}

/** The window's first contentful paint (its time on the window's clock), once, from the buffered paint entries. */
export function observeFirstPaint(cb: (startTime: number) => void, Observer = globalThis.PerformanceObserver): (() => void) | null {
  if (!Observer?.supportedEntryTypes?.includes('paint')) return null;
  let seen = false;
  const o = new Observer((list) => {
    for (const e of list.getEntries())
      if (!seen && e.name === 'first-contentful-paint') {
        seen = true;
        cb(e.startTime);
      }
  });
  o.observe({ type: 'paint', buffered: true });
  return () => o.disconnect();
}

/** Long Animation Frames, each with its longest script (url, function, invoker), where the browser reports them. */
export function observeLongFrames(cb: (frame: LongFrame) => void, Observer = globalThis.PerformanceObserver): (() => void) | null {
  if (!Observer?.supportedEntryTypes?.includes('long-animation-frame')) return null;
  const round = (n: number) => Math.round(n * 100) / 100;
  const o = new Observer((list) => {
    for (const e of list.getEntries() as unknown as {
      duration: number;
      blockingDuration?: number;
      scripts?: { duration: number; sourceURL?: string; sourceFunctionName?: string; invoker?: string }[];
    }[]) {
      let top: NonNullable<(typeof e)['scripts']>[number] | null = null;
      for (const s of e.scripts ?? []) if (!top || s.duration > top.duration) top = s;
      cb({
        ms: round(e.duration),
        blocking: round(e.blockingDuration ?? 0),
        script: top
          ? { url: top.sourceURL ?? '', fn: top.sourceFunctionName ?? '', invoker: top.invoker ?? '', ms: round(top.duration) }
          : null,
      });
    }
  });
  o.observe({ type: 'long-animation-frame', buffered: false });
  return () => o.disconnect();
}

const INPUT_EVENT = /^(keydown|input|pointer[a-z]*)$/;

/** Input events (keydown, input, pointer*) that took SLOW_EVENT_MS or more, through Event Timing. */
export function observeSlowEvents(cb: (event: SlowEvent) => void, Observer = globalThis.PerformanceObserver): (() => void) | null {
  if (!Observer?.supportedEntryTypes?.includes('event')) return null;
  const o = new Observer((list) => {
    for (const e of list.getEntries() as unknown as {
      name: string;
      duration: number;
      startTime: number;
      processingStart: number;
      processingEnd: number;
    }[]) {
      if (!INPUT_EVENT.test(e.name) || e.duration < SLOW_EVENT_MS) continue;
      cb({
        name: e.name,
        ms: Math.round(e.duration),
        delay: Math.round(e.processingStart - e.startTime),
        processing: Math.round(e.processingEnd - e.processingStart),
      });
    }
  });
  o.observe({ type: 'event', durationThreshold: SLOW_EVENT_MS } as PerformanceObserverInit);
  return () => o.disconnect();
}

/** The always-on renderer stall counter: tasks of STALL_MS or more since the window started. */
export const rendererStalls = { count: 0, maxMs: 0 };

/** Counts long tasks of STALL_MS or more; cheap and local, so it runs whether or not the probe is on. */
export function countRendererStalls(Observer = globalThis.PerformanceObserver): (() => void) | null {
  return observeLongTasks((ms) => {
    if (ms < STALL_MS) return;
    rendererStalls.count++;
    rendererStalls.maxMs = Math.max(rendererStalls.maxMs, ms);
  }, Observer);
}

type Flags = { isEnabled(key: string): boolean; onChanged(cb: () => void): () => void };

/**
 * Runs the probe while the shared.perf.probe switch is on, starting and stopping it as the switch changes.
 * @returns the unsubscribe from the switch, which also stops a running probe
 */
export function followPerfFlag(flags: Flags, deps: () => PerfDeps): () => void {
  let stop: (() => void) | null = null;
  const sync = () => {
    const on = flags.isEnabled('shared.perf.probe');
    if (on && !stop) stop = startPerfProbe(deps());
    else if (!on && stop) {
      stop();
      stop = null;
    }
  };
  sync();
  const off = flags.onChanged(sync);
  return () => {
    off();
    stop?.();
    stop = null;
  };
}

type PerfNative = { flags: Flags; perf: { samples(batch: PerfSample[]): void } };

/** Follows the switch in this window, with the browser's clocks, frames and long tasks; returns the unsubscribe. */
export function installPerfProbe(native: PerfNative, store: Store, win: Window = window): () => void {
  const observer = (win as unknown as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
  const stopStalls = countRendererStalls(observer);
  const stopFlag = followPerfFlag(native.flags, () => ({
    store,
    send: (batch) => native.perf.samples(batch),
    now: Date.now,
    clock: () => win.performance.now(),
    raf: (cb) => win.requestAnimationFrame(cb),
    cancelRaf: (id) => win.cancelAnimationFrame(id),
    setInterval: (cb, ms) => win.setInterval(cb, ms),
    clearInterval: (id) => win.clearInterval(id as number),
    observeLongTasks: (cb) => observeLongTasks(cb, observer),
    observeLongFrames: (cb) => observeLongFrames(cb, observer),
    observeSlowEvents: (cb) => observeSlowEvents(cb, observer),
    observeFirstPaint: (cb) => observeFirstPaint(cb, observer),
    timeOrigin: () => win.performance.timeOrigin,
    visible: () => win.document.visibilityState === 'visible',
    focused: () => win.document.hasFocus(),
    onHidden: (cb) => {
      const on = () => {
        if (win.document.visibilityState !== 'visible') cb();
      };
      win.document.addEventListener('visibilitychange', on);
      return () => win.document.removeEventListener('visibilitychange', on);
    },
  }));
  return () => {
    stopFlag();
    stopStalls?.();
  };
}
