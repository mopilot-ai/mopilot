// What this Host's chats answer a continue, for every family it runs (#4906, #4911): whether it serves a chat, whether a turn or a waiting message holds it, how it lets the chat go, and how a chat that arrives is bound to the agent it was continued on.
import { UnsupportedError } from './errors.mjs';
import { canonicalHarness } from '../../shared/host/continueFamilies.mjs';
import { estimateTokens } from '../../shared/handoff.mjs';
import { parseKind } from '../../shared/harnessKind.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { emptyRecord, segment } = require('../../electron/platform/chatRecord.cjs');

/**
 * @param {object} o
 * @param {any} o.chats the Host's ChatsStore
 * @param {any} o.state the SessionStore
 * @param {() => any} o.controller
 * @param {any} o.acpHost
 * @param {{ startNative: (chatId: string, harness: string, cwd: string, model: null, claimed: string[]) => Promise<{ nativeId: string }> }} o.switcher starts a native session on any family, as a switch does
 * @param {{ acp: boolean, claude: boolean, codex: boolean }} o.provided
 * @param {Record<string, string>} o.labels how the person knows a family
 * @param {(chatId: string) => boolean} o.starting a message was taken off the chat's queue and its turn has not started
 * @param {(chatId: string) => void} o.discard drops the chat's waiting messages and held choice
 * @param {(chatId: string) => Promise<unknown>} o.cancel stops the chat's running turn
 * @param {(chatId: string, harness: string) => void} o.announce tells the chat's clients which agent it runs on
 * @param {(chatId: string, family: string) => Promise<void>} o.ready refuses an agent that cannot start a session for the chat
 */
export function createContinueRuntime({
  chats,
  state,
  controller,
  acpHost,
  switcher,
  provided,
  labels,
  starting,
  discard,
  cancel,
  announce,
  ready,
}) {
  /** The ACP sessions that belong to a chat: its own id, and the key of the agent session its record names. @param {string} chatId */
  const acpKeys = (chatId) => [...new Set([chatId, chats.records.has(chatId) ? controller().ref(chatId).key : chatId])];
  /** The chats whose agent is being bound now, so a second message does not start a second session. @type {Map<string, Promise<void>>} */
  const binding = new Map();
  return {
    /** This Host runs the chat: an ACP session it holds, or a record of its own for any family. @param {string} chatId */
    continueServes: (chatId) => acpKeys(chatId).some((key) => acpHost.chats.has(key)) || chats.records.has(chatId),
    /** A turn is running or waits on a person, or a message waits behind it: the chat cannot move yet. @param {string} chatId */
    continueBusy(chatId) {
      if (acpKeys(chatId).some((key) => !!acpHost.chats.get(key)?.prompting || acpHost.starting.has(key))) return true;
      if (starting(chatId)) return true;
      if (!state.has(chatId)) return false;
      const s = state.get(chatId);
      return ['running', 'awaitingUser'].includes(s.turn) || s.queue.length > 0;
    },
    /** The chat moved away: what it still runs here stops, whichever family runs it. @param {string} chatId */
    async continueRetire(chatId) {
      discard(chatId);
      await cancel(chatId);
      for (const key of acpKeys(chatId)) if (acpHost.chats.has(key)) await acpHost.close(key);
    },
    /**
     * The chat's agent is the one it was continued on, whatever its id spells (a bare Codex thread id has no rollout here): a session of that family in the folder, recorded as the chat's own, before its first message goes. One that is already bound for this handoff (the Host restarted since) is kept.
     * @param {{ chatId: string, harness: string, cwd: string, text: string, id?: string }} p `id` names this continue's handoff (its text stands in for an older one that has none)
     */
    async bindContinued({ chatId, harness: asked, cwd, text, id }) {
      const harness = canonicalHarness(asked);
      const kind = parseKind(harness);
      if (!kind) return;
      if (!provided[kind.family]) throw new UnsupportedError(`${labels[kind.family]} is not available on this Host.`);
      const rec = chats.records.get(chatId);
      const last = rec?.segments[rec.segments.length - 1];
      const bound = last?.kind === harness && last.handoff?.mode === 'continue' && (last.handoff.id ?? last.handoff.text) === (id ?? text);
      const open = binding.get(chatId);
      if (open) return open;
      const run = (async () => {
        // the session this handoff started is kept while the agent still holds it; one it lost before the chat's first message (Codex keeps nothing of a thread no message recorded, so a restart forgets it, #5160) is started again, with the same handoff
        if (bound && !(await controller().sessionGone(chatId))) return;
        await ready(chatId, kind.family);
        /** @type {string[]} */
        const claimed = [];
        try {
          const { nativeId } = await switcher.startNative(chatId, harness, cwd, null, claimed);
          const made = segment({
            kind: harness,
            nativeId,
            handoff: { mode: 'continue', tokens: estimateTokens(text), text, ...(id ? { id } : {}) },
          });
          // the chat's earlier session here (a chat that came back) is not the one it continues on
          if (!chats.commit(rec ? { ...rec, segments: [made] } : emptyRecord(chatId, [made], Date.now())))
            throw new Error("Couldn't record the chat's new session.");
          controller().invalidate();
          announce(chatId, harness);
        } finally {
          for (const key of claimed) controller().unclaim(key, chatId);
        }
      })().finally(() => binding.delete(chatId));
      binding.set(chatId, run);
      return run;
    },
  };
}
