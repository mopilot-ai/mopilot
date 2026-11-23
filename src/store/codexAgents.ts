// Codex sub-agents' child threads for the agent page: which chat each belongs to, and its transcript, stored or live.
import { codexApi } from '../harness/adapters/codexApi';
import { turnFromServer } from '../../shared/codexTurns.mjs';
import { flattenTurns, type TurnLike } from '../harness/codexAgentRun';
import { putAgentItems, type AgentThreadLoader } from './agentThreads';

/** Pages of a stored child transcript read at most (50 turns each); a sub-agent rarely runs more than one. */
const MAX_PAGES = 20;

/* ------------------------------------------------------------------ */
/* the child thread's transcript                                       */
/* ------------------------------------------------------------------ */
/** Child thread id → the MoPilot chat whose agent page shows it. */
const parents = new Map<string, string>();
/** The turn list last published per child thread, so a runtime patch that didn't touch turns is ignored. */
const published = new Map<string, unknown>();

/** Remember which chat a child thread's agent belongs to, so its live turns reach that chat's agent page. */
export function trackCodexAgent(chatId: string, childThreadId: string) {
  parents.set(childThreadId, chatId);
}

/**
 * A thread's runtime turns changed (the store calls this on every runtime patch): when it is a tracked
 * child thread, its agent page streams the new items.
 */
export function codexAgentTurnsChanged(threadId: string, turns: TurnLike[]) {
  const chatId = parents.get(threadId);
  if (!chatId || published.get(threadId) === turns) return;
  published.set(threadId, turns);
  putAgentItems(chatId, threadId, flattenTurns(turns));
}

/** A child thread's stored turns, oldest first (thread/turns/list pages run newest first). */
export async function readCodexChildTurns(childThreadId: string): Promise<TurnLike[]> {
  let all: TurnLike[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await codexApi.threadTurns(childThreadId, { limit: 50, itemsView: 'full', cursor });
    all = [...r.data.map(turnFromServer).reverse(), ...all];
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return all;
}

/** The agent page's loader for Codex: the child thread's items in order. Its live turns follow once tracked. */
export const loadCodexAgentThread = (async (chatId, run) => {
  trackCodexAgent(chatId, run.key);
  return flattenTurns(await readCodexChildTurns(run.key));
}) satisfies AgentThreadLoader;
