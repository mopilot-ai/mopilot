// Model-picker routing and the public harness icon, usage and switch-indicator entrypoint.
import { BasicPicker } from './BasicPicker';
import { FirstTierPicker } from './FirstTierPicker';
import { useComposerHarness } from '../../session/useComposerHarness';
import { useStore } from '../../store/core';
import { newChatHostPick } from '../../store/projects';
import { HostModelPicker } from '../composer/HostModelPicker';
import { useHostChats, machineOfChat } from '../../lib/hostChats';
export { HarnessIcon, BasicHarnessIcon, BasicBadge, UsageMeters, signInHarness, ThreadHarnessBadge } from './badges';
export { SwitchChip } from './SwitchChip';

export function ModelPicker({ threadId }: { threadId: string | null }) {
  const { basic, harness } = useComposerHarness(threadId);
  // a new chat in a folder on another machine picks among that machine's agents, not this Mac's
  const draftHost = useStore((s) => (!threadId ? newChatHostPick(s)?.id : null));
  const owner = machineOfChat(useHostChats(), threadId);
  if (owner === null)
    return (
      <button className="model-btn" disabled>
        Reading machine…
      </button>
    );
  const hostId = draftHost || owner;
  if (hostId) return <HostModelPicker threadId={threadId} hostId={hostId} />;
  if (basic) return <BasicPicker threadId={threadId} id={basic} />;
  // the frame between a switch to a basic harness and the store catching up has neither id: nothing to draw
  return harness ? <FirstTierPicker threadId={threadId} h={harness} /> : null;
}
