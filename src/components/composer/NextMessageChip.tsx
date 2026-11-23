// The composer's one "next message" slot: a pending harness switch in a chat, or a Cloud new chat on
// the home composer. Only one shows at a time (lib/statusStrip.ts); each says where the message goes
// and can be undone.
import { clearCloudDestination } from '../../store/repositoryDraft';
import { newChatKind } from '../../store/chats';
import { useStore } from '../../store/core';
import { useSessionField } from '../../store/session/useSession';
import { useCap } from '../../store/session/useCaps';
import { copy } from '../../harness/copy';
import { accountName } from '../../harness/accounts';
import { useHarnessAccounts } from '../../session/harness/select';
import { pickChip } from '../../lib/statusStrip';
import { HarnessIcon, SwitchChip } from '../harnessPicker/HarnessPicker';

/** Rendered only while a Cloud environment is chosen (NextMessageChip checks it). */
function CloudChip() {
  const { active } = useHarnessAccounts('codex');
  const account = active ? accountName(active) : undefined;
  const text = copy('routing', 'chipCloud', { account }).replace(/ · Undo$/, '');
  return (
    <div className="switch-chip" role="status">
      <HarnessIcon h="codex" size={13} />
      <span>{text}</span>
      <button className="switch-chip-x" onClick={clearCloudDestination}>
        Undo
      </button>
    </div>
  );
}

export function NextMessageChip({ threadId }: { threadId: string | null }) {
  const switching = !!useSessionField(threadId, (s) => s.pendingSwitch);
  const carrying = useStore((s) => !!threadId && !!s.handoffCarry[threadId]);
  const pendingSwitch = switching || carrying;
  const kind = useStore((s) => newChatKind(s));
  const cloudCap = useCap(null, 'cloud', { kind }).state === 'native';
  const cloud = useStore((s) => !!s.newChatCloudEnv);
  switch (pickChip({ switch: !!threadId && pendingSwitch, cloud: !threadId && cloudCap && cloud })) {
    case 'switch':
      return <SwitchChip threadId={threadId!} />;
    case 'cloud':
      return <CloudChip />;
    default:
      return null;
  }
}
