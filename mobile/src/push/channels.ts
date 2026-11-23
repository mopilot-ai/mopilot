// Android notification channels: loud and silent variants of "needs you" and of the quieter "done" and offline notices, per lock-screen choice.
import { isUrgent, type PushKind } from './kinds';

/** `show`: the title on the lock screen; `private`: only that a notification exists; `hide`: nothing until unlocked. */
export type LockScreen = 'show' | 'private' | 'hide';
export const LOCK_SCREENS: readonly LockScreen[] = ['show', 'private', 'hide'];

const SUFFIX: Record<LockScreen, string> = { show: '', private: '-private', hide: '-hide' };
const LABEL: Record<LockScreen, string> = { show: '', private: ' (details hidden)', hide: ' (hidden)' };

const BASE = [
  {
    key: 'needsYou',
    id: 'needs-you',
    name: 'Needs you',
    description: 'A chat is waiting for an approval or an answer.',
    importance: 'high',
    silent: false,
  },
  {
    key: 'needsYouSilent',
    id: 'needs-you-silent',
    name: 'Needs you (silent)',
    description: 'The same notices without sound, in quiet hours or with sound off.',
    importance: 'default',
    silent: true,
  },
  {
    key: 'done',
    id: 'done',
    name: 'Finished',
    description: 'A chat finished or your computer went offline.',
    importance: 'default',
    silent: false,
  },
  {
    key: 'doneSilent',
    id: 'done-silent',
    name: 'Finished (silent)',
    description: 'The same notices without sound, in quiet hours or with sound off.',
    importance: 'low',
    silent: true,
  },
] as const;

/** The four channels of one lock-screen choice. Android fixes a channel's lock-screen behaviour when it is created, so each choice has its own ids. */
export const channelSpecs = (lock: LockScreen) => BASE.map((c) => ({ ...c, id: c.id + SUFFIX[lock], name: c.name + LABEL[lock], lock }));

/** Every channel id the app can have created, for removing the ones a changed choice no longer uses. */
export const channelIdsExcept = (lock: LockScreen) =>
  LOCK_SCREENS.filter((l) => l !== lock).flatMap((l) => channelSpecs(l).map((c) => c.id));

/** The default (`show`) channels, by name. */
export const CHANNELS = Object.freeze(
  Object.fromEntries(channelSpecs('show').map((c) => [c.key, c])) as Record<
    (typeof BASE)[number]['key'],
    ReturnType<typeof channelSpecs>[number]
  >,
);

export const channelFor = (kind: PushKind, audible = true, lock: LockScreen = 'show') => {
  const key = isUrgent(kind) ? (audible ? 'needsYou' : 'needsYouSilent') : audible ? 'done' : 'doneSilent';
  return channelSpecs(lock).find((c) => c.key === key) as ReturnType<typeof channelSpecs>[number];
};

/** The channel the manifest names for a notification the system shows itself (the relay's fixed-title push). It never changes with the lock-screen choice and is never deleted. */
export const SYSTEM_CHANNEL = Object.freeze({
  id: 'system',
  name: 'Notifications',
  description: 'Notices your computer sends while the app is closed.',
  importance: 'default',
} as const);
