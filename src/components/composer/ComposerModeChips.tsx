// The composer's mode chips after its + menu: the chat's mode or permission picker, and the Goal chip (which clears the
// pending goal mode) and Plan chip while they are on. A MoMo chat shows no picker (#2279): its brain chip sets the
// harness, and MoMo's isolation its access. In a started chat the host chip leads them (HostChip.tsx); a new chat picks its
// machine in the context bar's Run on chip instead (RunOnChip.tsx), so there is one place for it. The chat's Remote Control
// link shows in the summary panel's Session section, not here.
import { useCallback, useEffect } from 'react';
import { hostPermissionFamily } from '../../../shared/host/permissions.mjs';
import { hostFamilyOfHarness } from '../../../shared/host/chatIds.mjs';
import { hostAgentOf } from '../../store/machineChatSwitch';
import type { HarnessId } from '../../harness/types';
import { hostContinue } from '../../lib/hostContinue';
import { useChatOwner } from '../../lib/hostOwner';
import { useChatMachine } from '../../lib/chatMachine';
import { useHostAccess, useHostAnswered } from '../../lib/host';
import { useHostMachines } from '../../lib/hostMachines';
import { HostPermissionPicker } from './HostPermissionPicker';
import { useHostAgentChoice } from '../../session/useHostAgentChoice';
import { HostModeChip } from './HostModeChip';
import { useMomoChat } from '../momo/useMomoChat';
import { ModePicker, PermissionPicker } from './ComposerMenus';
import { CircleX, Lightbulb, Target, X } from '../ui/icons';
import { Tooltip } from '../ui/Popover';
import { get, upsertThread, useStore } from '../../store/core';
import { useSessionField } from '../../store/session/useSession';
import { dropGoneHostPick, newChatHostPick, pickNewChatHost } from '../../store/projects';
import { openAddMachine } from '../../lib/addMachine';
import { HostChip } from './HostChip';
import type { ContinueRequest } from './SwitchHostDialog';

/** Clear the pending goal mode; the draft text and any running goal stay independent. */
export function GoalChip({ onClear }: { onClear: () => void }) {
  return (
    <Tooltip label="Clear goal">
      <button className="goal-chip" aria-label="Clear goal" onClick={onClear}>
        <span className="goal-chip-icon" aria-hidden="true">
          <Target className="goal-chip-target" size={16} strokeWidth={1.7} />
          <CircleX className="goal-chip-clear" size={16} fill="currentColor" />
        </span>
        <span>Goal</span>
      </button>
    </Tooltip>
  );
}

/** Every machine this window has seen in main's resolved list. */
const seen = new Set<string>();

export function ComposerModeChips({
  threadId,
  basic,
  harness,
  goalMode,
  planMode,
  onClearGoal,
  onClearPlan,
}: {
  threadId: string | null;
  /** the chat's basic (ACP) harness, or null on a first-tier one */
  basic: string | null;
  harness: HarnessId | null;
  goalMode: boolean;
  planMode: boolean;
  onClearGoal: () => void;
  onClearPlan: () => void;
}) {
  const momo = useMomoChat(threadId);
  const running = useStore((s) => (threadId ? !!s.runtime[threadId]?.activeTurnId : false));
  // a message the machine has but the transcript does not show yet sits in the chat's queue as a row (electron/host/remoteSendProjection.cjs)
  const queued = useSessionField(threadId, (s) => s.queue.length > 0);
  const project = useStore((s) => (threadId ? s.threads[threadId]?.cwd : undefined)) ?? '';
  const { ownerId, known, refresh } = useChatOwner(threadId);
  const { machine, pending: machinePending } = useChatMachine(threadId);
  const choice = useHostAgentChoice();
  const draftAgent = choice?.choice?.harness ?? choice?.want;
  const remoteFamily = threadId ? (basic ? hostFamilyOfHarness(basic) : harness) : hostPermissionFamily(draftAgent ?? '');
  // a machine removed elsewhere (another window, the phone, an agent) takes a new chat's pick of it along
  const hostAllowed = useHostAccess();
  const hostAnswered = useHostAnswered();
  const listed = useHostMachines();
  const draftHost = useStore((s) => newChatHostPick(s));
  const restoredId = draftHost?.remembered ? draftHost.id : null;
  useEffect(() => {
    if (!hostAllowed || !listed.resolved || listed.registryUnreadable) return;
    const ids = new Set(listed.machines.map((m) => m.id));
    // A restored device can have been removed before this window ever sees its row.
    const gone = [...seen].filter((id) => !ids.has(id));
    if (restoredId && !ids.has(restoredId)) gone.push(restoredId);
    dropGoneHostPick(gone);
    for (const id of gone) seen.delete(id);
    for (const id of ids) seen.add(id);
  }, [hostAllowed, listed, restoredId]);
  // a new chat runs where the Run on chip picked it (newChatHostPick), this Mac when nothing was
  const host = threadId ? machine : draftHost;
  // whatever the outcome, the chat's owner is read again: an unsettled continue may have moved it
  const onContinue = useCallback(
    async (req: ContinueRequest) => {
      try {
        const done = await hostContinue.run(req);
        // the chat runs in the folder it was continued to: the summary header and the chip's folder follow it
        const thread = get().threads[req.chatId];
        if (thread) upsertThread({ ...thread, cwd: req.cwd });
        return done;
      } finally {
        refresh();
      }
    },
    [refresh],
  );
  const onPlan = useCallback((req: { chatId: string; targetHostId: string; cwd: string }) => hostContinue.plan(req), []);
  return (
    <>
      {!threadId && draftHost && !hostAllowed && hostAnswered ? (
        <button
          className="host-chip"
          type="button"
          title="Host access is unavailable"
          onClick={() => pickNewChatHost({ id: 'local', name: 'This Mac' })}
        >
          Use This Mac
        </button>
      ) : (
        threadId && (
          <HostChip
            turnRunning={running}
            queued={queued}
            chatId={threadId}
            project={project}
            ownerId={ownerId}
            ownerKnown={known}
            agent={hostAgentOf(threadId) || (harness ?? undefined)}
            onContinue={onContinue}
            onPlan={onPlan}
            onAddMachine={openAddMachine}
          />
        )
      )}
      {/* a basic harness's modes, else the first-tier permission menu; while neither id has resolved (the frame between a switch and the store catching up) the slot is empty. Machine first-tier chats offer only Host permission anchors; other remote agents keep their own locked modes */}
      {momo || machinePending ? null : host ? (
        remoteFamily ? (
          <HostPermissionPicker threadId={threadId} family={remoteFamily} hostId={host.id} />
        ) : (
          <HostModeChip machine={host.name} />
        )
      ) : basic && hostFamilyOfHarness(basic) ? null : basic ? (
        <ModePicker threadId={threadId} id={basic} />
      ) : harness ? (
        <PermissionPicker threadId={threadId} harness={harness} />
      ) : null}
      {goalMode && <GoalChip onClear={onClearGoal} />}
      {planMode && (
        <button className="plan-chip" onClick={onClearPlan} title="Turn plan mode off">
          <Lightbulb size={14} strokeWidth={1.8} />
          <span>Plan</span>
          <X size={12} strokeWidth={2} />
        </button>
      )}
    </>
  );
}
