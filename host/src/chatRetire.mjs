// What a chat's deletion takes off this Host's disk besides its journal: the chat's record and transcript (threads/) and the agent's own session where its family keeps one, and a fence so no late event writes the record back.
import { createRequire } from 'node:module';
import { createAgentLeftovers } from './agentLeftovers.mjs';

/** An ACP chat's id, which is the key of its transcript on this Host. */
const ACP_ID = /^acp:[^:]+:.+$/;

const require = createRequire(import.meta.url);
const { nativeGone } = require('../../electron/session/chatDeletion.cjs');
const { toRendererSegment } = require('../../electron/platform/chats.cjs');
const { familyOf } = require('../../electron/session/contract/route.cjs');

/**
 * The agent sessions a chat names, one per segment (a chat that moved to another agent has one for each). A Host's chat id is the client's own (Codex names its threads itself, and the record ties the id to the thread), so the sessions are what the record says, not what the id spells.
 * @param {InstanceType<typeof import('../../electron/platform/chats.cjs').ChatsStore>} chats @param {string} chatId @param {Set<string>} gone the chats deleted in this process (their record may still be on disk until their own deletion is done: they do not hold a session)
 * @returns {{ kind: string, nativeId: string, key: string }[]}
 */
function sessionsOf(chats, chatId, gone) {
  if (chats.newer.has(chatId) || chats.unreadable.has(chatId)) throw new Error('Chat metadata is read-only');
  // never from the request's own id: a chat with no record has no agent session to find, except an ACP chat, whose transcript is the Host's and named by the chat's id
  const record = chats.records.get(chatId) ?? (ACP_ID.test(chatId) ? chats.record(chatId) : null);
  const seen = new Map();
  for (const segment of record?.segments ?? []) {
    // a session another chat's record names is that chat's: deleting this chat leaves it, until that chat is deleted too (a deleted chat's record may still be on disk)
    const shared = [...chats.records].some(
      ([id, other]) =>
        id !== chatId && !gone.has(id) && other.segments.some((o) => o.kind === segment.kind && o.nativeId === segment.nativeId),
    );
    if (shared) continue;
    const key = toRendererSegment(segment).nativeId;
    seen.set(`${segment.kind}\n${key}`, { kind: segment.kind, nativeId: segment.nativeId, key });
  }
  return [...seen.values()];
}

/**
 * @param {object} o
 * @param {InstanceType<typeof import('../../electron/platform/chats.cjs').ChatsStore>} o.chats the Host's chat records
 * @param {{ remove: (key: string) => void }} o.acpHost closes an ACP chat's session and removes its transcript
 * @param {{ claude: { deleteSession: (sessionId: string) => Promise<unknown> } } | undefined} o.claude the Claude Code family, when this Host runs it
 * @param {{ codex: { threadDelete: (threadId: string) => Promise<unknown> } } | undefined} o.codex the Codex family, when this Host runs it
 * @param {NodeJS.ProcessEnv} [o.env] the agents' environment (CODEX_HOME, CLAUDE_CONFIG_DIR), where their own stores are
 * @param {(message: string) => void} o.report where a chat whose record cannot be read is said
 * @param {(line: string) => void} [o.log] the Host's log: one content-free line (ids and what happened) for each session removed
 * @returns {(chatId: string) => Promise<void>} rejects with what could not be removed (the deletion is run again, as every step is safe to repeat)
 */
export function createChatRetire({ chats, acpHost, claude, codex, env = process.env, report, log = () => undefined }) {
  const leftovers = createAgentLeftovers({ env });
  /** The chats deleted in this process: their record is never written again, whatever event still arrives for them. @type {Set<string>} */
  const gone = new Set();
  chats.isDeleted = (id) => gone.has(id);
  chats.admitCommit = (record) => !gone.has(record.id);
  /** Each family removes its own session; ACP's is the Host's own transcript. @type {Record<string, (target: { key: string, nativeId: string }) => Promise<unknown> | unknown>} */
  const native = {
    acp: (target) => acpHost.remove(target.key),
    claude: (target) => claude?.claude.deleteSession(target.nativeId),
    codex: (target) => codex?.codex.threadDelete(target.nativeId),
  };
  /** What the agent's own delete may leave in its store, removed by the Host (an ACP agent keeps its own history out of reach: it has no delete over ACP). @type {Record<string, (target: { nativeId: string }) => Promise<string[]>>} */
  const sweep = {
    claude: (target) => leftovers.claude(target.nativeId),
    codex: (target) => leftovers.codex(target.nativeId),
  };
  return async (chatId) => {
    // before anything is awaited: from here on no event brings the record back
    gone.add(chatId);
    const failed = [];
    /** @type {{ kind: string, nativeId: string, key: string }[]} */
    let targets = [];
    try {
      targets = sessionsOf(chats, chatId, gone);
    } catch (error) {
      // a record this Host cannot read (or a newer build wrote) names no session: its files still go, its agent's session is left where it is
      report(`A deleted chat's agent sessions could not be found: ${/** @type {Error} */ (error).message}`);
      log(`[delete] chat=${chatId} its record could not be read, so its agent sessions were not deleted`);
    }
    for (const target of targets) {
      const family = familyOf(target.kind);
      const at = `[${family}-delete] chat=${chatId} session=${target.nativeId}`;
      let outcome = 'deleted';
      try {
        await native[family](target);
      } catch (error) {
        // a session its agent no longer has is deleted already
        if (!nativeGone(family, error)) {
          failed.push(/** @type {Error} */ (error).message);
          log(`${at} failed: ${String(/** @type {Error} */ (error).message).slice(0, 160)}`);
          continue;
        }
        outcome = 'gone';
      }
      // the agent's delete done (or not needed), what it left in its own store goes too
      try {
        const left = (await sweep[family]?.(target)) ?? [];
        log(`${at} ${outcome}${left.length ? `; left in its store and removed: ${left.join(', ')}` : ''}`);
      } catch (error) {
        failed.push(/** @type {Error} */ (error).message);
        log(`${at} ${outcome}; its store could not be cleaned: ${String(/** @type {Error} */ (error).message).slice(0, 160)}`);
      }
    }
    // the record names the sessions a retry removes, so it stays until every one is gone
    if (failed.length) throw new Error(failed.join(' '));
    chats.forgetDeleted(chatId);
  };
}
