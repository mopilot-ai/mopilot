// The shapes MoMo's newer phone methods return (momo.state.get, momo.prefs.get, a reminder or a draft note in the chat), each checked before a screen reads it.
import { draftOf, type Draft } from '../../../shared/momoDraft.mjs';
import { readSend, type Send } from '../../../shared/momoDraftSend.mjs';
import { briefCardOf, type BriefCard } from '../../../shared/momoBriefNote.mjs';

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown) => (typeof value === 'string' && value ? value : null);

/** MoMo's state as the Mac reports it; the phone never guesses it. */
export type MomoStatus = 'online' | 'paused' | 'offline';
/** shell: the Mac has MoMo's page shell on (`momo.shell`, Mac-only); shellTasks: and its four-tab Tasks panel too. A Mac that says neither is an older Mac, or has the flag off. */
export type MomoState = { name: string; status: MomoStatus; needsYou: number; shell: boolean; shellTasks: boolean; suggestions: boolean };
/** suggestions: the Mac has MoMo's suggestions on (`momo.suggestions`, Mac-only, its own flag): Up next's rows and a brief's cards. */
/** A reminder MoMo raised in its chat: its open loop, what to remember and why it came up. */
export type Nudge = { loopId: string; title: string; quote: string | null; why: string | null };

const STATUS: ReadonlySet<unknown> = new Set(['online', 'paused', 'offline']);

/** `momo.state.get`; a reply that is not one throws, so the header falls back to the connection's own word. */
export function parseState(value: unknown): MomoState {
  const v = record(value);
  if (!v || !STATUS.has(v.status)) throw new Error('Could not read MoMo’s state.');
  const needs = typeof v.needsYou === 'number' && Number.isSafeInteger(v.needsYou) && v.needsYou > 0 ? v.needsYou : 0;
  const shell = v.shell === true;
  return {
    name: text(v.name) ?? 'MoMo',
    status: v.status as MomoStatus,
    needsYou: needs,
    shell,
    shellTasks: shell && v.shellTasks === true,
    suggestions: v.suggestions === true,
  };
}

/** Whether `momo.prefs.get` (or set) says MoMo is paused; anything unreadable throws. */
export function parsePaused(value: unknown): boolean {
  const v = record(value);
  if (!v || typeof v.paused !== 'boolean') throw new Error('Could not read MoMo’s settings.');
  return v.paused;
}

/** The reminder on a chat row (`{ role: 'note', nudge: {...} }`), or null for any other row. */
export function nudgeOf(item: unknown): Nudge | null {
  const n = record(record(item)?.nudge);
  const loopId = text(n?.loopId);
  const title = text(n?.title);
  if (!n || !loopId || !title) return null;
  return { loopId, title, quote: text(n.quote), why: text(n.why ?? n.trigger) };
}

/** The draft MoMo wrote on a chat row (`{ role: 'note', draft: {...} }`), checked as the Mac checks it, or null for any other row. */
export function draftOfRow(item: unknown): Draft | null {
  const r = record(item);
  return r?.role === 'note' ? draftOf(r.draft) : null;
}

/** How far the user's Send of a draft got on the Mac (`{ role: 'note', send: {...} }`), checked as the Mac checks it, or null when none began. */
export function sendOfRow(item: unknown): Send | null {
  const r = record(item);
  return r?.role === 'note' ? readSend(r.send) : null;
}

/** The suggestion card a line of MoMo's morning brief is (`{ role: 'note', suggestion: {...} }`), checked as the Mac checks it, or null for any other row. */
export function briefCardOfRow(item: unknown): BriefCard | null {
  const r = record(item);
  return r?.role === 'note' ? briefCardOf(r.suggestion) : null;
}
