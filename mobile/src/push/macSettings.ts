// The Mac's notification settings as the phone reads and changes them (push.settings.get / .set): defensive reads, patches checked the way the Mac checks them.
import { PUSH_SETTINGS } from '../../../shared/remote/pushSettings.mjs';
import { Unavailable, bad, rec, type Owned } from '../remote/client';

export type NotifyMode = 'unfocused' | 'always' | 'needed' | 'never';
export type QuietHours = { start: string; end: string };
export type MacPushSettings = {
  titlesInPush: boolean;
  mode: NotifyMode;
  kinds: Record<string, boolean>;
  /** The Mac's quiet hours for notifications; undefined: an older Mac that has none (the row is absent, not faked). */
  quietHours: QuietHours | null | undefined;
  /** MoMo's quiet hours; undefined when MoMo is not on for this account (the Mac sends none, an older Mac says so in machine.hello): no row. */
  momoQuietHours: QuietHours | null | undefined;
  /** Whether this Mac says MoMo is on for its account (machine.hello capabilities.momo). */
  momo: boolean;
};
export type MacPushPatch = Partial<{
  titlesInPush: boolean;
  mode: NotifyMode;
  kinds: Record<string, boolean>;
  quietHours: QuietHours | null;
  momoQuietHours: QuietHours | null;
}>;

export const MODES = PUSH_SETTINGS.mode.values as readonly NotifyMode[];
// MoMo is not a kind a phone lists: the Mac's own Settings does not either
export const KINDS = PUSH_SETTINGS.kinds.values.filter((k) => k !== 'momo');
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isClock = (v: unknown): v is string => typeof v === 'string' && CLOCK.test(v);
const UPDATE = 'Update MoPilot on your computer to change its notification settings from your phone.';

/** A kind the Mac does not mention is on, as on the Mac. */
export function parseSettings(value: unknown, momo = true): MacPushSettings {
  const r = rec(value);
  if (!r || typeof r.titlesInPush !== 'boolean' || !MODES.includes(r.mode as NotifyMode)) return bad('notification settings');
  const kinds = rec(r.kinds) ?? {};
  const quiet = (v: unknown): QuietHours | null => {
    const q = rec(v);
    return q && isClock(q.start) && isClock(q.end) ? { start: q.start, end: q.end } : null;
  };
  return {
    titlesInPush: r.titlesInPush,
    mode: r.mode as NotifyMode,
    kinds: Object.fromEntries(KINDS.map((k) => [k, kinds[k] !== false])),
    quietHours: 'quietHours' in r ? quiet(r.quietHours) : undefined,
    momoQuietHours: momo && 'momoQuietHours' in r ? quiet(r.momoQuietHours) : undefined,
    momo,
  };
}

/** The Mac says whether it has these methods in machine.hello; an older Mac says nothing and gets the update message. */
async function supported(request: Owned) {
  const caps = rec(rec(await request('machine.hello'))?.capabilities);
  if (caps?.pushSettings !== true) throw new Unavailable(UPDATE);
  return caps.momo === true;
}

export async function loadMacSettings(request: Owned): Promise<MacPushSettings> {
  const momo = await supported(request);
  return parseSettings(await request('push.settings.get'), momo);
}

/** Rejects what the Mac would reject, before asking it. */
export function checkPatch(patch: MacPushPatch): MacPushPatch {
  const out: MacPushPatch = {};
  if (patch.titlesInPush !== undefined) {
    if (typeof patch.titlesInPush !== 'boolean') throw new Error('Choose on or off for titles in notifications.');
    out.titlesInPush = patch.titlesInPush;
  }
  if (patch.mode !== undefined) {
    if (!MODES.includes(patch.mode)) throw new Error('Choose when to notify.');
    out.mode = patch.mode;
  }
  if (patch.kinds !== undefined) {
    const entries = Object.entries(patch.kinds);
    if (!entries.length || !entries.every(([k, v]) => KINDS.includes(k) && typeof v === 'boolean'))
      throw new Error('Choose a known kind and on or off.');
    out.kinds = Object.fromEntries(entries);
  }
  for (const key of ['quietHours', 'momoQuietHours'] as const) {
    const q = patch[key];
    if (q === undefined) continue;
    if (q !== null && !(isClock(q.start) && isClock(q.end) && q.start !== q.end))
      throw new Error('Choose quiet hours as two different times, or none.');
    out[key] = q === null ? null : { start: q.start, end: q.end };
  }
  if (!Object.keys(out).length) throw new Error('Nothing to change.');
  return out;
}

/** Applies a patch on the Mac and returns the full settings it now has. */
export async function saveMacSettings(request: Owned, patch: MacPushPatch, momo = true): Promise<MacPushSettings> {
  return parseSettings(await request('push.settings.set', checkPatch(patch)), momo);
}

/** The settings as they will read once the Mac has applied a patch: shown at once, replaced by the Mac's own answer. */
export function applyPatch(settings: MacPushSettings, patch: MacPushPatch): MacPushSettings {
  const next = { ...settings, kinds: { ...settings.kinds } };
  if (patch.titlesInPush !== undefined) next.titlesInPush = patch.titlesInPush;
  if (patch.mode !== undefined) next.mode = patch.mode;
  if (patch.kinds) Object.assign(next.kinds, patch.kinds);
  if (patch.quietHours !== undefined && settings.quietHours !== undefined) next.quietHours = patch.quietHours;
  if (patch.momoQuietHours !== undefined && settings.momoQuietHours !== undefined) next.momoQuietHours = patch.momoQuietHours;
  return next;
}

/** Puts back only what a refused patch had changed, leaving later changes alone. */
export function revertPatch(current: MacPushSettings, before: MacPushSettings, patch: MacPushPatch): MacPushSettings {
  const next = { ...current, kinds: { ...current.kinds } };
  if (patch.titlesInPush !== undefined) next.titlesInPush = before.titlesInPush;
  if (patch.mode !== undefined) next.mode = before.mode;
  for (const kind of Object.keys(patch.kinds ?? {})) next.kinds[kind] = before.kinds[kind];
  if (patch.quietHours !== undefined) next.quietHours = before.quietHours;
  if (patch.momoQuietHours !== undefined) next.momoQuietHours = before.momoQuietHours;
  return next;
}
