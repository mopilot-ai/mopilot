// Harness versions and updates as this window sees them: main's state (every window shares it), and the calls that
// check, update and update all. Nothing here asks which harness it is.
import { create } from 'zustand';
import { native } from '../lib/native';
import { ignoring } from '../lib/ignored';
import type { HarnessUpdatesState, HarnessVersionInfo } from '../lib/native/harnessUpdates';

export type { HarnessUpdatesState, HarnessVersionInfo };

export const useHarnessUpdates = create<HarnessUpdatesState>(() => ({ harnesses: [], all: null, checkedAt: null, checking: false }));

/** main's answer, when it is one (anything else keeps what the window has) */
const take = (s: HarnessUpdatesState) => {
  if (s && Array.isArray(s.harnesses)) useHarnessUpdates.setState(s);
};

/** Follow main's state; its answer and pushes come over one ordered channel, so the last one is newest. */
export function followHarnessUpdates() {
  native.harnessUpdates.onState(take);
  native.harnessUpdates.state().then(take, ignoring('read the harness versions'));
}

/** Read every installed harness again (Settings opening, Check for updates). */
export function checkHarnessUpdates(force = false) {
  return native.harnessUpdates.check(force).then(take, ignoring('check for harness updates'));
}

/** The installed harness's version and update, or null when main has none for it. */
export const useVersionOf = (kind: string) => useHarnessUpdates((s) => s.harnesses.find((h) => h.harness === kind) ?? null);

/** How many harnesses have an update to offer. */
export const updatableCount = (s: HarnessUpdatesState) => s.harnesses.filter((h) => h.updatable).length;
