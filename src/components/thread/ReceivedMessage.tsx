// One message another session sent, as Claude Desktop 4.29.0 shows it: "Received message from <sender>" (the name opens
// that session) with the message itself behind a "Show message from <sender>" toggle, closed until the user opens it.
import { ChatLink, useChatName } from '../markdown/ChatLink';
import { useMessageOpen } from '../../lib/sideMessageOpen';

/** What a sender reads as while this window knows no title or handle for it (as the queue row words it, src/lib/queued.ts). */
const UNKNOWN_SENDER = 'another session';

/**
 * `openKey` names the row for the window's memory of what was opened (src/lib/sideMessageOpen.ts); `name` is the title
 * kept with the message, for a sender this window no longer lists (an archived chat).
 */
export function ReceivedMessage({ from, body, openKey, name }: { from: string; body: string; openKey?: string; name?: string | null }) {
  const [open, setOpen] = useMessageOpen(openKey);
  const sender = useChatName(from) ?? name ?? UNKNOWN_SENDER;
  return (
    <div className="side-session-note">
      <div className="side-session-note-head">
        <span>
          Received message from <ChatLink id={from}>{sender}</ChatLink>
        </span>
        <button type="button" className="side-session-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Show'} message from {sender}
        </button>
      </div>
      {open && <div className="side-session-text">{body}</div>}
    </div>
  );
}
