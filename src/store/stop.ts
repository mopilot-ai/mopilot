// Stop on every harness: the chat's running turn, or only the turn a button showed (a stall banner's, an approval's).
import type { HarnessFamily } from '../harness/family';
import { sessionOf } from './session/useSession';
import { get } from './core';
import { nativeOf, chatFamily } from './chats';
import { markStoppedByYou } from './stoppedByYou';
import { runtime } from './runtime';

/**
 * Codex chats stopped while their turn starts, by native thread id: the app-server takes turn/interrupt only once it has
 * said turn/started, so the Stop (Esc right after Enter) runs then (#1658).
 */
export const stopOnStart = new Map<string, string>();
/** The turns the window knew when that Stop was queued, by native thread id: their late turn/completed is not the new turn's end (#3896). */
export const stopSeenTurns = new Map<string, Set<string>>();

/** The turn a button's Stop is for: the window's id (Codex names it on turn/interrupt) and main's, as last heard. */
type StopTurn = { renderer: string; main?: string };

/** Stop, per harness. `pending`: a turn still starting (no turn id from the harness yet) can be stopped too. */
const STOP: Record<HarnessFamily, { pending: boolean; run(chatId: string, turn?: StopTurn): Promise<unknown> }> = {
  // an active goal would carry on in this turn (and the next), so stopping pauses it too; Stop itself
  // doesn't depend on goals being on, so this doesn't go through the goal semantic
  codex: { pending: false, run: (id, turn) => (turn ? runtime().pauseCodexGoal(id, turn.renderer) : runtime().pauseCodexGoal(id)) },
  // Claude's interrupt() leaves its goal active for the next message, so main's Stop pauses an active goal first; a
  // turn still starting (its live CLI taking new settings, or a CLI starting) is not sent (ChatController.stopGuard)
  claude: { pending: true, run: (id, turn) => (turn?.main ? runtime().claudeStop(id, turn.main) : runtime().claudeStop(id)) },
  // an ACP chat may still be starting its agent (no turn id from it yet): main keeps the message from going
  acp: { pending: true, run: (id, turn) => (turn?.main ? runtime().acpInterrupt(id, turn.main) : runtime().acpInterrupt(id)) },
};

/**
 * Stop the chat's running turn. `expectTurnId`: the turn a button showed. When another turn runs by the click (that
 * one ended and a queued message started the next), nothing stops and this resolves 'retired' (liveAction says so);
 * main checks the same against the turn it runs, so a turn it started since this window last heard is not stopped.
 */
export async function interrupt(threadId: string, expectTurnId?: string): Promise<boolean | 'retired'> {
  const rt = get().runtime[threadId];
  if (expectTurnId !== undefined && rt?.activeTurnId !== expectTurnId) return 'retired';
  if (!rt?.activeTurnId) return false;
  const stop = STOP[chatFamily(threadId)];
  // Esc right after Enter: a turn the harness has not named yet stops as soon as it is named
  if (rt.activeTurnId.startsWith('pending-') && !stop.pending) {
    stopOnStart.set(nativeOf(threadId), threadId);
    stopSeenTurns.set(nativeOf(threadId), new Set(rt.turns.map((t) => t.id)));
    return true;
  }
  // main's id for that turn as this window last heard it; none when main hadn't said yet (main stops what runs)
  const turn = expectTurnId === undefined ? undefined : { renderer: expectTurnId, main: sessionOf(threadId).activeTurn?.id ?? undefined };
  markStoppedByYou(threadId);
  return (await stop.run(threadId, turn)) === 'retired' ? 'retired' : true;
}
