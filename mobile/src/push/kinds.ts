// The five push kinds and their fixed lock-screen titles, the phone's copy of relay/src/notifier.mjs TITLES.
export type PushKind = 'needsYou' | 'done' | 'momoNeedsYou' | 'machineOffline' | 'cleared';

export const PUSH_TITLES: Readonly<Record<PushKind, string>> = Object.freeze({
  needsYou: 'A chat needs you',
  done: 'A chat finished',
  momoNeedsYou: 'MoMo needs you',
  machineOffline: 'Your Mac went offline',
  cleared: 'A chat no longer needs you',
});

export const isPushKind = (value: unknown): value is PushKind => typeof value === 'string' && Object.hasOwn(PUSH_TITLES, value);

/** "Needs you" kinds alert loudly; "done" and offline notices use the quieter channel. */
export const isUrgent = (kind: PushKind) => kind === 'needsYou' || kind === 'momoNeedsYou';
