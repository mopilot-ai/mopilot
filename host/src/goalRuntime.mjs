// What the Host's runtime does for `chat.goal`: it hands the goal bar's action to the family the chat runs on now (Claude Code's adapter, Codex's app-server), as the app does for a chat on this Mac, and refuses for an agent that has no goals with the words a chat of that agent shows here.
import { HostRefusal } from './hostFs.mjs';
import { agentLabel } from '../../shared/host/agentReadiness.mjs';

/**
 * @param {object} o
 * @param {{ records: { has: (chatId: string) => boolean } }} o.chats the Host's chats
 * @param {{ has: (chatId: string) => boolean }} o.state the SessionStore
 * @param {{ ref: (chatId: string) => { kind: string } }} o.controller what a chat runs on now
 * @param {(kind: string) => string} o.familyOf the family a chat's kind runs on
 * @param {{ goal?: (p: { chatId: string, action: string, human?: boolean }) => Promise<unknown> } | undefined} o.claude Claude Code's family, when this Host runs it
 * @param {{ goal?: (p: { chatId: string, action: string, tokens?: number | null, objective?: string }) => Promise<unknown> } | undefined} o.codex Codex's family, when this Host runs it
 */
export function goalRuntime({ chats, state, controller, familyOf, claude, codex }) {
  return {
    /**
     * The goal the chat has after its goal bar's action: the goal, or null.
     * @param {{ chatId: string, action: string, human?: boolean, tokens?: number | null, objective?: string }} p
     */
    async goal(p) {
      const { chatId } = p;
      if (!chats.records.has(chatId) && !state.has(chatId)) throw new HostRefusal('chat_unknown', 'This machine has no such chat.');
      const { kind } = controller.ref(chatId);
      const family = familyOf(kind);
      const owner = family === 'claude' ? claude : family === 'codex' ? codex : undefined;
      // a basic agent keeps its goal to itself (a /goal it lists is typed as a message): the words a chat of that agent shows on this Mac
      if (family === 'acp') throw new HostRefusal('unsupported', `${agentLabel(kind.replace(/^acp:/, ''))} doesn't support goals`);
      if (!owner?.goal) throw new HostRefusal('unsupported', `${agentLabel(family)} is not available on this Host.`);
      return owner.goal(p);
    },
  };
}
