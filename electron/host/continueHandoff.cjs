// The handoff text for a continue on another Host (docs: design/host/index.html, package 3.2): from the app's own mirror of the chat first, so it works with the source Host offline, else from the source Host's snapshot; a chat that runs on this Mac is read the way a harness switch reads it.
const { continueHandoff, turnsFromHostItems } = require('../../shared/host/continueHandoff.mjs');
const { LOCAL_HOST_ID } = require('./ownership.cjs');

/** Whether a snapshot holds every item of the chat: the Host counts one revision per finished item, so a snapshot that kept fewer than it counted is a tail. @param {{ rev: number, items: unknown[] }} snap */
const complete = (snap) => snap.items.length >= snap.rev;

/** @param {unknown} snap */
const validSnapshot = (snap) =>
  !!snap &&
  Array.isArray(/** @type {any} */ (snap).items) &&
  Number.isSafeInteger(/** @type {any} */ (snap).rev) &&
  /** @type {any} */ (snap).rev >= 0;

/**
 * @param {object} o
 * @param {(chatId: string) => { items: unknown[], complete: boolean } | null} o.mirror what the app holds of a chat that runs on a remote Host: the finished items its windows folded, and whether they reach back to the chat's first item
 * @param {(hostId: string, chatId: string) => Promise<{ rev: number, items: unknown[] }>} o.snapshot the source Host's `chat.subscribe` from rev 0
 * @param {(hostId: string) => 'online' | 'connecting' | 'offline'} o.hostState
 * @param {(chatId: string) => Promise<{ turns: object[], failed: { kind: string }[], label: string, model: string | null }>} o.localTurns a chat on this Mac read the way a harness switch reads it (SwitchRunner.chatTurns)
 * @param {(chatId: string) => string} o.labelOf the harness's name for a chat on a remote Host
 * @param {(problem: string) => void} o.report
 */
function createContinueHandoff({ mirror, snapshot, hostState, localTurns, labelOf, report }) {
  return {
    /**
     * @param {{ chatId: string, sourceHostId: string, targetModel?: string, cwd: string, code?: { source: import('../../shared/host/codeTransfer.mjs').RepoFacts | null, target?: import('../../shared/host/codeTransfer.mjs').RepoFacts | null, carried?: number, skipped?: string[] } | null }} req `cwd` is the folder on the target; `code` is what the code transfer read of the source's repository and the target folder (3.5)
     * @returns {Promise<{ text: string, tokens: number, partial: boolean, via: 'local' | 'mirror' | 'host', turns: number }>}
     */
    async build({ chatId, sourceHostId, targetModel = '', cwd, code = null }) {
      if (sourceHostId === LOCAL_HOST_ID) {
        const local = await localTurns(chatId);
        const partial = local.failed.length > 0;
        const text = continueHandoff({
          turns: local.turns,
          fromLabel: local.label,
          fromModel: local.model,
          targetModel,
          cwd,
          partial,
          code,
        });
        return { ...text, partial, via: 'local', turns: local.turns.length };
      }
      const held = mirror(chatId);
      // a copy: windows keep folding items into the mirror while the source is asked
      let items = [...(held?.items ?? [])];
      let partial = !held?.complete;
      let via = /** @type {'mirror' | 'host'} */ ('mirror');
      // a mirror that does not reach back to the first item asks the source, when it can be reached
      if (partial && hostState(sourceHostId) === 'online') {
        try {
          const snap = await snapshot(sourceHostId, chatId);
          if (!validSnapshot(snap)) throw new Error('The host sent a snapshot this app cannot read.');
          // the longer record wins; either may be a tail of the chat
          if (snap.items.length >= items.length) {
            items = snap.items;
            via = 'host';
          }
          partial = !(via === 'host' && complete(snap));
        } catch (e) {
          report(`The source host could not give the whole conversation: ${/** @type {Error} */ (e).message}`);
        }
      }
      const turns = turnsFromHostItems(items);
      const text = continueHandoff({ turns, fromLabel: labelOf(chatId), targetModel, cwd, partial, code });
      return { ...text, partial, via, turns: turns.length };
    },
  };
}

/**
 * A chat on this Mac as the builder's `localTurns` reads it: its whole history across segments, what could not be read, and the harness and model it last ran on.
 * @param {{ ref: (chatId: string) => { kind: string }, chatTurns: (chatId: string, ref: any) => Promise<{ turns: object[], failed: { kind: string }[] }>, label: (kind: string) => string, chats: { record: (chatId: string) => { segments: { model?: string | null }[] } } }} runner the SwitchRunner
 */
const localTurnsOf = (runner) => async (/** @type {string} */ chatId) => {
  const ref = runner.ref(chatId);
  const { turns, failed } = await runner.chatTurns(chatId, ref);
  return { turns, failed, label: runner.label(ref.kind), model: runner.chats.record(chatId).segments.at(-1)?.model ?? null };
};

module.exports = { createContinueHandoff, localTurnsOf };
