// What a session did in its own worktree, under its live card (SessionCard.tsx): git's facts (commits, files changed,
// lines, its pull request), and, once it is not working, "Merge into <branch>" and "Open PR". The app reads the facts
// and runs the actions (electron/session/orchestration/bringBack.cjs); the user's click is what authorizes them.
import { useState } from 'react';
import { toast } from '../../store/core';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import type { SessionFacts, SideSessionChild, SessionWorkResult } from '../../../shared/orchestration';
import { pluralize } from '../../lib/format';
import type { TurnPhase } from '../../session/useChatRowState';
import { retryChatState } from '../../session/useChatRowState';

/** The facts as one line: "+120 −14 · 3 files · 2 commits · 1 uncommitted". */
export function factsLine(f: SessionFacts): string {
  const parts = [`+${f.added} −${f.removed}`, pluralize(f.files, 'file'), pluralize(f.ahead, 'commit')];
  if (f.uncommitted) parts.push(`${f.uncommitted} uncommitted`);
  return parts.join(' · ');
}

/** What the card says a Merge or Open PR that didn't go through came to, or null for one that did. */
export function workNote(r: SessionWorkResult): string | null {
  if (r.status === 'conflicts') return `Conflicts with ${r.into} in ${r.files.join(', ')}: merge it yourself, or ask the session to.`;
  if (r.status === 'refused') return r.message;
  return null;
}

export function SessionWork({
  chatId,
  linked,
  settled,
  parentTurn,
  readOnly = false,
}: {
  chatId: string;
  linked: SideSessionChild;
  settled: boolean;
  parentTurn: TurnPhase | null;
  readOnly?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const f = linked.facts;
  if (!f) return null;
  const act = async (action: 'merge' | 'pr') => {
    setBusy(true);
    setNote(null);
    try {
      setNote(workNote(await native.orchestration.child(chatId, action)));
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  // actions only for work that is done for now and has commits to bring back
  const actions = !readOnly && settled && f.ahead > 0 && !linked.merged;
  return (
    <div className="session-work">
      <span className="session-work-facts">{factsLine(f)}</span>
      {linked.merged && (
        <span className="session-work-merged">
          Merged into {linked.merged.into} ({linked.merged.commit})
        </span>
      )}
      {f.pr && (
        <button
          type="button"
          className="session-work-link"
          onClick={() => native.shell.openExternal(f.pr!.url).catch((e) => toast(errorText(e), 'error'))}
        >
          PR #{f.pr.number} · {f.pr.state.toLowerCase()}
        </button>
      )}
      {actions && (
        <span className="session-work-actions">
          <button type="button" className="btn-pill soft" disabled={busy || parentTurn !== 'idle'} onClick={() => void act('merge')}>
            Merge into {f.base}
          </button>
          {!f.pr && (
            <button type="button" className="btn-pill soft" disabled={busy} onClick={() => void act('pr')}>
              Open PR
            </button>
          )}
        </span>
      )}
      {actions && parentTurn !== 'idle' && (
        <span className="session-work-wait" role="status">
          {parentTurn === null ? (
            <>
              Checking this chat’s status…{' '}
              <button type="button" className="session-work-link" onClick={() => void retryChatState(linked.parentId)}>
                Retry
              </button>
            </>
          ) : (
            'Wait until this chat is idle before merging.'
          )}
        </span>
      )}
      {note && (
        <span className="session-work-note" role="status">
          {note}
        </span>
      )}
    </div>
  );
}
