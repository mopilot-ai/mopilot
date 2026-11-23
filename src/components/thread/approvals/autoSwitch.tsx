// The site card's "Allow and switch to Auto" (Claude Desktop's choice, #1523), on every harness: the chat's own way to
// Approve for me, where ordinary sites need no card. Codex and Claude Code switch the composer's permission (where the
// model can auto-approve), a basic (ACP) harness the mode its quirks map onto Approve for me. Offered only from Ask.
import { useChatPermission } from '../../../session/useComposerHarness';
import { useStore } from '../../../store/core';
import { setChatConfig } from '../../../store/projects';
import { setPrefs } from '../../../store/core';
import { chatBasicHarness } from '../../../store/chats';
import { useComposerFirstTier, useEffectiveSelection } from '../../../session/harness/select';
import { chooseBasicMode, splitModes, useBasicSelection } from '../../../session/acpControls';
import type { HarnessId } from '../../../harness/types';
import { MenuItem } from '../../ui/Popover';

const LABEL = 'Allow and switch to Auto';
const DESCRIPTION = 'Approve for me reviews the rest of this chat.';

/** `onAllow` answers the card (this step once, with the switch) once the chat's mode has changed. */
export function AutoSwitchItem({ threadId, onAllow }: { threadId: string; onAllow: () => void }) {
  const basic = useStore((s) => chatBasicHarness(threadId, s));
  const harness = useComposerFirstTier(threadId);
  if (basic) return <BasicAuto threadId={threadId} basic={basic} onAllow={onAllow} />;
  return harness ? <FirstTierAuto threadId={threadId} harness={harness} onAllow={onAllow} /> : null;
}

function FirstTierAuto({ threadId, harness, onAllow }: { threadId: string; harness: HarnessId; onAllow: () => void }) {
  const permission = useChatPermission(threadId);
  // "Approve for me" only where the model can auto-approve, as the composer's picker has it (D-67)
  const noAuto = useEffectiveSelection(harness, threadId).model?.autoMode === false;
  if (noAuto || permission !== 'default') return null;
  const pick = () => {
    setPrefs({ permission: 'auto-review' });
    setChatConfig(threadId, { permission: 'auto-review' });
    onAllow();
  };
  return (
    <MenuItem description={DESCRIPTION} onSelect={pick}>
      {LABEL}
    </MenuItem>
  );
}

function BasicAuto({ threadId, basic, onAllow }: { threadId: string; basic: string; onAllow: () => void }) {
  const sel = useBasicSelection(threadId, basic);
  const entry = useStore((s) => s.basicHarnesses.find((h) => h.id === basic));
  const control = sel.mode;
  if (!control) return null;
  const rows = splitModes(control, entry?.permissionModes, entry?.agentModes).permission;
  const auto = rows.find((r) => r.permission === 'auto-review');
  if (!auto || rows.find((r) => r.id === control.current)?.permission !== 'default') return null;
  // a mode the harness refuses is said in a toast and the card stays for another answer
  const pick = () => void chooseBasicMode(threadId, basic, sel, auto.id).then((ok) => ok && onAllow());
  return (
    <MenuItem description={DESCRIPTION} onSelect={pick}>
      {LABEL}
    </MenuItem>
  );
}
