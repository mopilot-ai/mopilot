// The button on a chat's usage-limit note, on every harness: continue on the other harness where it can run, else
// where it is set up, so the note left in the chat keeps the way on the toast offered.
import { limitNoteAction } from '../../store/chats';
import { useStore } from '../../store/core';

export function LimitNoteAction({ chatId }: { chatId: string }) {
  // read again as the store changes: the other harness may have been set up since the note
  const label = useStore(() => limitNoteAction(chatId).label);
  return (
    <button type="button" className="btn-pill soft status-note-action" onClick={() => limitNoteAction(chatId).run()}>
      {label}
    </button>
  );
}
