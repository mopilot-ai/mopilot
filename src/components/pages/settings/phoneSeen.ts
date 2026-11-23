// A paired phone's Settings line: shared connection health, last activity in plain words and its pairing date.
import { PHONE_CONNECTION_LABEL, type PhoneConnection } from '../../../../shared/phoneConnections.mjs';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Midnight before `at`, local time. */
const dayStart = (at: number) => new Date(at).setHours(0, 0, 0, 0);

const shortDate = (at: number, now: number) => {
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
};

/** "Online", "Last seen just now / 5 min ago / 3 hr ago / yesterday / 4 days ago / Oct 3", or null when it was never seen. */
export function phoneSeen(device: { online: boolean; lastSeenAt: number | null }, now: number): string | null {
  if (device.online) return 'Online';
  const at = device.lastSeenAt;
  if (at === null) return null;
  const ago = Math.max(0, now - at);
  if (ago < MINUTE) return 'Last seen just now';
  if (ago < HOUR) return `Last seen ${Math.floor(ago / MINUTE)} min ago`;
  const days = Math.round((dayStart(now) - dayStart(at)) / DAY);
  if (days <= 0) return `Last seen ${Math.floor(ago / HOUR)} hr ago`;
  if (days === 1) return 'Last seen yesterday';
  if (days < 7) return `Last seen ${days} days ago`;
  return `Last seen ${shortDate(at, now)}`;
}

/** The presence line and the day it was paired. */
export function phoneLine(
  device: { connection: PhoneConnection; online: boolean; lastSeenAt: number | null; pairedAt: number },
  now: number,
): string {
  const paired = `Paired ${shortDate(device.pairedAt, now)}`;
  const seen = device.online ? null : phoneSeen(device, now);
  return [PHONE_CONNECTION_LABEL[device.connection], seen, paired].filter(Boolean).join(' · ');
}
