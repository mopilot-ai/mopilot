// The apps computer use refused in a turn, read from the chat's saved notes (main writes them, electron/capabilities/contract/controlRefusals.cjs): the working-in card shows such an app as refused and no follow-up suggests it again.
import { sameTurn, type ChatNote } from './chatMeta';
import type { RefusedApp } from '../../shared/model/store';

/**
 * The apps refused in the chat's latest turn (`turns`, oldest first), from its notes. A note whose turn id names none of
 * the loaded turns (main noted it under a controller token, or knew no turn) is the latest turn's, as the transcript
 * places it (chatMeta.ts withChatNotes).
 */
export function refusedApps(notes: ChatNote[] | undefined, turns: readonly { id: string }[] | undefined): RefusedApp[] {
  const latest = turns?.at(-1)?.id;
  if (!notes?.length || !latest) return [];
  const ours = (id: string | null) => (id ? sameTurn(id, latest) || !turns!.some((t) => sameTurn(t.id, id)) : true);
  return notes.flatMap((n) => (n.kind === 'control' && n.refused && ours(n.turnId) ? [n.refused] : []));
}

/** The refused app an agent's app name or bundle id stands for, or null. */
export function refusalOf(app: string, refused: RefusedApp[]): RefusedApp | null {
  const k = app.trim().toLowerCase();
  return refused.find((r) => r.app.toLowerCase() === k || r.name.toLowerCase() === k) ?? null;
}
