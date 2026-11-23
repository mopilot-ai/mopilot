// A harness switch the user confirmed in the switch sheet: the goal paused, queued messages left behind given back, the
// switch recorded for the chat's next message. The model picker and the notice of a chat whose harness is down share it.
import { get as getState, toast } from '../../store/core';
import { giveBackToComposer, removeQueued } from '../../store/send';
import { pauseGoal } from '../../store/actions';
import { sessionOf, setSession } from '../../store/session/useSession';
import { turnBusy, type QueuedMessage } from '../../store/session/sessionState';
import { userQueued } from '../../harness/switchPlan';
import { harnessModels, selectionFor } from '../../session/harness/select';
import { isAcpThread, type HarnessModel } from '../../harness/types';
import { isFirstTier, type HarnessKind } from '../../harness/adapter';
import { errorText, noteIgnored } from '../../lib/ignored';
import { native } from '../../lib/native';
import { hostAllowedNow } from '../../lib/host';
import { automaticModel } from '../../harness/automaticModel';
import type { SwitchChoices } from './SwitchSheet';

/** The model a switch to `target` goes on: the one the harness would use, else its default; undefined while it loads. */
export function switchModel(target: HarnessKind, requested?: string | null): HarnessModel | undefined {
  // ACP's native session keeps its recorded model, or starts on its configured default.
  if (!isFirstTier(target)) return { id: '', label: '', efforts: [], defaultEffort: null, fast: false };
  const models = harnessModels(target);
  const want = requested === undefined ? selectionFor(target).model : requested;
  if (!want) return automaticModel(models);
  return models.find((x) => x.id === want) ?? models.find((x) => x.isDefault) ?? models[0];
}

/**
 * Record the confirmed switch of `threadId` to `target` on `model` (and `account`, when one was picked). `select`
 * sets the target's model and effort the way the asking picker does.
 */
export async function applySwitch(
  threadId: string,
  { target, model, account }: { target: HarnessKind; model: HarnessModel; account?: string | null },
  c: SwitchChoices,
  select: (effort: string | null) => void,
) {
  // a chat that runs on a machine is that machine's agent: a switch here would be dropped, and one left pending could later start a session on this Mac in the machine's folder.
  // Only an ACP-kind id can name such a chat, and only while Host exists for the account: any other switch makes no call and awaits nothing here.
  const owner =
    hostAllowedNow() && isAcpThread(threadId)
      ? await Promise.resolve()
          .then(() => native.host.owner(threadId))
          .catch((e) => (noteIgnored("read a chat's host before switching its harness", e), null))
      : null;
  if (owner && owner.hostId !== 'local') {
    toast('This chat runs on another machine. Continue it on this Mac to switch agents.', 'error');
    return;
  }
  const session = sessionOf(threadId);
  // Pausing a goal also interrupts its turn. A switch selected during a run waits
  // for that turn to finish; only an idle goal can be paused here.
  if (session.goal?.status === 'active' && !turnBusy(session) && !getState().runtime[threadId]?.activeTurnId)
    // best effort: the goal may already have ended; the switch proceeds either way
    await pauseGoal(threadId).catch((e) => noteIgnored("pause a chat's goal before switching its harness", e));
  // queued messages the user left behind go back to the composer instead of out to the new harness; what another session
  // sent (a message, a wake-up) or no human wrote is not the user's text to edit, so it stays queued and runs on the new harness
  const mine = userQueued(session.queue);
  if (c.queued === 'leave' && mine.length) {
    const back: QueuedMessage[] = [];
    const failed: string[] = [];
    for (const q of mine) {
      try {
        // false: it already left the queue (sent), so it isn't brought back as well
        if (await removeQueued(threadId, q.id)) back.push(q);
      } catch (e) {
        // still queued: bringing it back too would send it twice
        failed.push(errorText(e));
      }
    }
    // into the composer on screen (or its draft), with their attachments; a goal as the /goal it was typed as
    if (back.length)
      giveBackToComposer(
        threadId,
        back
          .map((q) => (q.opts?.goal ? `/goal ${q.opts.goal}` : q.text))
          .filter(Boolean)
          .join('\n\n'),
        back.flatMap((q) => q.attachments ?? []),
      );
    if (failed.length)
      toast(
        failed.length === 1
          ? `Couldn't take a queued message back: ${failed[0]}. It stays queued.`
          : `Couldn't take ${failed.length} queued messages back: ${failed[0]}. They stay queued.`,
        'error',
      );
  }
  select(c.multiAgent && model.efforts.includes('ultra') ? 'ultra' : c.effort);
  // cannot reject: a write main didn't take is put right from main's copy
  void setSession(threadId, {
    pendingSwitch: {
      harness: target,
      model: model.id || null,
      modelLabel: model.label,
      mode: c.mode,
      goal: c.goal,
      multiAgent: c.multiAgent,
      account: account ?? null,
      ...(account === null ? { automaticAccount: true } : {}),
    },
  });
  window.dispatchEvent(new Event('focus-composer'));
}
