// Whether a chat's Finished section in the Background tasks tab is open, kept across reloads in localStorage (only the collapsed chats are stored).
const KEY = 'mopilot.finishedClosed';
const MAX_CHATS = 100;

let closed: string[] | null = null;

function load(): string[] {
  if (closed) return closed;
  closed = [];
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (Array.isArray(saved)) closed = saved.filter((id): id is string => typeof id === 'string');
  } catch (e) {
    // unreadable or blocked storage: every section starts open
    console.warn('Could not read which Finished sections are collapsed', e);
  }
  return closed;
}

/** Whether the chat's Finished section is open; it is, until the user collapses it. */
export const finishedOpenFor = (chatId: string): boolean => !load().includes(chatId);

/** Remember that the chat's Finished section was opened or collapsed. */
export function setFinishedOpen(chatId: string, open: boolean) {
  const rest = load().filter((id) => id !== chatId);
  closed = open ? rest : [...rest, chatId].slice(-MAX_CHATS);
  try {
    localStorage.setItem(KEY, JSON.stringify(closed));
  } catch (e) {
    // storage full or blocked: it still holds for this window
    console.warn('Could not save which Finished sections are collapsed', e);
  }
}
