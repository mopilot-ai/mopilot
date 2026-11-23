// A thread item main delivered for linked sessions, shown as what it is instead of as the user's words: the brief
// that started this chat, the wake-up that brought the notes of the sessions it started, or a family message (each a
// "Received message from …" row behind Show message, as Claude Desktop shows it, components/thread/ReceivedMessage.tsx).
import { useState } from 'react';
import type { SideSessionDelivery } from '../../../shared/orchestration';
import { withKeys } from '../../lib/listKeys';
import { ChatLink } from '../markdown/ChatLink';
import { ReceivedMessage } from './ReceivedMessage';
import { chatHarnessLabel } from '../../store/chats';
import { copyText } from '../../session/clipboard';
import { ChevronDown, Copy } from '../ui/icons';
import { harnessInfo } from '../../harness/registry';
import type { HarnessKind } from '../../harness/adapter';

/** New deliveries retain the harness that authored them; a parent's later switch cannot rewrite their history. */
function sourceHarness(delivery: { harness?: string }, chatId: string) {
  return delivery.harness ? (harnessInfo(delivery.harness as HarnessKind)?.label ?? 'Assistant') : chatHarnessLabel(chatId);
}

/** A brief's task and context are separate steps; legacy deliveries keep their complete body as the task. */
function BriefStep({ label, title, text }: { label: string; title?: string; text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 600 || text.split('\n').length > 6;
  return (
    <div className="side-session-brief-step">
      <div className="side-session-brief-label">
        <span>{label}</span>
        {title && <span className="side-session-brief-title">{title}</span>}
        <button
          type="button"
          className="icon-btn"
          aria-label={`${label} actions`}
          onClick={() => copyText(text, `Copied ${label.toLowerCase()}`)}
        >
          <Copy size={13} />
        </button>
      </div>
      <div className={long && !open ? 'side-session-text folded' : 'side-session-text'}>{text}</div>
      {long && (
        <button type="button" className="side-session-more" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

function Brief({ delivery }: { delivery: Extract<SideSessionDelivery, { kind: 'brief' }> }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="side-session-card side-session-brief" data-kind="brief">
      <div className="side-session-brief-head">
        <button
          type="button"
          className="icon-btn"
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} session brief`}
          onClick={() => setOpen(!open)}
        >
          <ChevronDown size={14} style={{ transform: open ? undefined : 'rotate(-90deg)' }} />
        </button>
        <span>{delivery.fork ? 'Forked from' : `Started by ${sourceHarness(delivery, delivery.from)} from`}</span>
        <ChatLink id={delivery.from} />
      </div>
      {open && (
        <div className="side-session-brief-steps">
          <BriefStep label="Task" title={delivery.title} text={delivery.task ?? delivery.body} />
          {delivery.context && <BriefStep label="Context" text={delivery.context} />}
        </div>
      )}
    </div>
  );
}

/** `itemKey` is the key main delivered the item under (src/lib/sideSessions.ts), which names its rows for what was opened. */
export function SideSessionCard({ delivery, itemKey }: { delivery: SideSessionDelivery; itemKey?: string }) {
  if (delivery.kind === 'brief') return <Brief delivery={delivery} />;
  if (delivery.kind === 'wake')
    return (
      <div className="side-session-card side-session-wake" data-kind="wake">
        <div className="side-session-wake-head">
          The app asked {sourceHarness(delivery, delivery.chatId)} to report back
          {delivery.notes.length > 1 && <span> · Received {delivery.notes.length} messages</span>}
        </div>
        {withKeys(delivery.notes, (n) => `${n.childId}\n${n.body}`).map(({ key, item: n, index }) => (
          <ReceivedMessage key={key} from={n.childId} body={n.body} openKey={itemKey && `${itemKey}/${index}`} />
        ))}
      </div>
    );
  return (
    <div className="side-session-card side-session-wake" data-kind={delivery.kind}>
      <ReceivedMessage from={delivery.from} body={delivery.body} openKey={itemKey} />
    </div>
  );
}
