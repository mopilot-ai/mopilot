// The phone's own notification preferences: on/off, sound, a quiet window, titles, Live Activity and the open-chat policy; read tolerantly, applied where the OS lets an app decide.
import { LOCK_SCREENS, type LockScreen } from './channels';

export type PushPrefs = {
  enabled: boolean;
  sound: boolean;
  lockScreen: LockScreen;
  quiet: { on: boolean; from: string; to: string };
  /** The Live Activity switch; only drawn once the activity exists on this build, and off until the person turns it on. */
  liveActivity: boolean;
  /** Whether this phone may show the opened (sealed) chat title on the lock screen; off, every notification keeps its fixed title. */
  titles: boolean;
  /** Do not show a notification for the chat that is open on this phone. */
  skipOpenChat: boolean;
};

export const DEFAULT_PREFS: PushPrefs = Object.freeze({
  enabled: true,
  sound: true,
  lockScreen: 'show',
  quiet: Object.freeze({ on: false, from: '22:00', to: '07:00' }),
  liveActivity: false,
  titles: false,
  skipOpenChat: true,
}) as PushPrefs;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isClock = (value: unknown): value is string => typeof value === 'string' && TIME.test(value);

/** Anything unreadable falls back to the defaults field by field, so a bad store never silences or disables notifications. */
export function parsePrefs(raw: string | null): PushPrefs {
  let value: {
    enabled?: unknown;
    sound?: unknown;
    lockScreen?: unknown;
    quiet?: { on?: unknown; from?: unknown; to?: unknown };
    liveActivity?: unknown;
    titles?: unknown;
    skipOpenChat?: unknown;
  } | null = null;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    value = null;
  }
  const q = value?.quiet;
  return {
    enabled: typeof value?.enabled === 'boolean' ? value.enabled : DEFAULT_PREFS.enabled,
    sound: typeof value?.sound === 'boolean' ? value.sound : DEFAULT_PREFS.sound,
    lockScreen: LOCK_SCREENS.find((l) => l === value?.lockScreen) ?? DEFAULT_PREFS.lockScreen,
    quiet: {
      on: typeof q?.on === 'boolean' ? q.on : DEFAULT_PREFS.quiet.on,
      from: isClock(q?.from) ? q.from : DEFAULT_PREFS.quiet.from,
      to: isClock(q?.to) ? q.to : DEFAULT_PREFS.quiet.to,
    },
    liveActivity: typeof value?.liveActivity === 'boolean' ? value.liveActivity : DEFAULT_PREFS.liveActivity,
    titles: typeof value?.titles === 'boolean' ? value.titles : DEFAULT_PREFS.titles,
    skipOpenChat: typeof value?.skipOpenChat === 'boolean' ? value.skipOpenChat : DEFAULT_PREFS.skipOpenChat,
  };
}

const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));

/** Whether `now` (local time) is inside the window; a window that ends before it starts crosses midnight, equal bounds are empty. */
export function inQuietHours(prefs: PushPrefs, now: Date): boolean {
  if (!prefs.quiet.on) return false;
  const from = minutes(prefs.quiet.from);
  const to = minutes(prefs.quiet.to);
  const at = now.getHours() * 60 + now.getMinutes();
  if (from === to) return false;
  return from < to ? at >= from && at < to : at >= from || at < to;
}

/** Sound on, and not inside the quiet window. */
export const audible = (prefs: PushPrefs, now: Date) => prefs.sound && !inQuietHours(prefs, now);
