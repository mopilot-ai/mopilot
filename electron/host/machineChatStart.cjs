// Starting a chat on one of the user's machines, for the composer (host:startChat) and for a scheduled run alike: the same checks (the machine is listed, the agent is installed there, and signed in there or run with the user's key or lease), then the folder is recorded with the machine, the first message is set to start the chat there, and the chat is followed.
const crypto = require('node:crypto');
const { appIdPrefix, isHostFamily } = require('../../shared/host/chatIds.mjs');
const { HARNESS_LABEL } = require('../../shared/handoff.mjs');
const { refusalWords } = require('../../shared/host/refusalWords.mjs');

/** What the user calls the agent in a refusal: Claude Code and Codex by name, a basic agent by its id. @param {string} harness */
const harnessName = (harness) => (isHostFamily(harness) ? HARNESS_LABEL[/** @type {'claude' | 'codex'} */ (harness)] : harness);

/** @param {string} message @param {string} code */
const refusal = (message, code) => Object.assign(new Error(message), { code });

/**
 * @param {object} o
 * @param {(id: string) => any} o.row a machine's row in the registry (machines.cjs), or null when it is not listed
 * @param {{ hasFor: (harness: string) => boolean }} o.apiKeys the user's model keys (apiKeys.cjs)
 * @param {{ covers: (harness: string) => boolean }} o.orgAccess the organization's leases (orgAccess/service.cjs)
 * @param {(chatId: string, at: { hostId: string, folder: string }) => unknown} o.bind records the chat's folder with its machine (folders.cjs)
 * @param {(chatId: string, start: { harness: string, projectId: string | null, credential?: { source: string, login?: string }, scope?: string, sideChat?: import('../../shared/host/sideChats.mjs').SideChatStart }) => unknown} o.begin the chat's first message starts it there (remoteSend.cjs begin)
 * @param {(chatId: string) => Promise<unknown> | unknown} o.follow follows the chat's stream (remoteChats.cjs)
 */
function createMachineChatStart({ row, apiKeys, orgAccess, bind, begin, follow }) {
  /**
   * Why a chosen credential is not there, or null. @param {any} there the agent's record on the machine @param {string} harness @param {string} machine @param {{ source: string }} credential
   */
  function missingCredential(there, harness, machine, credential) {
    const ask = (/** @type {string} */ code, /** @type {Record<string, unknown>} */ details = {}) =>
      refusal(/** @type {{ line: string }} */ (refusalWords(code, { machine, agent: harness, details })).line, code);
    if (credential.source === 'own' && !there.signedIn && there.unsure !== true) return ask('login_signed_out');
    if (credential.source === 'key' && !(there.takesKey === true && apiKeys.hasFor(harness)))
      return ask('credential_unavailable', { cause: 'key' });
    if (credential.source === 'org' && !(there.takesOrg === true && orgAccess.covers(harness)))
      return ask('credential_unavailable', { cause: 'org' });
    return null;
  }

  /**
   * How an agent on a machine stands for a chat started now: ready because it is signed in there ('machine') or because this Mac lends it
   * a key or a lease with each message ('lent'); else a refusal with the user's words and its code.
   * An explicit `credential` is checked against what exists now (the machine's own sign-in, the key or lease this Mac holds) and refused in words when it is not there;
   * the Host checks it again and never falls back (host/src/chatCredentials.mjs).
   * @param {string} hostId @param {string} harness @param {{ source: string, login?: string }} [credential]
   * @param {boolean} [withParent] a temporary draft inherits its parent's login, checked by the Host when it sends
   * @returns {{ ok: true, by: 'machine' | 'lent', machine: any } | { ok: false, error: Error }}
   */
  function readiness(hostId, harness, credential, withParent = false) {
    const machine = row(hostId);
    if (!machine) return { ok: false, error: refusal('That machine is not in the list.', 'unknown_machine') };
    if (withParent) return { ok: true, by: 'machine', machine };
    const there = machine.harnesses?.find((/** @type {any} */ h) => h.id === harness && h.detected);
    if (!there)
      return {
        ok: false,
        error: refusal(
          /** @type {{ line: string }} */ (refusalWords('agent_missing', { machine: machine.name, agent: harness })).line,
          'harness_not_configured',
        ),
      };
    if (credential) {
      const missing = missingCredential(there, harness, machine.name, credential);
      return missing ? { ok: false, error: missing } : { ok: true, by: credential.source === 'own' ? 'machine' : 'lent', machine };
    }
    // a basic agent signs in on the machine itself, outside MoPilot: installed is ready
    if (!isHostFamily(harness) || there.signedIn) return { ok: true, by: 'machine', machine };
    // Claude Code and Codex are signed in per machine, or run with the user's key: a chat started with neither would fail at its first message
    const keyed = (there.takesKey === true && apiKeys.hasFor(harness)) || (there.takesOrg === true && orgAccess.covers(harness));
    if (keyed) return { ok: true, by: 'lent', machine };
    // `unsure`: the Host could not read the sign-in in time; the send itself reports the real cause
    if (there.unsure === true) return { ok: true, by: 'machine', machine };
    return {
      ok: false,
      error: refusal(
        /** @type {{ line: string }} */ (refusalWords('agent_signed_out', { machine: machine.name, agent: harness })).line,
        'harness_not_configured',
      ),
    };
  }

  /**
   * A new chat on the machine, under the id the caller made for it; throws the refusal when it can't start there.
   * @param {{ chatId: string, hostId: string, folder: string, harness: string, projectId?: string | null, credential?: { source: string, login?: string }, scope?: string, sideChat?: import('../../shared/host/sideChats.mjs').SideChatStart }} q
   * @param {{ background?: boolean }} [o] `background`: the chat is listed meanwhile (`listed` resolves then), not before this returns: the stream is subscribed before a message goes anyway (remoteSend `subscribed`)
   */
  async function start({ chatId, hostId, folder, harness, projectId = null, credential, scope, sideChat }, { background = false } = {}) {
    if (!chatId || !hostId || !folder || !harness || !chatId.startsWith(appIdPrefix(harness)))
      throw refusal('Pick a machine, a folder and an agent.', 'invalid');
    const r = readiness(hostId, harness, credential, Boolean(sideChat));
    if (!r.ok) throw r.error;
    if (scope !== undefined && scope !== r.machine.hostKey)
      throw refusal('This machine changed. Choose where to run the chat again.', 'machine_changed');
    bind(chatId, { hostId, folder });
    begin(chatId, {
      harness: isHostFamily(harness) ? harness : `acp:${harness}`,
      projectId,
      ...(credential && { credential }),
      ...(scope !== undefined && { scope }),
      ...(sideChat && { sideChat }),
    });
    const listed = Promise.resolve(follow(chatId));
    if (!background) {
      await listed;
      return { chatId, by: r.by };
    }
    // a failure to follow is the follow's to report; the chat is bound and its message is kept either way
    return {
      chatId,
      by: r.by,
      listed: listed.then(
        () => undefined,
        () => undefined,
      ),
    };
  }

  return {
    readiness,
    start,
    /** A new chat id for the agent on a machine (`acp:host-claude:<uuid>` for Claude Code, shared/host/chatIds.mjs). @param {string} harness */
    newChatId: (harness) => `${appIdPrefix(harness)}${crypto.randomUUID()}`,
  };
}

module.exports = { createMachineChatStart, harnessName };
