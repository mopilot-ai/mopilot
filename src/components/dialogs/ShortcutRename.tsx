// Rename the keyboard-selected chat through the shared chat action, including a focused side chat.
import { useEffect, useRef, useState } from 'react';
import { get as getState, threadTitle } from '../../store/core';
import { renameThread } from '../../store/actions';
import { Modal } from '../ui/Modal';
import { busyField } from '../../lib/focus';

export function ShortcutRename() {
  const [chatId, setChatId] = useState<string | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent<{ threadId?: unknown }>).detail?.threadId;
      if (typeof id === 'string' && getState().threads[id]) setChatId(id);
    };
    window.addEventListener('rename-chat', open);
    return () => window.removeEventListener('rename-chat', open);
  }, []);
  return chatId ? (
    <RenameForm key={chatId} chatId={chatId} onClose={() => setChatId((current) => (current === chatId ? null : current))} />
  ) : null;
}

function RenameForm({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const [value, setValue] = useState(() => threadTitle(getState().threads[chatId]));
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const submit = async () => {
    if (inFlight.current || !value.trim()) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await renameThread(chatId, value.trim());
      if (threadTitle(getState().threads[chatId]) === value.trim()) onClose();
      else setError('The chat could not be renamed. Try again.');
    } catch {
      setError('The chat could not be renamed. Try again.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Rename chat"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          autoFocus
          aria-label="Chat name"
          value={value}
          {...busyField(busy)}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setValue(event.target.value)}
        />
        {error && <p role="alert">{error}</p>}
        <button className="btn primary" disabled={busy || !value.trim()} type="submit">
          Save
        </button>
      </form>
    </Modal>
  );
}
