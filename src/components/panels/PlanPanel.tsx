// Read a plan beside its chat and annotate exact source lines into that chat's retained composer draft.
import { useRemoteFolderValue } from '../../lib/chatMachine';
import { RemoteFolderContext, useLinkCwd } from '../../lib/remoteFolder';
import { useMemo, useState, type ReactNode } from 'react';
import { useStore } from '../../store/core';
import { useSession } from '../../store/session/useSession';
import { planDocument, planReply, type PlanDocument, type PlanSelection } from '../../store/plans/document';
import { openPlanPane } from '../../store/plans/pane';
import { annotationAttachment } from '../../lib/annotations';
import { attachToComposer, deleteComposerAnnotation, retainComposerAnnotation } from '../../session/composerAttach';
import { openMessageLink } from '../../session/open';
import { settledText } from '../../lib/streamCut';
import { withKeys } from '../../lib/listKeys';
import { basename } from '../../lib/paths';
import { Markdown } from '../markdown/Markdown';
import { AnnotationComment } from '../composer/AnnotationComment';
import { FileText, MessageSquarePlus } from '../ui/icons';
import type { Attachment } from '../../store/types';
import { TodoSteps } from '../thread/items/TodoSteps';
import { useChatChecklist } from './useChatChecklist';

const NO_TURNS: never[] = [];

export function PlanPanel({ threadId, plan }: { threadId: string; plan?: PlanSelection }) {
  const turns = useStore((s) => s.runtime[threadId]?.turns ?? NO_TURNS);
  const cwd = useStore((s) => s.threads[threadId]?.cwd ?? '');
  const remoteFolder = useRemoteFolderValue(threadId, cwd);
  const { approvals } = useSession(threadId);
  const activeTurnId = useStore((s) => s.runtime[threadId]?.activeTurnId);
  const doc = useMemo(() => planDocument(turns, approvals, plan, activeTurnId), [turns, approvals, plan, activeTurnId]);
  const checklist = useChatChecklist(threadId);
  const steps = !plan && checklist && (
    <section className="plan-checklist" aria-label="Checklist">
      {doc && <h3>Checklist</h3>}
      {checklist.stale && <p className="muted">Plan from before your last message</p>}
      <TodoSteps steps={checklist.steps} active={!!activeTurnId && !checklist.stale} />
    </section>
  );
  const reply = !plan && !doc ? planReply(turns) : null;
  const replyAction = reply && (
    <button className="btn-pill" onClick={() => openPlanPane(threadId, { turnId: reply.turnId, itemId: reply.id, source: 'reply' })}>
      Use latest reply as plan
    </button>
  );
  if (!doc && steps)
    return (
      <section className="plan-pane" aria-label="Plan">
        <div className="plan-pane-toolbar">
          <span className="plan-pane-title">
            <FileText size={16} aria-hidden="true" /> Plan
          </span>
        </div>
        <div className="plan-pane-scroll">
          {steps}
          {replyAction}
        </div>
      </section>
    );
  if (!doc)
    return (
      <section className="plan-pane plan-pane-empty" aria-label="Plan">
        <FileText size={24} strokeWidth={1.5} />
        <p>{plan ? 'This plan is no longer in the loaded conversation.' : 'No plan has been proposed in this chat yet.'}</p>
        {replyAction}
      </section>
    );
  return (
    // a plan of a chat on a machine opens its file links there
    <RemoteFolderContext.Provider value={remoteFolder}>
      <PlanSnapshot key={JSON.stringify([threadId, doc.turnId, doc.id])} doc={doc} threadId={threadId} cwd={cwd} steps={steps} />
    </RemoteFolderContext.Provider>
  );
}

function PlanSnapshot({ doc, threadId, cwd, steps }: { doc: PlanDocument; threadId: string; cwd: string; steps: ReactNode }) {
  const linkCwd = useLinkCwd(cwd);
  const [commenting, setCommenting] = useState(false);
  const [editing, setEditing] = useState<{ line: number; attachment: Attachment } | null>(null);
  const attachments = useStore((s) => s.drafts[threadId]?.attachments);
  const retained = editing && attachments?.find((a) => a.annotationId === editing.attachment.annotationId);
  const source = settledText(doc.text, doc.streaming);
  const lines = source.split('\n');
  const add = (line: number) => {
    const quotePrompt = `Plan (${doc.id}), line ${line}:\n${lines[line - 1]}`;
    const attachment = { ...annotationAttachment(quotePrompt), name: 'Plan comment' };
    if (attachToComposer(threadId, attachment, { focus: false }) === false) return;
    setEditing({ line, attachment });
  };
  const update = (attachment: Attachment, annotation: string) => {
    const annotationId = attachment.annotationId!;
    // Update an open composer synchronously, and its retained copy when it is absent or disposed.
    window.dispatchEvent(new CustomEvent('composer-update-selection', { detail: { threadId, annotationId, annotation } }));
    retainComposerAnnotation(threadId, annotationId, annotation);
  };
  return (
    <section className="plan-pane" aria-label="Plan">
      <div className="plan-pane-toolbar">
        <span className="plan-pane-title">
          <FileText size={16} /> Plan
        </span>
        <button className="btn-pill" aria-pressed={commenting} onClick={() => setCommenting((v) => !v)}>
          {commenting ? 'Read plan' : 'Comment on lines'}
        </button>
      </div>
      {doc.path && (
        <button className="plan-pane-path" title={doc.path} onClick={(e) => openMessageLink(doc.path!, linkCwd, e)}>
          {basename(doc.path)}
        </button>
      )}
      <p className="plan-pane-hint">Comments are added to this chat’s draft. Review them in the composer before sending.</p>
      <div className="plan-pane-scroll">
        {!commenting && steps}
        {source ? (
          commenting ? (
            <div className="plan-source" role="list" aria-label="Plan source lines">
              {withKeys(lines, (text) => text).map(({ key, item: text, index }) => (
                <div className="plan-source-line" role="listitem" key={key}>
                  <span className="plan-source-number">{index + 1}</span>
                  <code>{text || '\u00a0'}</code>
                  <button
                    className="icon-btn xs"
                    disabled={!text.trim()}
                    aria-label={`Comment on plan line ${index + 1}`}
                    onClick={() => add(index + 1)}
                  >
                    <MessageSquarePlus size={15} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <Markdown text={source} cwd={cwd} streaming={doc.streaming} />
          )
        ) : (
          <p className="muted">Waiting for the plan text…</p>
        )}
      </div>
      {editing && retained && (
        <div className="plan-pane-comment" key={editing.attachment.annotationId}>
          <span>Comment on line {editing.line}</span>
          <blockquote>{editing.attachment.text}</blockquote>
          <AnnotationComment
            value={retained.annotation ?? ''}
            onChange={(text) => update(editing.attachment, text)}
            onSave={(text) => {
              update(editing.attachment, text);
              setEditing(null);
            }}
            onCancel={() => setEditing(null)}
            onDelete={() => {
              deleteComposerAnnotation(threadId, editing.attachment.annotationId!);
              setEditing(null);
            }}
          />
          <button className="btn-pill" onClick={() => setEditing(null)}>
            Done
          </button>
        </div>
      )}
    </section>
  );
}
