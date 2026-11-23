// The chat's working line words (Claude's escalating thinking copy, the running step's activity) and the finished turn's "Worked 1m 20s".
import type { Kind } from './toolRuns';
import type { Row } from './thread';

/** Claude for iOS's thinking copy, by how long nothing new has come from the turn. */
const THINKING: readonly (readonly [number, string])[] = [
  [40_000, 'Still thinking…'],
  [15_000, 'Thinking some more…'],
  [6_000, 'Thinking more…'],
  [0, 'Thinking…'],
];

/** After this long the thinking copy has reached its last words. */
export const THINKING_LAST_MS = THINKING[0][0];

/** What a running step is doing, in Claude's activity words. */
const DOING: Record<Kind, string> = {
  read: 'Reading files',
  search: 'Searching',
  edit: 'Editing',
  run: 'Running',
  web: 'Searching the web',
  other: 'Working',
};

/** What ends the transcript while the turn runs: your message, a step (with its kind), the reply being written, or nothing yet. */
export type Tail = { type: 'you' } | { type: 'step'; kind: Kind } | { type: 'reply' } | { type: 'none' };

/**
 * The words beside the spark while a turn works. A step that ends the transcript names its activity; the reply being
 * written needs no words (the text itself moves); otherwise the turn is thinking, and the copy grows the longer it lasts.
 */
export function workingWords(tail: Tail, sinceMs: number): string {
  if (tail.type === 'step') return DOING[tail.kind];
  if (tail.type === 'reply') return '';
  return THINKING.find(([after]) => sinceMs >= after)![1];
}

/** "6s", "1m 20s", "1h 2m": the compact time of Claude's "Worked" line; null under a second. */
export function shortDuration(milliseconds: number): string | null {
  const total = Math.floor(milliseconds / 1000);
  if (total < 1) return null;
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
  return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
}

/** "Worked 1m 20s" once a turn the phone saw start has ended; just "Worked" when it did not see how long it took. */
export function workedWords(took: number | null | undefined): string {
  const time = took == null ? null : shortDuration(took);
  return time ? `Worked ${time}` : 'Worked';
}

const isYou = (row: Row) => row.role === 'user' || row.role === 'liveUser';

/** What ends the transcript, for the working line. */
export function tailOf(rows: readonly Row[]): Tail {
  const last = rows.at(-1);
  if (!last) return { type: 'none' };
  if (isYou(last)) return { type: 'you' };
  if (last.role === 'assistant' || last.role === 'preview') return { type: 'reply' };
  if (last.role === 'step' || last.role === 'live') return { type: 'step', kind: last.kind ?? 'other' };
  return { type: 'none' };
}

/** The last turn: your message that began it, and its reply (every reply row after it, joined), for retry and copy. */
export function lastTurn(rows: readonly Row[]): { you: string | null; reply: string | null } {
  let start = -1;
  rows.forEach((row, i) => {
    if (isYou(row)) start = i;
  });
  const reply = rows
    .slice(start + 1)
    .filter((row) => row.role === 'assistant' || row.role === 'preview')
    .map((row) => row.text)
    .filter((text) => text.trim())
    .join('\n\n');
  return { you: start < 0 || !rows[start].text.trim() ? null : rows[start].text, reply: reply || null };
}
