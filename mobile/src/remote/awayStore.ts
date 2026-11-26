// Whether the jump arrow shows, as a small store outside the chat screen's render: the reader has scrolled up, and a card that needs an answer marks it.
/** What the jump arrow shows: nothing, the arrow, or the arrow marked because a card needs the person's answer. */
export type ArrowLevel = 'none' | 'away' | 'answer';

/** Whether the jump arrow shows, as a small store: the reader has scrolled up, and a card that needs an answer marks it. */
export type AwayStore = {
  get: () => ArrowLevel;
  subscribe: (listener: () => void) => () => void;
  setAway: (value: boolean) => void;
  setWaiting: (waiting: string) => void;
};
export function createAwayStore(waiting = ''): AwayStore {
  const state = { away: false, waiting };
  const listeners = new Set<() => void>();
  const level = (): ArrowLevel => (!state.away ? 'none' : state.waiting === '' ? 'away' : 'answer');
  const set = (patch: Partial<typeof state>) => {
    const before = level();
    Object.assign(state, patch);
    if (level() !== before) for (const listener of [...listeners]) listener();
  };
  return {
    get: level,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    setAway: (value) => set({ away: value }),
    setWaiting: (value) => set({ waiting: value }),
  };
}
