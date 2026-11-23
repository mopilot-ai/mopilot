// Pending harness-switch cancellation and summary-carry indicators.
import { useStore, set as setState } from '../../store/core';
import { setSession, useSession } from '../../store/session/useSession';
import type { HarnessId, PendingSwitch } from '../../harness/types';
import { isFirstTier } from '../../harness/adapter';
import { harnessInfo } from '../../harness/registry';
import { switchAccountLabel, useChatAccount, useHarnessAccounts } from '../../session/harness/select';
import { HarnessIcon } from './badges';
import { SwitchOptions } from './SwitchOptions';
import { useMomoChat } from '../momo/useMomoChat';
import { undoMachineSwitch } from '../../store/machineChatSwitch';

export function clearPendingSwitch(threadId: string) {
  // cannot reject: a write main didn't take is put right from main's copy
  void setSession(threadId, { pendingSwitch: null });
  // a chat on a machine: its Host holds the choice too
  undoMachineSwitch(threadId);
}

function PendingAccount({
  threadId,
  target,
  account,
  automatic,
}: {
  threadId: string;
  target: HarnessId;
  account: PendingSwitch['account'];
  automatic?: boolean;
}) {
  const own = useChatAccount(target, threadId);
  const name = switchAccountLabel(account, own, useHarnessAccounts(target), automatic);
  return name ? <> · {name}</> : null;
}

/** Above the composer while a switch waits for the next message. */
export function SwitchChip({ threadId }: { threadId: string }) {
  const p = useSession(threadId).pendingSwitch;
  const carry = useStore((s) => s.handoffCarry[threadId]);
  const momo = useMomoChat(threadId);
  if (!p && carry)
    return (
      <div className="switch-chip">
        <span>
          Your first message carries {carry.issue ? 'issue' : 'a summary of'} <b>{carry.fromTitle}</b>
        </span>
        <button
          className="switch-chip-x"
          aria-label={carry.issue ? "Don't carry the issue" : "Don't carry the summary"}
          onClick={() =>
            setState((st) => ({ handoffCarry: Object.fromEntries(Object.entries(st.handoffCarry).filter(([k]) => k !== threadId)) }))
          }
        >
          ×
        </button>
      </div>
    );
  if (!p) return null;
  return (
    <div className="switch-chip">
      <HarnessIcon h={p.harness} size={13} />
      <span>
        Next message continues on{' '}
        <b>
          {harnessInfo(p.harness)?.label ?? p.harness}
          {p.modelLabel ? ` · ${p.modelLabel}` : ''}
          {isFirstTier(p.harness) && (
            <PendingAccount threadId={threadId} target={p.harness} account={p.account} automatic={p.automaticAccount} />
          )}
        </b>
      </span>
      {/* MoMo's brain set this switch, and only its brain chip changes it (main refuses a window's, shared/momoCommands.mjs) */}
      {!momo && <SwitchOptions threadId={threadId} p={p} />}
      {!momo && (
        <button className="btn-pill" aria-label="Cancel switch" onClick={() => clearPendingSwitch(threadId)}>
          Undo
        </button>
      )}
    </div>
  );
}
