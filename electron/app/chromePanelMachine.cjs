// A chat on a machine seen from the phone's controls (D13, #4278): the agents its machine offers with their state, the one it runs on and the one a held move goes to, and the move itself, which the Host holds until the chat's next message (electron/host/remoteSwitch.cjs). The menus (models, permissions) stay the panel's own (chromePanelOptions.cjs).
const { LOCAL_HOST_ID } = require('../host/ownership.cjs');
const { hostFamilyOfHarness, isHostFamily } = require('../../shared/host/chatIds.mjs');

/** The agent a chat on a machine runs on, as the wire names it ('claude', 'codex' or 'acp:<id>'), read from its app id (shared/host/chatIds.mjs); null for an id that names no agent. @param {string} chatId */
function agentOfChat(chatId) {
  const basic = /^acp:([^:]+):/.exec(chatId)?.[1];
  return basic ? (hostFamilyOfHarness(basic) ?? `acp:${basic}`) : null;
}

/** The wire name of an agent a machine lists by `id`: its own family, or a basic agent as `acp:<id>`. @param {string} id */
const kindOfAgent = (id) => (isHostFamily(id) ? id : `acp:${id}`);

/**
 * @param {object} o
 * @param {any} o.live main's late-bound services: `hostPhone` (the machines and where each chat runs), `remoteSend` (a request to a machine's Host) and `controller` (the chat's session state)
 * @param {(kind: string | null) => string | null} o.labelOf how the panel names a harness kind
 */
function createPanelMachine({ live, labelOf }) {
  /** The machine a chat runs on now, null for a chat of this Mac and while Host's gate is closed. @param {string | undefined} chatId */
  const machineOf = (chatId) => {
    const hostId = chatId ? live.hostPhone?.hostOf(chatId) : null;
    return typeof hostId === 'string' && hostId !== LOCAL_HOST_ID ? hostId : null;
  };
  const rowOf = (/** @type {string} */ hostId) => live.hostPhone.rows().find((/** @type {{ id: string }} */ r) => r.id === hostId);
  const pendingOf = (/** @type {string} */ chatId) => live.controller.state.get(chatId)?.pendingSwitch ?? null;
  /** An older Host's refusal to carry the move, in the words of this chat's machine. @param {unknown} error @param {string} machine */
  const refusal = (error, machine) =>
    /** @type {any} */ (error)?.code === 'feature_missing'
      ? Object.assign(new Error(`Update ${machine} to switch agents.`), { code: 'unsupported' })
      : error;
  return {
    machineOf,
    /**
     * The chat's options with its machine's side added: `machine` (its name and agents, each by its wire name with the machine's own words for what it is not ready for), the agent it
     * runs on (`current`) and, while a move is held, the agent it goes to (`harnessId`, `switching`). A chat of this Mac is returned as it is.
     * @param {{ chatId?: string }} p @param {Record<string, unknown>} reply
     */
    options(p, reply) {
      const hostId = machineOf(p.chatId);
      const row = hostId ? rowOf(hostId) : null;
      if (!p.chatId || !hostId || !row) return reply;
      const current = agentOfChat(p.chatId);
      const held = pendingOf(p.chatId);
      const shown = held?.harness ?? current;
      return {
        ...reply,
        ...(shown ? { harnessId: shown, harness: labelOf(shown) ?? shown } : {}),
        switching: !!held,
        ...(current ? { current } : {}),
        machine: {
          id: hostId,
          name: String(row.name),
          agents: (Array.isArray(row.agents) ? row.agents : []).map((/** @type {any} */ a) => ({
            id: kindOfAgent(String(a.id)),
            label: String(a.label),
            state: a.state === 'ready' || a.state === 'signin' ? a.state : 'missing',
            reason: typeof a.reason === 'string' ? a.reason : '',
          })),
        },
      };
    },
    /**
     * A move of a chat on a machine to another agent: the Host holds it until the chat's next message, and the session state mirrors it for the chip and the next read. Its own agent again calls a held move off.
     * The Host's refusal is the answer (not installed, signed out, an older Host, the machine away). Resolves undefined for a chat of this Mac: the caller moves it as always.
     * @param {{ chatId: string, harness: string, account?: string | null }} p
     */
    async switchTo(p) {
      const hostId = machineOf(p.chatId);
      const row = hostId ? rowOf(hostId) : null;
      if (!hostId || !row) return undefined;
      if (p.account !== undefined) throw new Error('A login on a machine is picked on your Mac.');
      // the service answers null for a chat that runs here and is absent while Host is off: either way nothing was asked of a machine
      const sent = live.remoteSend?.()?.switchTo(p.chatId, { harness: p.harness });
      if (!sent) throw new Error(`Can't reach ${row.name}, so the chat stays on its agent.`);
      /** @type {any} */ let reply;
      try {
        reply = await sent;
      } catch (error) {
        throw refusal(error, String(row.name));
      }
      const state = live.controller.state;
      state.patch(p.chatId, {
        pendingSwitch: reply?.pending
          ? { harness: reply.pending.harness, model: reply.pending.model ?? '', modelLabel: '', mode: 'auto' }
          : null,
      });
      return true;
    },
  };
}

module.exports = { createPanelMachine, agentOfChat };
