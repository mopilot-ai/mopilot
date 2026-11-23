// How a Claude Code or Codex chat on a machine runs a semantic (src/store/session/runSemantic.ts): its goal goes to the machine's agent (`chat.goal`), which decides what the goal bar's action means for its agent. The chat is drawn here as an ACP chat (`acp:host-claude`, `acp:host-codex`), so these handlers are registered under those kinds.
import { ownTable } from '../../../../shared/ownTable.mjs';
import { runMachineGoal } from '../../../store/machineChatGoal';
import type { Semantic } from '../../../harness/adapter';
import type { SemanticHandler } from '../../../harness/adapters/semantics';

export const HOST_HANDLERS: Partial<Record<Semantic, SemanticHandler>> = ownTable({
  // args: pause | resume | extend | clear | clear human | budget <tokens|none> | edit <objective>
  goal: ({ chatId, args }) => runMachineGoal(chatId, args),
});
