// Claude chat history in the window: the latest page of turns when a chat opens, older pages on request, all of it for a switched chat.
import { native } from '../../../lib/native';
import { noteIgnored } from '../../../lib/ignored';
import { turnBusy } from '../../../store/session/sessionState';
import { get as getState, patchRuntime } from '../../../store/core';
import { nativeOf } from '../../../store/chats';
import { readFailed, readSucceeded } from '../../../store/chatReads';
import { TURN_PAGE } from '../../../store/turnPages';
import type { TurnState } from '../../../store/types';
import { coalesceLimitNotes } from '../../../../shared/limitNotices.mjs';
import { mergeClaudeTurns } from '../../../harness/claudeTranslate';
import { claudeSessionId } from '../../../harness/types';
import { withoutRecoveredAuthErrors } from './accounts';
import { flushHeld } from './items';
import { beginHistoryOpen, readStableTranscript } from '../../../store/transcriptRead';

/**
 * A page of a Claude session's turns, built in main and reported under the chat that owns it: the latest `limit`
 * turns, the ones before the turn `before`, or all of them without a limit (native.claude.turns).
 */
export async function readClaudeTurns(
  chatId: string,
  nativeId: string,
  cwd: string,
  opts: { liveTail?: boolean; closedTail?: boolean; open?: boolean; limit?: number; before?: string | null } = {},
): Promise<{ turns: TurnState[]; olderCursor: string | null; closedTail: TurnState | null }> {
  const { page, diffs } = await native.claude.turns(claudeSessionId(nativeId), { chatId, cwd, ...opts });
  const read = JSON.parse(new TextDecoder().decode(page)) as {
    turns: TurnState[];
    olderCursor: string | null;
    closedTail: TurnState | null;
  };
  const withDiff = (turn: TurnState) => (turn.id in diffs ? { ...turn, diff: diffs[turn.id] } : turn);
  const tail = read.closedTail ? withoutRecoveredAuthErrors(chatId, [withDiff(read.closedTail)])[0] : null;
  return { turns: withoutRecoveredAuthErrors(chatId, read.turns.map(withDiff)), olderCursor: read.olderCursor, closedTail: tail };
}

/** The page of a Claude chat's turns before `cursor`, for the older history above what is shown. */
export async function loadOlderClaudeTurns(id: string, cursor: string): Promise<{ turns: TurnState[]; nextCursor: string | null }> {
  const page = await readClaudeTurns(id, id, getState().threads[id]?.cwd ?? '', { limit: TURN_PAGE, before: cursor });
  return { turns: page.turns, nextCursor: page.olderCursor };
}

/**
 * What main says of this chat now: whether it runs the chat's turn (its own session state, not a guess from the
 * transcript's timestamps), and whether another app may be writing it (unknown, a failed or empty answer, counts as so).
 */
async function chatRuns(id: string): Promise<{ main: boolean; elsewhere: boolean }> {
  // a read that fails leaves the transcript's own reading: the turn's live events still end it
  const session = await Promise.resolve()
    .then(() => native.session.snapshot(id))
    .catch((error) => (noteIgnored("read a Claude chat's session state", error), null));
  if (!session) return { main: false, elsewhere: true };
  return { main: turnBusy(session) && !session.runningElsewhere, elsewhere: session.runningElsewhere };
}

/**
 * Read a Claude chat's turns with its last turn kept open while main runs the chat's turn (#1838): main is asked
 * before the read (`read(true)` keeps the turn and its running tool calls open) and again after it; a turn that ended
 * in between is read again as it ended. `elsewhere`: main's last answer says another app may be writing the chat.
 */
export async function readWhileRunning<T>(
  chatId: string,
  read: (open: boolean) => Promise<T>,
  current: () => boolean = () => true,
): Promise<{ value: T; running: boolean; elsewhere: boolean }> {
  const assertCurrent = () => {
    if (!current()) throw new Error('History read retired');
  };
  let state = await chatRuns(chatId);
  for (let attempt = 0; attempt < 4; attempt++) {
    assertCurrent();
    const value = await read(state.main);
    assertCurrent();
    const after = await chatRuns(chatId);
    // A writer can start as well as stop during a read. Main's tools must be read with its current open flag;
    // another app (or an unknown answer) keeps the live tail, using the answer taken after the transcript read.
    if (after.main === state.main) return { value, running: after.main, elsewhere: after.elsewhere };
    state = after;
  }
  throw new Error('The chat kept changing while its history loaded. Try again.');
}

/** A transcript turn main is still running: open, with no end time. */
export const reopenedTurn = (t: TurnState): TurnState => ({ ...t, status: 'inProgress', completedAt: null, durationMs: null, error: null });

/** The transcript turn with what main's items showed of it here before the chat opened. */
function withEarlyItems(turn: TurnState, early: TurnState | undefined): TurnState {
  // Only the same opening prompt proves this window has the turn from its start; a steered prompt does not.
  const prompt = turn.items.find((i) => i.type === 'userMessage');
  const userId = (i: Extract<TurnState['items'][number], { type: 'userMessage' }>) => i.clientId ?? i.id;
  if (prompt && early?.id === turn.id && early.items.some((i) => i.type === 'userMessage' && userId(i) === userId(prompt))) return early;
  const have = new Set(turn.items.map((i) => i.id));
  const users = new Set(turn.items.filter((i) => i.type === 'userMessage').map(userId));
  const extra = early?.items.filter((i) => !have.has(i.id) && !(i.type === 'userMessage' && users.has(userId(i)))) ?? [];
  return extra.length ? { ...turn, items: [...turn.items, ...extra] } : turn;
}

/**
 * Show a Claude chat's latest page of turns; older ones page in on request (loadOlderClaudeTurns). Opens replace each
 * other: one retired by a newer open, or by the chat leaving this session (a harness switch), shows nothing.
 * `opened` runs once the page is in, right before it shows. A chat whose turn main is running (a window opened or
 * reloaded mid-turn, #1838) keeps its last turn open: main's read names that turn by its live id, so what its items
 * showed here while the chat was read folds into it. A transcript id means main's translator runs no turn of it yet.
 */
export async function openLatestClaudeTurns(id: string, opened: () => void) {
  const opening = beginHistoryOpen(id);
  const segments = getState().segments[id];
  const current = () => opening.owns() && nativeOf(id) === id && getState().segments[id] === segments;
  try {
    await readStableTranscript(id, current, flushHeld, async (unchanged) => {
      try {
        const cwd = getState().threads[id]?.cwd ?? '';
        const {
          value: read,
          running,
          elsewhere,
        } = await readWhileRunning(
          id,
          (open) => readClaudeTurns(id, id, cwd, { liveTail: true, limit: TURN_PAGE, ...(open ? { open } : { closedTail: true }) }),
          unchanged,
        );
        flushHeld();
        if (!unchanged()) return false;
        // a tail still being written that neither main nor another app runs is this app's own turn that just ended: it
        // shows as it ended, as the follow's next read would close it (following.ts), not as a turn left running (#2332)
        const page = !running && !elsewhere && read.closedTail ? { ...read, turns: [...read.turns.slice(0, -1), read.closedTail] } : read;
        opened();
        const last = running ? page.turns.at(-1) : undefined;
        // nothing awaits between here and the patch, so no message of the turn lands in between
        const early = last && !last.id.startsWith('h-') ? last.id : null;
        // turns that started streaming here while it was read stay, under their live ids
        patchRuntime(id, (r) => {
          const turns = last
            ? [
                ...page.turns.slice(0, -1),
                reopenedTurn(
                  withEarlyItems(
                    last,
                    r.turns.find((t) => t.id === early),
                  ),
                ),
              ]
            : page.turns;
          return {
            ...readSucceeded(r),
            loaded: true,
            loading: false,
            turns: coalesceLimitNotes(
              withoutRecoveredAuthErrors(id, mergeClaudeTurns(turns, early ? r.turns.filter((t) => t.id !== early) : r.turns)),
            ),
            olderCursor: page.olderCursor,
            ...(last ? { activeTurnId: last.id } : {}),
          };
        });
        return true;
      } catch (e) {
        flushHeld();
        if (!unchanged()) return false;
        patchRuntime(id, () => readFailed(e));
        return true;
      }
    });
  } finally {
    opening.finish();
  }
}
