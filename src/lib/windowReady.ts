// Whether this window has told main it is ready (session:ready, sent by boot): main answers a read gated on a known app
// window (the linked sessions, peer messages, a chat's PR monitor) only after that, so such a read made while the window
// starts waits here. An invoke sent after session:ready reaches main after it: one renderer's IPC keeps its order.

// set by the executor below, which runs at once
let mark!: () => void;
let ready = new Promise<void>((resolve) => (mark = resolve));
let isReady = false;

/** Resolves once boot has told main this window is ready (at once after that). */
export function windowReady(): Promise<void> {
  return ready;
}

/** Whether boot has told main this window is ready, for a read that would rather skip than wait (a sidebar badge). */
export function windowIsReady(): boolean {
  return isReady;
}

/** Boot's step after session:ready; Quick Chat, which main knows without it, marks itself ready the same way. */
export function markWindowReady() {
  isReady = true;
  mark();
}

/** Tests: a window that has not told main yet. */
export function resetWindowReady() {
  isReady = false;
  ready = new Promise<void>((resolve) => (mark = resolve));
}
