// What a Host's refusal of a queued message says in the chat's queue: the cause naming the machine and the agent, the one action that fixes it, and whether Retry can succeed, from the machine's row as it stands now (shared/host/refusalWords.mjs is the one table).
'use strict';
const { refusalWords } = require('../../shared/host/refusalWords.mjs');
const { agentsOf } = require('../../shared/host/agentReadiness.mjs');

/** Errors that say the Host could not be reached, the request is gone, or this app could not read its own outbox, not that the Host refused: the machine's own "Waiting for host" says what is true, and the message stays queued. */
const TRANSIENT = new Set(['host_unreachable', 'request_retired', 'outbox_unreadable']);
/** Refusals this app itself gives before a message goes (a folder it cannot read on the machine, the organization's sign-in service), worded by the same table. */
const OWN = new Set(['directory_missing', 'org_unavailable', 'feature_missing', 'version_refused', 'unsupported', 'key_unreadable']);

/** What a machine that is no longer listed is called. */
const NO_NAME = 'the machine';

/** The chat's agent id from the kind the chat runs (`claude`, `codex`, `acp:gemini`). @param {string | undefined} kind */
const agentIdOf = (kind) => (kind ? kind.replace(/^acp:/, '') : undefined);

/**
 * @param {object} o
 * @param {(hostId: string) => any} o.rowOf the machine's registry row (its name and the harnesses it reported)
 * @param {(chatId: string) => string | undefined} o.kindOf the kind the chat runs
 * @param {(chatId: string) => { hostId: string }} o.ownerOf
 */
function createRefusalView({ rowOf, kindOf, ownerOf }) {
  /** How the chat's agent stands on its machine now, and whether that Host installs it itself. @param {string} chatId */
  function standing(chatId) {
    const row = rowOf(ownerOf(chatId).hostId);
    const agent = agentIdOf(kindOf(chatId));
    const name = row?.name || NO_NAME;
    const found = agent ? agentsOf(row?.harnesses ?? [], name).find((a) => a.id === agent) : undefined;
    const installable = !!agent && row?.harnesses?.find((/** @type {any} */ h) => h.id === agent)?.installable === true;
    return { name, agent, state: /** @type {any} */ (found?.state ?? null), installable, hostId: ownerOf(chatId).hostId };
  }

  return {
    /** Whether the error is a Host's refusal (the Host answered with it, or it is one this app gives itself); anything else (an unreachable machine, a disk error here, a client torn down mid-send) is the caller's to report. @param {any} error */
    isRefusal: (error) =>
      typeof error?.code === 'string' &&
      !TRANSIENT.has(error.code) &&
      (error.fromHost === true || error.app === true || OWN.has(error.code)),
    /** The refusal as kept with the queued message: the code and the Host's sentence, and how the agent stood then. @param {string} chatId @param {any} error */
    record: (chatId, error) => ({
      code: String(error.code),
      message: String(error?.message ?? ''),
      details: error?.details && typeof error.details === 'object' ? error.details : undefined,
      agentWas: standing(chatId).state,
      // this app's own refusal of the message, not a word from the machine: the sentence does not blame it
      own: error.fromHost !== true,
    }),
    /**
     * What the row says now. A code the table does not know shows the Host's own sentence with Retry.
     * @param {string} chatId @param {{ code: string, message: string, details?: Record<string, unknown>, agentWas?: any, own?: boolean }} refusal
     * @returns {{ line: string, action: string | null, retry: boolean, mode?: string, named?: true, agent?: string, machine: string, hostId: string }}
     */
    view(chatId, refusal) {
      const s = standing(chatId);
      const words = refusalWords(refusal.code, {
        machine: s.name,
        agent: s.agent,
        message: refusal.message,
        details: refusal.details,
        agentState: s.state,
        agentWas: refusal.agentWas,
        installable: s.installable,
        own: refusal.own === true,
      }) ?? { line: refusal.message || 'The host refused it.', action: null, retry: true };
      // a machine that is no longer listed has no name to say: "the machine" still starts a sentence with a capital
      const line = words.line.startsWith(NO_NAME) ? `The ${words.line.slice(4)}` : words.line;
      return { ...words, line, ...(s.agent ? { agent: s.agent } : {}), machine: s.name, hostId: s.hostId };
    },
  };
}

module.exports = { createRefusalView, TRANSIENT };
