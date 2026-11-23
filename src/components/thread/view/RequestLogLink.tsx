// The failed-turn banner's "Request log" link: Settings → About → Diagnostics → Request log on this chat, with the
// turn's requests marked by when it ran (the same for every harness, src/lib/requestLog.ts inFocus).
import { navigate } from '../../../store/panes';
import type { TurnState } from '../../../store/types';

export function RequestLogLink({ chatId, turn }: { chatId: string; turn: Pick<TurnState, 'startedAt' | 'completedAt'> }) {
  return (
    <button
      className="link-muted turn-error-log"
      data-testid="turn-error-request-log"
      onClick={() =>
        navigate({
          name: 'settings',
          section: 'about',
          tab: 'request-log',
          ledger: { chat: chatId, from: turn.startedAt, to: turn.completedAt },
        })
      }
    >
      Request log
    </button>
  );
}
