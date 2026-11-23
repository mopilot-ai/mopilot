// The person's name for a chat on this Host: kept on the chat's record (so a restart and every later automatic title know it), written to the family's own session where that family keeps a name (Claude Code, Codex), and told on the stream's state lane so every client follows it.
import { createRequire } from 'node:module';
import { HostRefusal } from './hostFs.mjs';

const require = createRequire(import.meta.url);
const { familyOf } = require('../../electron/session/contract/route.cjs');

/** Whether the person named the chat: an automatic title never replaces such a name. @param {{ records: Map<string, any> }} chats @param {string} chatId */
const namedByPerson = (chats, chatId) => chats.records.get(chatId)?.meta?.config?.titleNamed === true;

/**
 * Whether a runtime event is an automatic title for a chat the person named, which no client is told (Claude Code's helper title, Codex's thread name and an ACP chat's cut-short title all come this way).
 * @param {{ records: Map<string, any> }} chats @param {any} event
 */
export const dropsTitle = (chats, event) =>
  event.kind === 'threadName' && event.named !== true && typeof event.chatId === 'string' && namedByPerson(chats, event.chatId);

/**
 * @param {object} o
 * @param {{ records: Map<string, any>, patchMeta: (chatId: string, patch: object) => boolean }} o.chats the Host's chat records
 * @param {() => { ref: (chatId: string) => { kind: string, id: string } }} o.controller the chat's current native session
 * @param {{ claude: { turnApi: { rename: (sessionId: string, name: string) => Promise<void> } } } | undefined} o.claude the Claude Code family, when this Host runs it
 * @param {{ codex: { codexThread: (chatId: string) => string | null, threadRename: (threadId: string, name: string) => Promise<unknown> } } | undefined} o.codex the Codex family, when this Host runs it
 * @param {(event: object) => void} o.emit the Host's stream
 * @param {(message: string) => void} o.report where a step that failed is said
 * @returns {(chatId: string, name: string) => Promise<void>}
 */
export function createChatRename({ chats, controller, claude, codex, emit, report }) {
  /** The family's own naming of the session, for the families that have one. An ACP agent has none over ACP: its name is the one the Host and the apps keep. @type {Record<string, (chatId: string, name: string) => Promise<unknown>>} */
  const native = {
    claude: async (chatId, name) => {
      if (!claude) throw new Error('Claude Code is not available on this Host.');
      await claude.claude.turnApi.rename(controller().ref(chatId).id, name);
    },
    codex: async (chatId, name) => {
      const thread = codex?.codex.codexThread(chatId);
      if (!thread) throw new Error('This chat has no Codex thread yet.');
      await codex?.codex.threadRename(thread, name);
    },
  };
  return async (chatId, name) => {
    const config = chats.records.get(chatId)?.meta?.config;
    // the person's choice is kept before anything else is asked, so a title an agent writes meanwhile is dropped, and it survives a restart
    chats.patchMeta(chatId, { config: { ...(config && typeof config === 'object' ? config : {}), titleNamed: true } });
    if (!namedByPerson(chats, chatId)) throw new HostRefusal('chat_unknown', 'This machine has no such chat.');
    try {
      await native[familyOf(controller().ref(chatId).kind)]?.(chatId, name);
    } catch (error) {
      // best effort: the name stands on this Host and in every client, and the agent's own session keeps its old one
      report(`A chat's own session could not be renamed: ${/** @type {Error} */ (error).message}`);
    }
    emit({ kind: 'threadName', chatId, name, named: true });
  };
}
