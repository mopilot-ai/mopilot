// The chat view's Retry after a read of the chat failed: a harness that is down comes back first, then the chat is read again. @store-slice: tests' store stub replaces it whole (tests/support/stubs.ts).
import { harnessFamily, nativeFamily, type HarnessFamily } from '../harness/family';
import { get, patchRuntime } from './core';
import { readFailed } from './chatReads';
import { restartCodexIfDown } from './connection';
import { showThread } from './threads';
import { sendQueuedNow } from './send';
import { userError } from '../lib/ignored';

/**
 * What a chat's Retry brings back before reading it again, per harness its history comes from. Every Codex read goes
 * through its app-server, so a Codex that quit (or that MoPilot stopped restarting) is restarted first: reading
 * without it only fails again with "Codex isn't connected". Claude Code's and the basic harnesses' history is read from
 * their transcripts, with no process to bring back.
 */
const BEFORE_REREAD: Record<HarnessFamily, () => Promise<void>> = {
  codex: restartCodexIfDown,
  claude: async () => undefined,
  acp: async () => undefined,
};

/** The harnesses a chat's history is read from: a switched chat reads every part it ran on, each on its own harness. */
export const readFamilies = (id: string): Set<HarnessFamily> =>
  new Set(get().segments[id]?.map((s) => harnessFamily(s.harness, s.nativeId)) ?? [nativeFamily(id)]);

/** The chat view's Retry after a read failed: the error goes, and the chat is read again on its harness. */
export async function retryOpen(id: string, held?: string): Promise<void> {
  // a banner that says why main refused the chat's start (not a failed read): Retry also sends the message main kept
  const refused = held !== undefined && !!get().runtime[id]?.error && get().runtime[id]?.errorFromRead === false;
  // loading while a harness comes back: the chat shows a spinner, and a reload Codex's reconnect starts waits for this one
  patchRuntime(id, () => ({ error: null, errorFromRead: false, loaded: false, loading: true }));
  try {
    for (const family of readFamilies(id)) await BEFORE_REREAD[family]();
  } catch (e) {
    // still down: the chat says why, with Retry again
    return void patchRuntime(id, () => readFailed(e));
  }
  patchRuntime(id, () => ({ loading: false }));
  showThread(id);
  if (refused) await resendHeld(id, held);
}

/**
 * The queued message a refused start left, for the chat's Retry to send: the first one in a crashed chat's queue that
 * isn't waiting on a compaction. The caller reads the chat's session (the store sits below it) and hands this to retryOpen.
 */
export const heldHead = (session: { turn: string; queue: { id: string; waitingFor?: string }[] } | undefined) =>
  session?.turn === 'crashed' && session.queue[0] && !session.queue[0].waitingFor ? session.queue[0].id : undefined;

/**
 * Sends the held message through main's own send-now, which takes the entry out of the queue before it starts (so it is
 * sent once; a second click finds the banner already cleared and sends nothing). A start refused again puts it back and the banner returns with the reason; a failed call shows its message.
 */
async function resendHeld(id: string, queueId: string): Promise<void> {
  try {
    const result = await sendQueuedNow(id, queueId);
    // sent, already sent, or taken by the window that holds the chat
    if (result.status === 'sent' || result.status === 'missing' || result.status === 'held') return;
    patchRuntime(id, () => ({
      error: result.error ? userError(result.error) : 'The message is still waiting in the queue.',
      errorFromRead: false,
    }));
  } catch (error) {
    patchRuntime(id, () => ({ error: userError(error), errorFromRead: false }));
  }
}
