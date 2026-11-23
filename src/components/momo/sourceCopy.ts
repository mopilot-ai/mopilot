// What Settings › MoMo › Sources says about each source in plain words (#2139 P2): what it is for, what MoMo can do once it is on, and exactly what MoMo reads, the same facts main enforces (electron/momo/sources/calendar.cjs, reminders.cjs, files.cjs).
import type { MomoSourceId } from '../../lib/native/contracts/momoSources';

export type SourceCopy = {
  /** the status line of a source that is off: what turning it on gives */
  idle: string;
  /** the status line of a source that is on and not paused (Files says how many folders instead) */
  on?: string;
  /** the same for a source set to Read & ask to change (Calendar and Reminders; Files is never written) */
  onAsk?: string;
  /** what MoMo reads from it, in one sentence the details show */
  reads: string;
  /** what the connected names are called in the details (calendars, lists); Files shows its folders in its own list */
  names?: string;
};

export const SOURCE_COPY: Record<MomoSourceId, SourceCopy> = {
  calendar: {
    idle: 'Let MoMo see your upcoming events.',
    on: 'MoMo can read your calendar.',
    onAsk: 'MoMo can read your calendar and add events after you approve.',
    reads: 'Event titles, times, places and attendee names, from the day you connected.',
    names: 'Calendars',
  },
  reminders: {
    idle: 'Let MoMo see what you still need to do.',
    on: 'MoMo can read your reminders.',
    onAsk: 'MoMo can read your reminders, and add or finish them after you approve.',
    reads: 'Open reminders with their due dates and lists, and completed ones only since you connected.',
    names: 'Lists',
  },
  files: {
    idle: 'Choose the folders MoMo may read.',
    reads: 'Text files inside the folders you add. Never hidden files, never anything outside them.',
  },
};

/** Said for every source: MoMo only reads, and what it copied goes when the source is disconnected. */
export const KEEPS = 'MoMo only reads; it never changes anything. What it copied is deleted when you disconnect.';

/** Said for a source set to Read & ask to change: every change waits for a card, and MoMo can undo only its own. */
export const KEEPS_ASK = 'MoMo reads, and changes only what you approve on a card. What it copied is deleted when you disconnect.';

/** The status line of a source that is on but paused. */
export const PAUSED_LINE = "Paused. MoMo won't read it.";
/** The status line of Files when it has no folder yet. */
export const NO_FOLDERS_LINE = 'No folders yet. Add one for MoMo to read.';

/** "1 folder", "3 folders". */
export const foldersText = (n: number) => `${n} ${n === 1 ? 'folder' : 'folders'}`;
