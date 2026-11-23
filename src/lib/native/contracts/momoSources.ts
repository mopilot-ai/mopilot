// MoMo's local sources as Settings › MoMo › Sources gets them (#2139 P2, electron/momo/sources/hub.cjs, electron/momo/sources/ipc.cjs).

/** The sources, in the order Settings shows them (main's SOURCE_IDS; a test keeps the two the same). */
export const MOMO_SOURCE_IDS = ['calendar', 'reminders', 'files'] as const;
export type MomoSourceId = (typeof MOMO_SOURCE_IDS)[number];

/** The access levels as Settings names them (main's LEVELS; a test keeps the two the same). */
export const MOMO_SOURCE_LEVELS = [
  { value: 'blocked', label: 'Blocked' },
  { value: 'read', label: 'Read only' },
  { value: 'ask', label: 'Read & ask to change' },
] as const;
export type MomoSourceLevel = (typeof MOMO_SOURCE_LEVELS)[number]['value'];

/** What macOS says about Calendar or Reminders access ('unavailable': not macOS, or a helper too old). */
export type MomoSourceGrant = 'granted' | 'denied' | 'restricted' | 'writeOnly' | 'notDetermined' | 'unavailable';

/**
 * One source's row: not connected, or since when and at what level; Files with its folders as stored (real paths).
 * `needsGrant`: connected in MoMo, but macOS refuses its reads (the grant was reset, or another build of the app asked), so
 * the user allows it again; only Calendar and Reminders, and only once a read or the row's names found it.
 */
export type MomoSource = { id: MomoSourceId; label: string; folders?: string[] } & (
  | { connected: false }
  | { connected: true; connectedAt: number; level: MomoSourceLevel; needsGrant?: true }
);

/** Why a call failed: MoMo not allowed, no encryption here, macOS refused, a bad folder, ... */
export type MomoSourceReason =
  | 'not_allowed'
  | 'unavailable'
  | 'unknown'
  | 'not_connected'
  | 'blocked'
  | 'not_granted'
  | 'bad_args'
  | 'outside'
  | 'refused'
  | 'busy'
  | 'failed';

/** Every answer: what was asked for, or why not. */
export type MomoSourcesResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; reason?: MomoSourceReason };

/** One thing MoMo wrote to Calendar or Reminders (electron/momo/sources/writeLedger.cjs), kept 30 days so the user can undo it. */
export type MomoWrite = {
  id: string;
  /** an event added, a reminder added, or a reminder marked done */
  kind: 'event' | 'reminder' | 'complete';
  title: string;
  /** when MoMo wrote it */
  at: number;
  start?: number;
  due?: number;
  /** when it was undone, if it was */
  undone?: number;
};
