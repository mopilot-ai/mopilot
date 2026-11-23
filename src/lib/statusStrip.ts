// The two places around the composer (design: position budget). One status strip shows one thing at a
// time, and one chip slot carries the "next message" notice; whatever loses goes to the task panel
// or waits its turn.

export type StripItem = 'computer' | 'nativeCleanup' | 'approval' | 'chromeApproval' | 'appControl' | 'chromeLink' | 'tasks';

/**
 * Priority: controlling the computer > Codex's own computer use releasing control > waiting for
 * approval > waiting for the user to approve Your Chrome's connection in Chrome > working in an app in
 * the background > Claude in Chrome disconnected > the Stop all question. The goal is not a strip: it has its pill
 * above the composer (ComposerPills).
 */
const STRIP_ORDER: StripItem[] = ['computer', 'nativeCleanup', 'approval', 'chromeApproval', 'appControl', 'chromeLink', 'tasks'];

export function pickStrip(on: Partial<Record<StripItem, boolean>>): StripItem | null {
  return STRIP_ORDER.find((k) => on[k]) ?? null;
}

/**
 * Claude in Chrome disconnected is the chat's strip only while the plan of its current segment says Claude in Chrome
 * controls the user's Chrome, whatever an earlier segment's session last reported.
 */
export const chromeLinkDropped = (s: { chromeLink: { dropped: boolean } | null; controllerPlan: { bu: string | null } | null }) =>
  s.chromeLink?.dropped === true && s.controllerPlan?.bu === 'claude-in-chrome';

export type ChipItem = 'switch' | 'cloud';

/** One chip at a time: a pending harness switch (existing chat) before a Cloud new chat. */
const CHIP_ORDER: ChipItem[] = ['switch', 'cloud'];

export function pickChip(on: Partial<Record<ChipItem, boolean>>): ChipItem | null {
  return CHIP_ORDER.find((k) => on[k]) ?? null;
}
