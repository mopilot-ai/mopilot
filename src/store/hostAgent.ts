// Which agent a chat on a machine runs on now: read by menus and confirmations that must not load the session store (machineChatSwitch.ts, which re-exports it, sends the switch).
import { agentOfKind, hostFamilyOfHarness } from '../../shared/host/chatIds.mjs';
import { chatBasicHarness } from './chats';
import { get } from './core';

/** The agent a chat on a machine runs on now: the one its Host last said after a switch, else the one the chat's id names ('claude', 'codex' or a basic agent's bare id); '' when unknown. @param {string} chatId */
export function hostAgentOf(chatId: string): string {
  const basic = chatBasicHarness(chatId);
  return agentOfKind(get().chatConfig[chatId]?.hostAgent) ?? hostFamilyOfHarness(basic ?? '') ?? basic ?? '';
}
