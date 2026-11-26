// A machine's remote Host that lends the user's model credential with each message: the organization's lease when there is one (#3361 Tier 2, orgAccess/service.cjs), else the user's model key (Tier 1): before a chat's first message or a later one goes out, the key its harness takes (apiKeys.cjs) is sent with `host.modelKey` on the control channel, never with the message, so it is not in the outbox, the Host's ledger or its journal. A key taken back is sent as none.
const { KEYED } = require('../../shared/host/credentials.mjs');

/** The harness of a chat by the id the Host knows it by (shared/host/chatIds.mjs): `claude:<id>` is Claude Code, `acp:…` is a basic agent, a bare id is a Codex thread. @param {string} hostChatId */
const harnessOfChat = (hostChatId) => (hostChatId.startsWith('claude:') ? 'claude' : hostChatId.startsWith('acp:') ? 'acp' : 'codex');

/** The family a lease is minted for: a basic agent's start names it `acp:<id>`. @param {unknown} harness */
const familyOf = (harness) => (typeof harness !== 'string' ? '' : harness.startsWith('acp:') ? 'acp' : harness);

/** The agent whose own key a chat's start takes: a basic agent by its id (`acp:gemini`, or a chat id `acp:gemini:<uuid>`, is Gemini), else the family. @param {unknown} harness */
const agentOf = (harness) => (typeof harness === 'string' && harness.startsWith('acp:') ? harness.split(':')[1] : familyOf(harness));

/**
 * @template {{ start: (chatId: string, item: any, opts?: any) => Promise<any>, send: (chatId: string, item: any, opts?: any) => Promise<any>, switchTo: (chatId: string, pick: any, opts?: any) => Promise<any>, modelKey: (p: { harness: string, key: string | null }) => Promise<any>, orgLease?: (p: any) => Promise<any> }} H
 * @param {H} host a remote Host speaking the Host's own chat ids (remote.cjs)
 * @param {{ forHarness: (harness: string) => string | null }} keys
 * @param {{ lend: (host: any, harness: string) => Promise<boolean> }} [org] the organization's lease (orgAccess/service.cjs), used before a key when there is one
 * @param {boolean} [controlledByCode] this Mac only controls that one (paired by code): it takes no key, lease, policy or tasks from this one and runs chats on its own sign-in, so its `forbidden` is that and nothing else
 * @returns {H & { controlledByCode: boolean }}
 */
function withCredentials(host, keys, org = NO_ORG, controlledByCode = false) {
  /** An organization lease first; a Host without the feature runs the chat on the key or its own sign-in. A sign-in that ended throws, and the message waits for it. @param {string} harness */
  const lendOrg = async (harness) => {
    try {
      return await org.lend(host, harness);
    } catch (e) {
      // feature_missing: a Host without leases; forbidden from a Mac this one only controls (paired by code): it runs the chat on its own sign-in
      const code = /** @type {any} */ (e)?.code;
      if (code === 'feature_missing' || (code === 'forbidden' && controlledByCode)) return false;
      throw e;
    }
  };
  /**
   * Lend the agent its key (or take it back) first; a Host without the feature runs the chat on its own sign-in, and its row says so.
   * @param {string} family the lease's family (`acp` for every basic agent) @param {string} harness the agent whose own key it takes (Gemini's)
   */
  const lend = async (family, harness) => {
    if (await lendOrg(family)) return;
    if (!Object.hasOwn(KEYED, harness)) return;
    try {
      await host.modelKey({ harness, key: keys.forHarness(harness) });
    } catch (e) {
      // feature_missing: a Host without keys; invalid: one that takes no key for this agent yet (an older build); forbidden: a Mac this one
      // only controls (paired by code), which takes no key from it: each runs the chat on its own sign-in
      const code = /** @type {any} */ (e)?.code;
      if (code !== 'feature_missing' && code !== 'invalid' && !(code === 'forbidden' && controlledByCode)) throw e;
    }
  };
  return {
    ...host,
    controlledByCode,
    start: async (chatId, item, opts) => (await lend(familyOf(item?.harness), agentOf(item?.harness)), host.start(chatId, item, opts)),
    // the agent a chat is moved to gets its key before the Host judges it ready (one that is installed and signed out runs on a lent key)
    switchTo: async (chatId, pick, opts) => (
      await lend(familyOf(pick?.harness), agentOf(pick?.harness)), host.switchTo(chatId, pick, opts)
    ),
    send: async (chatId, item, opts) => {
      // the agent the message runs on (`lendAs`, the Host's word after a switch, or the held choice): the chat's id names the one it started on
      const family = item?.lendAs ? familyOf(item.lendAs) : harnessOfChat(chatId);
      await lend(family, family === 'acp' ? agentOf(item?.lendAs ?? chatId) : family);
      return host.send(chatId, item, opts);
    },
  };
}

/**
 * A machine's harnesses as the row reads them: one the Host can lend a key to (`takesKey`, an older Host never says so) is `keyed` while the
 * user has given a key for it, or one that takes an organization lease (`takesOrg`) while the organization's access covers it, so it reads ready
 * without a sign-in there. `signedIn` stays what the machine said.
 * @template {{ id: string, takesKey?: unknown }} T
 * @param {T[]} harnesses @param {{ hasFor: (harness: string) => boolean }} keys @param {{ covers: (harness: string) => boolean }} [org]
 * @returns {(T & { keyed?: true })[]}
 */
const keyedHarnesses = (harnesses, keys, org = NO_ORG) =>
  harnesses.map((h) => {
    const takesOrg = /** @type {{ takesOrg?: unknown }} */ (h).takesOrg === true;
    return (h.takesKey === true && keys.hasFor(h.id)) || (takesOrg && org.covers(h.id)) ? { ...h, keyed: true } : h;
  });

/** No key for any harness: what a machines service has when the app gave it no key store. */
const NO_KEYS = Object.freeze({ forHarness: () => null, hasFor: () => false });
/** No organization access: what a machines service has when the app gave it none. */
const NO_ORG = Object.freeze({ lend: async () => false, covers: () => false });

module.exports = { withCredentials, harnessOfChat, keyedHarnesses, NO_KEYS, NO_ORG };
