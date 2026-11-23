// A cloud machine that is gone, and deleting one (Remote Run C4): `gone` is what the provider says, never a timeout, so a chat is continued from the client's copy only when the machine cannot still be running; Delete names the chats on the machine first, can carry each folder's unpushed work off it, and leaves the row and its chats in the client.
const crypto = require('node:crypto');
const { noteIgnored } = require('../ignored.cjs');

/** @param {string} code @param {string} message @param {object} [details] */
const refusal = (code, message, details = {}) => Object.assign(new Error(message), { code, details });

/**
 * @param {object} o
 * @param {(hostId: string) => { cloud?: { provider: string, id: string, region: string } | null } | undefined} o.rowOf
 * @param {(provider: string, region: string) => import('../../shared/cloud/adapter.mjs').CloudAdapter} o.adapterOf
 * @param {(hostId: string) => { chatId: string, title: string, folder: string | null }[]} o.chatsOn the chats the machine runs
 * @param {(hostId: string, chatId: string) => Promise<void>} [o.carry] pushes the chat's uncommitted work to a branch (the carry step Switch host has); throws when it could not
 * @param {() => void} [o.onChange] the set of gone machines changed (the machine line reads "Deleted at the provider")
 */
function createCloudGone({
  rowOf,
  adapterOf,
  chatsOn,
  carry = async () => {
    throw new Error('This app cannot push from the machine.');
  },
  onChange = () => undefined,
}) {
  /** @type {Set<string>} */
  const gone = new Set();
  /** The provider's last answer for each machine, so a line can say it is asleep. @type {Map<string, string>} */
  const states = new Map();

  /** The adapter and id of a cloud machine, or null. @param {string} hostId */
  const target = (hostId) => {
    const cloud = rowOf(hostId)?.cloud;
    return cloud ? { adapter: adapterOf(cloud.provider, cloud.region), id: cloud.id } : null;
  };
  /** @param {string} hostId */
  const markGone = (hostId) => {
    if (gone.has(hostId)) return;
    gone.add(hostId);
    onChange();
  };

  /** @param {string} hostId @returns {string} */
  const tokenOf = (hostId) =>
    crypto
      .createHash('sha256')
      .update(
        JSON.stringify(
          chatsOn(hostId)
            .map((c) => c.chatId)
            .sort(),
        ),
      )
      .digest('hex')
      .slice(0, 16);

  return {
    /** Whether the provider said this machine is gone (not that it was merely unreachable). @param {string} hostId */
    isGone: (hostId) => gone.has(hostId),
    /** The provider's last answer for the machine (`running`, `stopped`, …), or null before one. @param {string} hostId */
    stateOf: (hostId) => states.get(hostId) ?? null,
    /**
     * Ask the provider. `gone` only when it says so; an answer that fails is `unknown`, never gone. Run at app start and before a continue.
     * @param {string} hostId @returns {Promise<'gone' | 'alive' | 'unknown' | 'not-cloud'>}
     */
    async check(hostId) {
      if (!rowOf(hostId)?.cloud) return 'not-cloud';
      try {
        // the adapter is made inside: a key that was removed is an answer we cannot get, never gone
        const t = /** @type {NonNullable<ReturnType<typeof target>>} */ (target(hostId));
        const state = await t.adapter.status(t.id);
        states.set(hostId, state);
        if (state === 'gone') {
          markGone(hostId);
          return 'gone';
        }
        return 'alive';
      } catch (error) {
        noteIgnored('ask a provider whether a machine still exists', error);
        return 'unknown';
      }
    },
    /**
     * The guard for the lost-Host path (`continue.cjs`): null when the chat may be continued from the client's copy, else why not. A machine that is not a cloud machine is the existing path's to judge.
     * @param {string} hostId @returns {Promise<null | { code: string, message: string }>}
     */
    async lostCheck(hostId) {
      const answer = await this.check(hostId);
      if (answer === 'gone' || answer === 'not-cloud') return null;
      if (answer === 'alive')
        return { code: 'source_may_run', message: 'The machine still exists at the provider. Wake it, or delete it first.' };
      return { code: 'source_unknown', message: "Can't tell whether the machine still exists. Check the provider key and try again." };
    },
    /** What Delete names before it acts: the chats on the machine, and a token that proves the person saw this list. @param {string} hostId */
    plan(hostId) {
      return { chats: chatsOn(hostId), token: tokenOf(hostId) };
    },
    /**
     * Delete the machine and its disk at the provider; the row and its chats stay. Needs the token of the plan the person saw (a chat started or moved since refuses) and, for each chat in `carry`, its work pushed first: one that cannot be pushed stops the delete with the machine untouched.
     * @param {string} hostId @param {{ token: string, carry?: string[] }} o
     */
    async remove(hostId, { token, carry: carried = [] }) {
      const t = target(hostId);
      if (!t) throw refusal('not_cloud', 'That is not a cloud machine.');
      if (token !== tokenOf(hostId)) throw refusal('plan_changed', 'The chats on this machine changed. Look at the list again.');
      for (const chatId of carried) {
        try {
          await carry(hostId, chatId);
        } catch (error) {
          throw refusal('carry_failed', "The changes couldn't be pushed, so the machine was not deleted.", {
            chatId,
            cause: String(/** @type {any} */ (error)?.message ?? ''),
          });
        }
      }
      await t.adapter.destroy(t.id);
      markGone(hostId);
      return { deleted: true };
    },
  };
}

module.exports = { createCloudGone };
