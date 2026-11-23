// Content-free marks on the window's launch timeline (boot steps, each harness's chat list, the sidebar's first frame), read by tests/e2e/perf-sidebar-launch.spec.ts and DevTools; a name and a count, never a chat's title or path.

import { noteIgnored } from './ignored';

/** The mark's name with the app's prefix, so a reader can pick the launch marks out of performance.getEntries(). */
export const LAUNCH_PREFIX = 'mopilot:';

const seen = new Set<string>();

/** Mark `name` on the window's timeline (`count` as its detail, e.g. how many chats a list returned); a name already marked is left as it was when `once`. */
export function launchMark(name: string, count?: number, once = false) {
  if (once) {
    if (seen.has(name)) return;
    seen.add(name);
  }
  try {
    performance.mark(`${LAUNCH_PREFIX}${name}`, count === undefined ? undefined : { detail: count });
  } catch (error) {
    // a timeline that cannot take a mark loses only the measurement
    noteIgnored('mark the launch timeline', error);
  }
}

/** Tests: marks made again from a fresh window. */
export function resetLaunchMarks() {
  seen.clear();
}
