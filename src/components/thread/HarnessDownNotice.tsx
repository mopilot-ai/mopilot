// In place of the composer while the harness a chat's next message goes to is down: the chat can't send, its history
// may be read from disk, its queue stays in view, and the ways forward: start that harness again, or continue the chat
// in another one.
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, toast, toastFailure } from '../../store/core';
import { chatHarnessLabel, harnessUsable } from '../../store/chats';
import { HARNESS_DOWN } from '../../store/harnessDown';
import { useSession } from '../../store/session/useSession';
import { HARNESS_IDS, HARNESS_LABEL, type HarnessId, type HarnessModel } from '../../harness/types';
import { currentFamily, firstTierOf, type HarnessFamily } from '../../harness/family';
import { setSelection } from '../../session/harness/select';
import { Popover } from '../ui/Popover';
import { SwitchSheet } from '../harnessPicker/SwitchSheet';
import { applySwitch, switchModel } from '../harnessPicker/applySwitch';
import { clearPendingSwitch } from '../harnessPicker/SwitchChip';
import { AlertTriangle } from '../ui/icons';
import { QueuedList } from '../composer/QueuedList';
import { isFirstTier } from '../../harness/adapter';
import { MomoModel, useMomoChat } from '../momo/useMomoChat';

/** The harness the chat's next message goes to (a switch picked for it, else its own) while that harness is down, or null. */
export function useDownHarness(threadId: string): HarnessFamily | null {
  const pending = useSession(threadId).pendingSwitch;
  const family = useStore((s) =>
    pending ? (isFirstTier(pending.harness) ? pending.harness : 'acp') : currentFamily(s.segments[threadId], threadId),
  );
  const down = useStore((s) => HARNESS_DOWN[family].down(s));
  return down ? family : null;
}

export function HarnessDownNotice({ threadId, family }: { threadId: string; family: HarnessFamily }) {
  const fromDisk = useStore((s) => !!s.runtime[threadId]?.fromDisk);
  // the harness the chat is on: a switch picked away from it can be dropped instead
  const own = useStore((s) => firstTierOf(currentFamily(s.segments[threadId], threadId)));
  // ACP starts lazily on send, so its composer remains available between messages.
  // a MoMo chat goes on elsewhere by its brain chip (MoMo's brain sets the switch, in main), never by a switch here
  const momo = useMomoChat(threadId);
  const others = useStore(useShallow((s) => (own && !momo ? HARNESS_IDS.filter((h) => h !== family && harnessUsable(h, s)) : [])));
  const [sheet, setSheet] = useState<{ target: HarnessId; model: HarnessModel; el: HTMLElement } | null>(null);
  const label = firstTierOf(family) ? HARNESS_LABEL[family as HarnessId] : chatHarnessLabel(threadId);
  const { restart } = HARNESS_DOWN[family];

  const go = (target: HarnessId, el: HTMLElement) => {
    // the switch picked was to the harness that is down: the chat goes on where it is
    if (target === own) return clearPendingSwitch(threadId);
    const model = switchModel(target);
    if (!model) return toast(`${HARNESS_LABEL[target]} is still loading its models`);
    setSheet({ target, model, el });
  };

  return (
    <>
      {/* what the chat has queued stays in view (to steer, or remove), as it does above the composer */}
      <QueuedList threadId={threadId} />
      <div className="elsewhere-notice" role="status">
        <span className="elsewhere-icon">
          <AlertTriangle size={14} />
        </span>
        <div className="elsewhere-text">
          <div className="elsewhere-title">{label} isn't running, so this chat can't send.</div>
          {fromDisk && <div className="elsewhere-body">Its messages are read from disk until it runs again.</div>}
        </div>
        <div className="elsewhere-actions">
          {restart && (
            <button className="btn-pill" onClick={() => restart().catch(toastFailure(`Couldn't restart ${label}`))}>
              Restart {label}
            </button>
          )}
          {momo && <MomoModel />}
          {others.map((h) => (
            <button key={h} className="btn-pill" onClick={(e) => go(h, e.currentTarget)}>
              Continue in {HARNESS_LABEL[h]}
            </button>
          ))}
        </div>
        {sheet && (
          <Popover anchor={sheet.el} open onClose={() => setSheet(null)} placement="top-end" className="picker">
            <SwitchSheet
              threadId={threadId}
              from={own!}
              target={sheet.target}
              model={sheet.model}
              onCancel={() => setSheet(null)}
              onConfirm={(c) => {
                const { target, model } = sheet;
                setSheet(null);
                void applySwitch(threadId, { target, model }, c, (effort) =>
                  setSelection(target, { model: model.id, effort, ...(model.fast ? {} : { fast: false }) }),
                );
              }}
            />
          </Popover>
        )}
      </div>
    </>
  );
}
