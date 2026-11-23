// Finding a delivered peer message's receipt (turn and item) in the receiving segment's native history.
const { parseKind } = require('../../shared/harnessKind.mjs');

/** Read-only reconciliation uses the recorded receiving segment, never its current replacement. */
function createPeerReceiptReader({ claudeMessages, acpHistory, codexTurns }) {
  /**
   * Each family's reader of a message's receipt: its user message's turn and item ids, or null when it isn't there.
   * @type {Record<import('../../shared/harnessKind.mjs').HarnessFamily, (kind: string, nativeId: string, id: string) => Promise<[string, string] | null>>}
   */
  const FIND = {
    claude: async (_kind, nativeId, id) => {
      const user = (await claudeMessages(nativeId)).find((m) => m.type === 'user' && m.uuid === id);
      return user ? [`h-${user.uuid}`, user.uuid] : null;
    },
    acp: async (kind, nativeId, id) => {
      const user = (await acpHistory(`${kind}:${nativeId}`)).find((r) => r.t === 'user' && r.user?.clientId === id);
      return user ? [user.turnId, user.user.id] : null;
    },
    codex: async (_kind, nativeId, id) => {
      let cursor = null;
      const seen = new Set();
      for (let i = 0; i < 40; i++) {
        const page = await codexTurns(nativeId, { limit: 50, cursor, itemsView: 'full' });
        for (const turn of page.data ?? []) {
          const user = (turn.items ?? []).find((item) => item.type === 'userMessage' && (item.clientId === id || item.id === id));
          if (user) return [turn.id, user.id];
        }
        cursor = page.nextCursor;
        if (!cursor || seen.has(cursor)) break;
        seen.add(cursor);
      }
      return null;
    },
  };
  return async (message) => {
    const { targetKind: kind, targetNativeId: nativeId, id } = message;
    const family = parseKind(kind)?.family;
    if (!family || !nativeId || !id) return null;
    const [turnId, itemId] = (await FIND[family](kind, nativeId, id)) ?? [];
    return turnId && itemId ? { kind, nativeId, clientId: id, turnId, itemId } : null;
  };
}
module.exports = { createPeerReceiptReader };
