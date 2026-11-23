// Which harnesses a launch brings up, and which count toward opening the app (D-66, D-42).
import type { BasicHarness } from './types';
import type { HarnessKind } from './adapter';

/**
 * Codex's app-server starts with the app only for someone who relies on it: it is the default, or it
 * has been used on this machine. Otherwise it starts on first use.
 */
export const codexWantedAtLaunch = (savedDefault: HarnessKind, usedBefore: boolean) => savedDefault === 'codex' || usedBefore;

/** Basic harnesses that passed admission and can run a chat. */
export const admittedBasics = (list: BasicHarness[]) => list.filter((h) => h.state === 'admitted');
/** The basic harnesses installed here, usable or not: everything Settings and the profile menu list. */
export const installedBasics = (list: readonly BasicHarness[]) => list.filter((h) => h.state !== 'missing');
