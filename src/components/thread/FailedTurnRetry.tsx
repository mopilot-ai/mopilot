// Retry belongs to the latest terminal failure, never a quiet turn or an adapter still recovering its stream.
import { useState } from 'react';
import { useStore, toastFailure } from '../../store/core';
import { failedTurnForRetry, retrySessionReady, messageOf, retryFailedTurn } from '../../store/failedTurnRetry';
import { useSession } from '../../store/session/useSession';

export function FailedTurnRetry({ chatId, turnId }: { chatId: string; turnId: string }) {
  const turn = useStore((s) => failedTurnForRetry(s.runtime[chatId], turnId));
  const session = useSession(chatId);
  const [busy, setBusy] = useState(false);
  if (!turn || !retrySessionReady(session) || !messageOf(turn.items)) return null;
  return (
    <button
      className="btn-pill"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void retryFailedTurn(chatId, turnId)
          .catch(toastFailure("Couldn't retry"))
          .finally(() => setBusy(false));
      }}
    >
      {busy ? 'Retrying…' : 'Retry'}
    </button>
  );
}
