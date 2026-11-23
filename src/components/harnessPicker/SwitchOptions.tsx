// The switch chip's Options: the switch sheet again for a switch that went ahead on one click, to choose how the
// conversation carries over (Summary, Workspace only) before the next message.
import { chatFamily } from '../../store/chats';
import { firstTierOf } from '../../harness/family';
import { isFirstTier } from '../../harness/adapter';
import type { PendingSwitch } from '../../harness/types';
import { setSelection } from '../../session/harness/select';
import { Popover, useAnchor } from '../ui/Popover';
import { applySwitch, switchModel } from './applySwitch';
import { AcpSwitchSheet } from './AcpSwitchSheet';
import { SwitchSheet, type SwitchChoices } from './SwitchSheet';

export function SwitchOptions({ threadId, p }: { threadId: string; p: PendingSwitch }) {
  const a = useAnchor<HTMLButtonElement>();
  const target = p.harness;
  const model = switchModel(target, p.model);
  const from = firstTierOf(chatFamily(threadId));
  // the account the switch was made on stays: Automatic, the one picked, or the chat's own there
  const account = p.automaticAccount ? null : (p.account ?? undefined);
  // only reached from a sheet, which shows only with a model
  const confirm = (c: SwitchChoices) => {
    const m = model!;
    a.close();
    void applySwitch(threadId, { target, model: m, account }, c, (effort) => {
      if (isFirstTier(target)) setSelection(target, { model: m.id || null, effort }, null);
    });
  };
  return (
    <>
      <button ref={a.ref} className="btn-pill" onClick={a.toggle} disabled={!model}>
        Options
      </button>
      {a.open && model && (
        <Popover anchor={a.anchor} open onClose={a.close} placement="top-start" className="picker">
          {from && isFirstTier(target) ? (
            <SwitchSheet
              threadId={threadId}
              from={from}
              target={target}
              model={model}
              account={account}
              ask
              onCancel={a.close}
              onConfirm={confirm}
            />
          ) : (
            <AcpSwitchSheet threadId={threadId} target={target} ask onCancel={a.close} onConfirm={confirm} />
          )}
        </Popover>
      )}
    </>
  );
}
