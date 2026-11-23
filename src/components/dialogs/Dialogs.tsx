// App dialogs: those opened by window events (the bug report (/bug, /feedback), /status, the context card, /design-login), and "Allow Chrome to connect?" while main asks.

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/core';
import { chatHarnessLabel, chatFamily, newChatFamily, newChatBasic, nativeOf } from '../../store/chats';
import { copyText } from '../../session/clipboard';
import { reportedTokenUsage } from '../../store/contextUsage';
import { useChatContext } from '../../session/useChatContext';
import { useContextSnapshot } from '../../session/useContextSnapshot';
import { Modal } from '../ui/Modal';
import { DesignLoginDialog, OPEN_DESIGN_LOGIN } from './DesignLoginDialog';
import { BugReportDialog } from './BugReportDialog';
import { ChromeAllowDialog } from './ChromeAllowDialog';
import { ContextCard, OPEN_CONTEXT } from '../context/ContextCard';
import { OPEN_BUG_REPORT, type BugReportRequest } from '../../lib/bugReportEvent';
import { HARNESS_LABEL, type HarnessId } from '../../harness/types';
import { firstTierOf } from '../../harness/family';
import { acpModelName, basicLabel } from '../../session/harness/acp';
import { useSession } from '../../store/session/useSession';
import { chatAccountLabel, pinnedElsewhere, useEffectiveSelection } from '../../session/harness/select';
import { useChatAccountView } from '../../session/harness/chatAccountView';
import { accountName } from '../../harness/accounts';
import { resetWhen, usedNow } from '../../harness/usageWindows';
import { statusRows } from '../../harness/entries';
import { ArchiveFamilyDialog } from './ArchiveFamilyDialog';

/** The bug report, "/status" and context dialogs, opened through window events (the slash menu, the Help menu, Settings), and Chrome's allow question. */
export function Dialogs() {
  const [report, setReport] = useState<{ request: BugReportRequest; generation: number } | null>(null);
  const [status, setStatus] = useState<{ threadId: string | null; generation: number } | null>(null);
  const generation = useRef(0);
  const currentReport = useRef<number | null>(null);
  const [design, setDesign] = useState<{ threadId: string | null } | null>(null);
  const [context, setContext] = useState<{ threadId: string; generation: number } | null>(null);
  useEffect(() => {
    // a second open replaces the first dialog; a send the first one started still reports (BugReportDialog)
    const f = (e: Event) => {
      currentReport.current = ++generation.current;
      const d = (e as CustomEvent<BugReportRequest | null>).detail;
      setReport({ request: { threadId: d?.threadId ?? null, kind: d?.kind }, generation: currentReport.current });
    };
    const s = (e: Event) => setStatus({ threadId: (e as CustomEvent).detail ?? null, generation: ++generation.current });
    const d = (e: Event) => setDesign({ threadId: (e as CustomEvent).detail ?? null });
    // a card is a chat's: one opened without a chat has nothing to show
    const c = (e: Event) => {
      const threadId = (e as CustomEvent).detail;
      if (typeof threadId === 'string' && threadId) setContext({ threadId, generation: ++generation.current });
    };
    window.addEventListener(OPEN_BUG_REPORT, f);
    window.addEventListener('open-status', s);
    window.addEventListener(OPEN_CONTEXT, c);
    window.addEventListener(OPEN_DESIGN_LOGIN, d);
    return () => {
      window.removeEventListener(OPEN_BUG_REPORT, f);
      window.removeEventListener('open-status', s);
      window.removeEventListener(OPEN_CONTEXT, c);
      window.removeEventListener(OPEN_DESIGN_LOGIN, d);
    };
  }, []);
  return (
    <>
      {report && (
        <BugReportDialog
          key={report.generation}
          request={report.request}
          onClose={() => {
            if (currentReport.current !== report.generation) return;
            currentReport.current = null;
            setReport(null);
          }}
        />
      )}
      {status && <StatusDialog key={status.generation} threadId={status.threadId} onClose={() => setStatus(null)} />}
      {context && <ContextCard key={context.generation} threadId={context.threadId} onClose={() => setContext(null)} />}
      {design && <DesignLoginDialog threadId={design.threadId} onClose={() => setDesign(null)} />}

      <ChromeAllowDialog />
      <ArchiveFamilyDialog />
    </>
  );
}

/** One Status for every chat: the rows are read from the harness the chat is on now. */
function StatusDialog({ threadId, onClose }: { threadId: string | null; onClose: () => void }) {
  const h = firstTierOf(useStore(() => (threadId ? chatFamily(threadId) : newChatFamily())));
  const nativeId = useStore(() => (threadId ? nativeOf(threadId) : null));
  return h ? (
    <FirstTierStatus key={JSON.stringify([h, threadId, nativeId])} h={h} threadId={threadId} onClose={onClose} />
  ) : (
    <BasicStatus threadId={threadId} onClose={onClose} />
  );
}

/** The session's tokens: main's count (every report, with no window open too), else this window's; never a zero nobody counted. */
function useTotalTokens(threadId: string | null): number | null {
  const usage = useStore((s) => (threadId ? reportedTokenUsage(s, threadId) : null));
  const snapshot = useContextSnapshot(threadId, "read a chat's tokens for Status");
  return snapshot?.session?.totalTokens ?? (usage?.total.totalTokens || null);
}

/** A basic harness signs in, bills and limits on its own: its Status names it, its model and the context it reported. */
function BasicStatus({ threadId, onClose }: { threadId: string | null; onClose: () => void }) {
  // a new chat is on a basic harness only when one is picked (newChatFamily)
  const label = useStore(() => (threadId ? chatHarnessLabel(threadId) : basicLabel(newChatBasic()!)));
  const totalTokens = useTotalTokens(threadId);
  const model = acpModelName(useSession(threadId).acp?.configOptions);
  const rows = statusRows({
    chatId: threadId,
    harnessLabel: label,
    model,
    effort: null,
    account: null,
    context: useChatContext(threadId, "read a chat's context use for Status"),
    totalTokens,
    limits: [],
  });
  return <StatusSheet threadId={threadId} rows={rows} onClose={onClose} />;
}

function FirstTierStatus({ h, threadId, onClose }: { h: HarnessId; threadId: string | null; onClose: () => void }) {
  const totalTokens = useTotalTokens(threadId);
  const sel = useEffectiveSelection(h, threadId);
  // the account this chat runs on (one pinned or moved to another login), as the harness picker shows it
  const { status, def, accounts, own, account, windows } = useChatAccountView(h, threadId);
  const elsewhere = !!account && !!def && account.id !== def.id;
  const context = useChatContext(threadId, "read a chat's context use for Status");
  const rows = statusRows({
    chatId: threadId,
    harnessLabel: HARNESS_LABEL[h],
    model: sel.model?.label ?? sel.modelId,
    effort: sel.effort,
    // named as every place names a chat's account: "Pinned to B · now on A" while its pin can't serve it
    account:
      elsewhere || pinnedElsewhere(own)
        ? chatAccountLabel(own, accounts)
        : def?.unverified
          ? accountName(def)
          : (status.email ?? status.plan),
    context,
    totalTokens,
    limits: windows.map((w) => ({ label: w.label, usedPercent: usedNow(w), reset: resetWhen(w) })),
  });
  return <StatusSheet threadId={threadId} rows={rows} onClose={onClose} />;
}

function StatusSheet({ threadId, rows, onClose }: { threadId: string | null; rows: [string, string][]; onClose: () => void }) {
  return (
    <Modal title="Status" onClose={onClose}>
      <div className="status-grid">
        {rows.map(([k, v]) => (
          <div key={k} className="status-row">
            <span>{k}</span>
            <span className={k === 'Chat ID' ? 'mono' : ''}>{v}</span>
          </div>
        ))}
      </div>
      {threadId && (
        <div className="sketch-foot">
          <button className="btn-pill" onClick={() => copyText(threadId, 'Copied chat ID')}>
            Copy chat ID
          </button>
        </div>
      )}
    </Modal>
  );
}
