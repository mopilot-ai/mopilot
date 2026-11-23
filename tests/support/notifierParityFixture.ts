// One sequence of notifications, run against both the Mac's Notifier (electron/platform/notify.cjs) and the relay's push Notifier (relay/src/notifier.mjs): what each shows, merges or suppresses must agree.
/** `relayShown` / `relayCount`: where the relay differs on purpose, because it sends the same kind for the same chat once per REPEAT_MS (the Mac replaces its banner in place instead). */
export type Step = { at: number; chat: string; needs: boolean; shown: boolean; count?: number; relayShown?: boolean; relayCount?: number };

const S = 1000;
const MIN = 60 * S;
export const PARITY_STEPS: Step[] = [
  { at: 0, chat: 'a', needs: false, shown: true, count: 1 },
  // another chat finishing within 60 s merges into "(2)"
  { at: 10 * S, chat: 'b', needs: false, shown: true, count: 2 },
  // the same chat again replaces its own banner on the Mac, still two; the relay does not push the same kind for the same chat twice inside REPEAT_MS,
  // so the repeat does not refresh its merge window either
  { at: 20 * S, chat: 'b', needs: false, shown: true, count: 2, relayShown: false },
  // a third within the window of the last one (the relay's window began at b's first push)
  { at: 70 * S, chat: 'c', needs: false, shown: true, count: 3, relayCount: 1 },
  // a long gap starts a new group
  { at: 5 * MIN, chat: 'd', needs: false, shown: true, count: 1 },
  // "needs you" for a chat outranks its later "done" for ten minutes
  { at: 6 * MIN, chat: 'e', needs: true, shown: true, count: 1 },
  { at: 7 * MIN, chat: 'e', needs: false, shown: false },
  // after the hold, "done" shows again
  { at: 17 * MIN, chat: 'e', needs: false, shown: true, count: 1 },
  // "needs you" for two chats merges separately from "done"
  { at: 18 * MIN, chat: 'f', needs: true, shown: true, count: 1 },
  { at: 18 * MIN + 5 * S, chat: 'g', needs: true, shown: true, count: 2 },
];
