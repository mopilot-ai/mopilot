// Effects whose trigger is not everything they read: run on named changes or listen for window events, always with the latest props and state.
import { useEffect, useEffectEvent, useRef } from 'react';

type Cleanup = undefined | (() => void);

/**
 * Runs `effect` after the first render and again whenever one of `triggers` changes (compared with Object.is,
 * like a dependency list), cleaning up the previous run first and on unmount. Unlike a dependency list,
 * `effect` starts with the props and state of the render that triggered it, so a value it reads but that is
 * not a trigger is current when the run starts; it just doesn't make the effect run again. Use it when the
 * trigger is a change the effect doesn't read (a chat switch resets the scroll position, a turn's end
 * refreshes git) or for a run-once setup (`[]`), and list every value a run must follow in `triggers`: the
 * linter cannot check this list. Prefer a plain useEffect whenever its dependencies are what it reads.
 *
 * What the run creates (a listener, a timer, a promise callback) keeps that run's values: read later values
 * through useWindowListener, useEffectEvent or a ref, and recheck the context after every await.
 *
 * The previous run's cleanup runs when the next run starts, among the commit's effects (after the effects declared
 * before it and its children's), not in React's cleanup phase before them; on unmount it runs with the others.
 */
export function useEffectOn(triggers: readonly unknown[], effect: () => Cleanup): void {
  const run = useEffectEvent(effect);
  const last = useRef<{ triggers: readonly unknown[]; cleanup: Cleanup } | null>(null);
  // no dependency list: the triggers are compared here, after every render
  useEffect(() => {
    const previous = last.current;
    if (previous && sameTriggers(previous.triggers, triggers)) return;
    previous?.cleanup?.();
    last.current = { triggers, cleanup: run() };
  });
  useEffect(
    () => () => {
      last.current?.cleanup?.();
      last.current = null;
    },
    [],
  );
}

function sameTriggers(a: readonly unknown[], b: readonly unknown[]) {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

/**
 * Listens for `type` on window while mounted, calling the latest `handler`: a key press answers with what the
 * card shows now, without subscribing again on every render.
 */
export function useWindowListener<K extends keyof WindowEventMap>(type: K, handler: (event: WindowEventMap[K]) => void): void {
  const handle = useEffectEvent(handler);
  useEffect(() => {
    const listener = (event: WindowEventMap[K]) => handle(event);
    window.addEventListener(type, listener);
    return () => window.removeEventListener(type, listener);
  }, [type]);
}
