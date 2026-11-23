// Adapter-reported recovery and compaction-loop notices on every harness; quiet work keeps only its activity line.
import { useShallow } from 'zustand/react/shallow';
import { useStore, toastFailure } from '../../store/core';
import { chatOf } from '../../store/chats';
import { chatAgentTabs } from '../../lib/agentTabs';
import { interrupt } from '../../store/send';
import { liveAction } from '../../store/liveAction';
import { nativeOf } from '../../store/chats';
import { useSession } from '../../store/session/useSession';
import { harnessLabelOf } from '../../harness/registry';
import { turnStall, compactionLoop, COMPACTING_NEXT_STEP } from '../../lib/turnStall';
import type { TurnState } from '../../store/types';
import { Minimize2, Spinner } from '../ui/icons';

/** Computer-use states where the user holds the turn: they took over, a permission waits, or the desktop is theirs. */
const PERSON_HOLDS = new Set(['takeover', 'permission', 'waiting']);

export function TurnStall({ threadId, readOnly }: { threadId: string; readOnly: boolean }) {
  const { turn, retry } = useStore(
    useShallow((s) => {
      const rt = s.runtime[threadId];
      return { turn: rt?.turns.find((t) => t.id === rt.activeTurnId), retry: rt?.retry ?? null };
    }),
  );
  const approval = useStore((s) => s.pending.some((p) => p.threadId === threadId));
  // a browser tab handed to the user (browser_request_signin): the chat waits on them, not on its harness (#1834)
  const handedOver = useStore((s) => !!s.agentTabs && !!chatAgentTabs(s.agentTabs, threadId, chatOf)?.tabs.some((t) => !!t.signin));
  const ss = useSession(threadId);
  const running = turn?.status === 'inProgress';
  // an approval, a question, a hand-off, the user taking over, a Chrome approval or another app: the turn waits on a person
  const asked =
    approval ||
    handedOver ||
    ss.approvals.length > 0 ||
    ss.questions.length > 0 ||
    ss.chromeApproval ||
    (ss.computer != null && PERSON_HOLDS.has(ss.computer.state));
  const stall = turnStall({ turn, retry, asked });
  if (!stall) return null;
  const label = harnessLabelOf(nativeOf(threadId));
  const said =
    stall.kind === 'retry' ? stall.text : `${label} compacted its context ${stall.count} times in a row without getting further.`;
  return (
    <div className="retry-banner turn-stall" role="status">
      {stall.kind === 'retry' ? <Spinner size={13} /> : <Minimize2 size={13} />}
      <div className="turn-stall-text">
        <div>{said}</div>
        {stall.kind === 'compacting' && <div className="turn-stall-next">{COMPACTING_NEXT_STEP}</div>}
      </div>
      {running && !readOnly && stall.kind === 'compacting' && (
        <div className="turn-stall-actions">
          <button className="btn-pill" onClick={() => void liveAction(interrupt(threadId, turn.id)).catch(toastFailure("Couldn't stop"))}>
            Stop
          </button>
        </div>
      )}
    </div>
  );
}

/** A turn that stopped or failed in a compaction loop says why, in the turn, read back too (its items are the record). */
export function CompactionLoopNote({ turn }: { turn: Pick<TurnState, 'status' | 'items'> }) {
  if (turn.status === 'inProgress' || turn.status === 'completed') return null;
  const count = compactionLoop(turn.items);
  if (!count) return null;
  return (
    <div className="retry-banner turn-stall" role="note">
      <Minimize2 size={13} />
      <div className="turn-stall-text">
        <div>The context was compacted {count} times in a row without getting further.</div>
        <div className="turn-stall-next">{COMPACTING_NEXT_STEP}</div>
      </div>
    </div>
  );
}
