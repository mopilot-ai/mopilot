// The streaming-text tests' window: happy-dom globals, a clock for setTimeout and performance.now, motion and visibility switches, and a reply probe over useSmoothText.
import { after } from 'node:test';
import { Window } from 'happy-dom';
export const window = new Window();
for (const name of ['window', 'document', 'Node', 'HTMLElement'])
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : (window as any)[name] });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// The reveal steps on setTimeout and reads performance.now: both run on this test's clock.
export const clock = { now: 0 };
let nextTimer = 0;
export const timers = new Map<number, { at: number; cb: () => void }>();
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
(globalThis as any).setTimeout = (cb: () => void, ms = 0) => {
  timers.set(++nextTimer, { at: clock.now + ms, cb });
  return nextTimer;
};
(globalThis as any).clearTimeout = (id: number) => timers.delete(id);
const originalPerformance = globalThis.performance;
Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => clock.now } });
export const media = new window.EventTarget() as any;
media.matches = false;
(window as any).matchMedia = () => media;
export const { createElement, act } = await import('react');
export const { createRoot } = await import('react-dom/client');
export const { ArrivalContext, Enter, Reveal, useArrived, useSmoothText } = await import('../../src/components/thread/arrival.tsx');
export const { PACE } = await import('../../src/lib/textPacer.ts');
const { useStore } = await import('../../src/store/core.ts');
let visibility: 'visible' | 'hidden' = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
export async function setVisibility(next: 'visible' | 'hidden') {
  visibility = next;
  await act(() => document.dispatchEvent(new window.Event('visibilitychange') as any));
}
export const setFocused = (focused: boolean) => act(() => useStore.setState({ focused }));
function Probe({ id, text, running = true, arriving = true }: any) {
  const value = useSmoothText(id, text, arriving, running);
  return createElement(
    'div',
    {
      'data-animate': String(value.animate),
      'data-streaming': String(value.streaming),
      'data-steps': value.steps.join(','),
      'data-step-times': value.stepTimes.join(','),
    },
    value.text,
  );
}
function DefaultProbe({ id, text, running }: any) {
  const value = useSmoothText(id, text, running);
  return createElement('div', { 'data-animate': String(value.animate) }, value.text);
}
export async function mount(
  id: string,
  text: string,
  options: { ready?: boolean; arriving?: boolean; defaultStreaming?: boolean; scope?: string; turn?: string } = {},
) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const update = async (text: string, running = true) =>
    act(() =>
      root.render(
        createElement(
          ArrivalContext.Provider,
          { value: { ready: options.ready ?? true, scope: options.scope, turn: options.turn } },
          createElement(options.defaultStreaming ? DefaultProbe : Probe, { id, text, running, arriving: options.arriving }),
        ),
      ),
    );
  await update(text);
  return {
    host,
    update,
    close: async () => {
      await act(() => root.unmount());
      host.remove();
    },
  };
}
/** Move the clock to `ms`, running every timer that comes due on the way, in order. */
export async function tick(ms: number) {
  await act(() => {
    for (;;) {
      let due: [number, { at: number; cb: () => void }] | undefined;
      for (const entry of timers) if (entry[1].at <= ms && (!due || entry[1].at < due[1].at)) due = entry;
      if (!due) break;
      timers.delete(due[0]);
      clock.now = Math.max(clock.now, due[1].at);
      due[1].cb();
    }
    clock.now = Math.max(clock.now, ms);
  });
}
/** Run the clock on in `step` ms ticks until `ms`. */
export async function run(ms: number, step = 25) {
  for (let t = clock.now + step; t <= ms; t += step) await tick(t);
}

after(() => {
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: originalPerformance });
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  window.happyDOM.abort();
});

export const LONG = '流式回复 with emoji 👩🏽‍💻 and flags 🇫🇷 keeps going. '.repeat(20);
