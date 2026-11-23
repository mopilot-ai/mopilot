// An Android FCM data message: choose the fixed or the opened sealed title and the channel; the platform layer shows it.
import { openSealedBody, openSealedTitle } from './sealedTitle';
import { PUSH_TITLES } from './kinds';
import { channelFor } from './channels';
import { parsePushPayload, type PushPayload } from './payload';
import { audible, type PushPrefs } from './prefs';

/** `body`: only MoMo's opt-in routine name, opened on this phone; absent otherwise (the notification then has no body, as today). */
export type LocalNotification = {
  id: string;
  title: string;
  body?: string;
  channelId: string;
  data: { kind: string; ref: string; test?: true };
};

type Open = (key: Uint8Array, nonce: Uint8Array, box: Uint8Array, aad: Uint8Array) => Uint8Array | null;

/**
 * The title is the kind's fixed text (with "(n)" when chats merged), made here: the message's own `title` is never shown, since whoever
 * sends the push could put any words on the lock screen. A sealed title replaces it only when this phone's titles switch is on, only for a
 * single chat and only when some stored key opens it; any failure keeps the fixed title, so a data message always produces a notification.
 * MoMo's opt-in body (`sb`) follows the same rules and the same switch: it is opened only with this phone's titles switch on, only for a single MoMo "needs you" and only with a stored key (a key the phone no longer keeps with the switch off), and any failure leaves the notification without a body.
 * Returns null for data that is not one of ours, and for any push while notifications are off in the app's settings. Sound off or
 * quiet hours pick the silent channel: a notification is shown, never dropped.
 */
export async function buildNotification(
  data: unknown,
  o: { keys: () => Promise<Uint8Array[]>; open: Open; prefs: () => Promise<PushPrefs>; now?: () => Date },
): Promise<LocalNotification | null> {
  const payload = parsePushPayload(data);
  if (!payload) return null;
  // a clearing is never shown: it takes the waiting notification away (see withdrawn)
  if (payload.kind === 'cleared') return null;
  const prefs = await o.prefs();
  if (!prefs.enabled) return null;
  const body = prefs.titles ? await sealedBodyOr(payload, o) : null;
  return {
    // one notification per chat handle, so a later push for the same chat replaces the earlier one
    id: `${payload.kind}:${payload.ref}`,
    title: (prefs.titles ? await sealedOr(payload, o) : null) ?? fixedTitle(payload),
    ...(body ? { body } : {}),
    channelId: channelFor(payload.kind, audible(prefs, (o.now ?? (() => new Date()))()), prefs.lockScreen).id,
    data: { kind: payload.kind, ref: payload.ref },
  };
}

/**
 * What a `cleared` data message takes away: the ids of the chat's notifications that this phone drew (its "needs you"), and the payload; null for any other message.
 * Not held back by the notification settings: removing a notification can never surprise anyone.
 */
export function withdrawn(data: unknown): { ids: string[]; payload: PushPayload } | null {
  const payload = parsePushPayload(data);
  return payload?.kind === 'cleared' ? { ids: [`needsYou:${payload.ref}`], payload } : null;
}

/** The relay's fixed title for the kind, with the count when several chats merged into one notification. */
const fixedTitle = ({ kind, count }: PushPayload) => (count > 1 ? `${PUSH_TITLES[kind]} (${count})` : PUSH_TITLES[kind]);

async function sealedOr(payload: PushPayload, o: { keys: () => Promise<Uint8Array[]>; open: Open }) {
  if (!payload.sealedTitle || payload.count > 1) return null;
  try {
    return openSealedTitle({ sealed: payload.sealedTitle, ref: payload.ref, keys: await o.keys(), open: o.open });
  } catch {
    return null;
  }
}

async function sealedBodyOr(payload: PushPayload, o: { keys: () => Promise<Uint8Array[]>; open: Open }) {
  if (!payload.sealedBody || payload.count > 1 || payload.kind !== 'momoNeedsYou') return null;
  try {
    return openSealedBody({ sealed: payload.sealedBody, ref: payload.ref, keys: await o.keys(), open: o.open });
  } catch {
    return null;
  }
}

/** The notification behind the Notifications page's test button: the fixed "needs you" title for no chat, drawn even while the app is open and never routed when tapped. */
export function testNotification(prefs: PushPrefs, now: Date = new Date()): LocalNotification {
  return {
    id: 'test',
    title: PUSH_TITLES.needsYou,
    channelId: channelFor('needsYou', audible(prefs, now), prefs.lockScreen).id,
    data: { kind: 'needsYou', ref: 'test', test: true },
  };
}
