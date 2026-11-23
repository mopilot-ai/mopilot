// Draft ownership survives chat navigation and only clears the exact text accepted by the computer.
import { withQuote } from '../replyContext';

export type Drafts = Record<string, string>;
export const draftKey = (account: string | undefined, pair: string | null, chat: string) => JSON.stringify([account, pair, chat]);
export const writeDraft = (drafts: Drafts, key: string, text: string): Drafts => ({ ...drafts, [key]: text });
export const clearAcceptedDraft = (drafts: Drafts, key: string, text: string): Drafts =>
  drafts[key] === text ? writeDraft(drafts, key, '') : drafts;

/** One draft as the screens that edit it see it: read and written without the app root holding the text, so a key typed re-renders only what shows it. */
export type DraftHandle = {
  get: () => string;
  set: (text: string) => void;
  /** Empties the draft only if it still holds `expected` (what the computer accepted): words typed since stay. */
  clear: (expected: string) => void;
  /** Called after every change to this draft; returns the way to stop. */
  subscribe: (listener: () => void) => () => void;
  /** Asks the composer to take the keyboard (an Ask put words in it); `focusTick` counts the asks, and `subscribe` is called for each. Absent in a handle that has no composer to ask. */
  focus?: () => void;
  focusTick?: () => number;
};

/** The drafts of every chat, kept for the app's lifetime outside the React tree: a handle per key, stable, so a screen that gets one as a prop is not re-rendered by a key typed anywhere. */
export function createDraftStore() {
  let drafts: Drafts = {};
  const listeners = new Map<string, Set<() => void>>();
  const handles = new Map<string, DraftHandle>();
  const ticks = new Map<string, number>();
  const changed = (key: string) => {
    for (const listener of [...(listeners.get(key) ?? [])]) listener();
  };
  return {
    of(key: string): DraftHandle {
      let handle = handles.get(key);
      if (!handle) {
        handle = {
          get: () => drafts[key] ?? '',
          set(text) {
            if ((drafts[key] ?? '') === text) return;
            drafts = writeDraft(drafts, key, text);
            changed(key);
          },
          clear(expected) {
            const next = clearAcceptedDraft(drafts, key, expected);
            if (next === drafts) return;
            drafts = next;
            changed(key);
          },
          focus() {
            ticks.set(key, (ticks.get(key) ?? 0) + 1);
            changed(key);
          },
          focusTick: () => ticks.get(key) ?? 0,
          subscribe(listener) {
            const set = listeners.get(key) ?? new Set();
            listeners.set(key, set);
            set.add(listener);
            return () => void set.delete(listener);
          },
        };
        handles.set(key, handle);
      }
      return handle;
    },
  };
}

/** What a chat opened from another gets in its composer: the selected words quoted under what it already holds (a side chat asked for again is the same one), nothing for no words. */
export const startDraft = (handle: DraftHandle, selected?: string) => {
  if (selected) handle.set(withQuote(handle.get(), selected));
};
