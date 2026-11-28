// Auto on an ACP agent: an agent keeps a model or effort set on its session after the turn it was set for. Before Auto's
// pick reaches the agent, the chat's own value is written down (meta.config.autoRouteRestore, by agent, so a crash keeps
// it). The chat's next message on that agent, Auto or not, hands each value it leaves alone to the ACP adapter, which
// sets the chat's own back once the session is open and before the prompt goes (acp/initialConfig.cjs). A value someone
// picked since stays theirs.
const { saveMeta } = require('../../shared/metaSave.mjs');

const WHAT = /** @type {const} */ (['model', 'effort']);

/**
 * @typedef {{ own: string, applied: string }} Change what the chat had, and what Auto set for a turn
 * @typedef {{ generation: number, model?: Change, effort?: Change }} Restore what to set back on one agent's session; a
 *   newer generation is a record a later turn wrote
 * @typedef {{ kind: string, generation: number, whats: ('model' | 'effort')[] }} Handed what a dispatched turn set back
 */

/**
 * @param {object} o
 * @param {any} o.chats the ChatsStore: records, patchMeta
 * @param {any} o.controller the ChatController: ref
 * @param {{ settingsOf(id: string): { model?: string | null, effort?: string | null } | null }} o.settings
 * @param {(chatId: string) => void} o.changed the chat's saved config changed (every window reads it again)
 */
function createAcpRestore({ chats, controller, settings, changed }) {
  /** @type {Map<string, Handed>} by chat: what its dispatched turn hands back, cleared once the agent took the turn */
  const handed = new Map();
  const config = (/** @type {string} */ id) => chats.records.get(id)?.meta?.config ?? {};
  /** The records of the chat's agents, by harness kind: the values belong to that agent's session. */
  const records = (/** @type {string} */ id) => /** @type {{ [kind: string]: Restore }} */ (config(id).autoRouteRestore ?? {});
  const recordOf = (/** @type {string} */ id, /** @type {string} */ kind) => (Object.hasOwn(records(id), kind) ? records(id)[kind] : null);
  const save = (/** @type {string} */ id, /** @type {string} */ kind, /** @type {Restore | null} */ record) => {
    const { [kind]: _old, ...rest } = records(id);
    const next = record ? { ...rest, [kind]: record } : rest;
    if (saveMeta(chats, id, { config: { ...config(id), autoRouteRestore: Object.keys(next).length ? next : null } })) changed(id);
  };

  /**
   * Before an ACP turn is dispatched: each value Auto picks is written down against the chat's own (an unsettled
   * record's own, else what the agent runs now), and each value an earlier Auto turn changed that this turn sets nothing
   * for comes back as `restore`, for the adapter to set back.
   * @param {string} id
   * @param {{ pick?: { model?: string | null, effort?: string | null } | null, explicit?: { model?: string, effort?: string } }} turn
   *   pick: Auto's values for this turn; explicit: what someone else set for it (a scheduled task's run)
   * @returns {Partial<Record<'model' | 'effort', Change>> | null} restore
   */
  function prepare(id, { pick = null, explicit = {} }) {
    const kind = controller.ref(id).kind;
    const old = recordOf(id, kind);
    const now = settings.settingsOf(id) ?? {};
    /** @type {Restore} */
    const next = { generation: (old?.generation ?? 0) + 1 };
    /** @type {Partial<Record<'model' | 'effort', Change>>} */
    const restore = {};
    for (const what of WHAT) {
      const value = pick?.[what];
      const mine = old?.[what]?.own ?? now[what];
      if (value) {
        // a pick equal to the chat's own sets the agent back on its own: nothing is left to remember
        if (mine && value !== mine) next[what] = { own: mine, applied: value };
      } else if (old?.[what]) {
        next[what] = old[what];
        if (!explicit[what]) restore[what] = old[what];
      }
    }
    const whats = /** @type {('model' | 'effort')[]} */ (Object.keys(restore));
    if (next.model || next.effort) save(id, kind, next);
    else if (old) save(id, kind, null);
    if (whats.length) handed.set(id, { kind, generation: next.generation, whats });
    else handed.delete(id);
    return whats.length ? restore : null;
  }

  /**
   * The turn ended. One the agent took (not a start that failed) set back what it was handed: those values leave the
   * record, unless a later turn wrote a newer one meanwhile. A failed start keeps them for the next message.
   * @param {string} id
   * @param {boolean} taken
   */
  function afterTurn(id, taken) {
    const done = handed.get(id);
    handed.delete(id);
    if (!done || !taken) return;
    const record = recordOf(id, done.kind);
    if (record?.generation !== done.generation) return;
    /** @type {Restore} */
    const rest = { ...record };
    for (const what of done.whats) delete rest[what];
    save(id, done.kind, rest.model || rest.effort ? rest : null);
  }

  return { prepare, afterTurn };
}

module.exports = { createAcpRestore };
