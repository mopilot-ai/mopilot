// Whether the harness a chat's next message goes to is down for this window, and how to bring it back.
import type { HarnessFamily } from '../harness/family';
import type { AppState } from './state';
import { restartCodex } from './connection';

/**
 * Per harness: whether it is down (its process can't take a message, and nothing is bringing it back), and how to start
 * it again. Codex is down once main gave up restarting it or it never started (conn 'error'); while main brings a
 * crashed Codex back by itself, the composer stays, with its queue, and the banner says it is restarting. Claude Code
 * starts a process for each chat as it sends, and a basic harness's host starts its agent the same way, so neither is
 * down between messages; their failures show on the turn that hit them.
 */
export const HARNESS_DOWN: Record<HarnessFamily, { down: (s: AppState) => boolean; restart: (() => Promise<void>) | null }> = {
  codex: { down: (s) => s.conn === 'error', restart: restartCodex },
  claude: { down: () => false, restart: null },
  acp: { down: () => false, restart: null },
};
