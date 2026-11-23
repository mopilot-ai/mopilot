// Which of a chat's turns is the running one the transcript draws live (its running line, clock and status line): one per chat.
import type { TurnState } from '../../shared/model/store';

/**
 * The chat's running turn: the active turn while it runs, else the latest turn still running (another app's, followed
 * on disk, is never the active one). Any other turn left `inProgress` is stale (its end never arrived) and draws as
 * settled, so a chat never shows two running lines (#2332).
 */
export function liveTurnId(turns: readonly TurnState[], activeTurnId: string | null | undefined): string | null {
  const active = activeTurnId ? turns.find((t) => t.id === activeTurnId) : undefined;
  if (active?.status === 'inProgress') return active.id;
  return turns.findLast((t) => t.status === 'inProgress')?.id ?? null;
}
