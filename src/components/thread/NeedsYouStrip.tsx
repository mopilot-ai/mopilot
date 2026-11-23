// Child requests mirrored in the parent's transcript, open by default; every approval or ACP form keeps its child owner.
import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../store/core';
import { linkedChildren, nestedFamily, useOrchestration } from '../../lib/sideSessions';
import { useChatRowState } from '../../session/useChatRowState';
import type { SideSessionChild } from '../../../shared/orchestration';
import { ChatLink } from '../markdown/ChatLink';
import { Approvals } from './Approvals';
import { openChatFrom } from '../../session/openChat';
import { AcpQuestions } from './AcpQuestions';
import { ChevronDown } from '../ui/icons';
import { useChatName } from '../markdown/ChatLink';

function NeedsYouRow({
  chatId,
  linked,
  report,
}: {
  chatId: string;
  linked: SideSessionChild;
  report: (id: string, waiting: boolean) => void;
}) {
  const row = useChatRowState(chatId, linked);
  const cwd = useStore((s) => s.threads[chatId]?.cwd ?? '');
  const [open, setOpen] = useState(true);
  const name = useChatName(chatId) ?? chatId;
  const waiting = row?.state === 'approval' || row?.state === 'input';
  useEffect(() => {
    report(chatId, waiting);
    return () => report(chatId, false);
  }, [chatId, waiting, report]);
  if (!waiting) return null;
  return (
    <div className="needs-you-row" data-state={row!.state}>
      <div className="needs-you-head">
        <span className="row-dot waiting" aria-hidden="true" />
        <span className="needs-you-text">
          Request from <ChatLink id={chatId} className="needs-you-name" />
        </span>
        <span className="needs-you-status">Needs input</span>
        <button
          type="button"
          className="icon-btn"
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} request from ${name}`}
          onClick={() => setOpen(!open)}
        >
          <ChevronDown size={14} style={{ transform: open ? undefined : 'rotate(-90deg)' }} />
        </button>
        <button type="button" className="btn-pill soft" onClick={(e) => openChatFrom(e, chatId, { newWindow: false })}>
          Open
        </button>
      </div>
      {open && (
        <div className="needs-you-answer">
          <Approvals threadId={chatId} cwd={cwd} />
          <AcpQuestions threadId={chatId} readOnly={false} />
        </div>
      )}
    </div>
  );
}

function NeedsYouRequests({ threadId }: { threadId: string }) {
  const view = useOrchestration();
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(() => new Set());
  // Combine independent row updates; one request finishing cannot clear another child's announcement.
  const report = useCallback(
    (id: string, pending: boolean) =>
      setWaiting((before) => {
        if (before.has(id) === pending) return before;
        const next = new Set(before);
        if (pending) next.add(id);
        else next.delete(id);
        return next;
      }),
    [],
  );
  const kids = nestedFamily(view, linkedChildren(view, threadId), Object.keys(view.children));
  if (!kids.length) return null;
  return (
    <div className="needs-you" role="region" aria-label="Sessions waiting on you">
      {waiting.size > 0 && (
        <span className="sr-only" role="status">
          {waiting.size} nested {waiting.size === 1 ? 'session needs' : 'sessions need'} input
        </span>
      )}
      {kids.map((id) => (
        <NeedsYouRow key={id} chatId={id} linked={view.children[id]} report={report} />
      ))}
    </div>
  );
}

/** A different parent retires its disclosures and announcement set together, even when the view is reused. */
export function NeedsYouStrip({ threadId }: { threadId: string }) {
  return <NeedsYouRequests key={threadId} threadId={threadId} />;
}
