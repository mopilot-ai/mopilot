// Who may see which chats in the Host's chat list and its events, and whose device name a row may carry. The rule is by the kind of client, and a kind this file does not name is the narrowest: a client of a new kind (MoMo's Host-to-Host `home`) sees only the chats it started, until someone widens it here on purpose.

/** The kinds that are one person's own devices (a `controller` is another Mac the person allowed with a code): they see every chat the chat veil lets them see, and the veil leaves MoMo's out for all but an owner's desktop or phone. */
const SEES_ALL = new Set(['desktop', 'phone', 'cli', 'controller']);
/** The kinds that already read every client's name (host.clients is for them): a phone manages only itself. */
const SEES_NAMES = new Set(['desktop', 'cli']);

/**
 * @typedef {{ sees: (chatId: string, row?: { byFp?: string }) => boolean, names: (row: { byFp?: string }) => boolean }} ChatScope
 * @param {((who: unknown) => ((chatId: string) => boolean) | undefined) | undefined} chatVeil for a caller, the chats the veil leaves it (MoMo's own chats stay out); everything without one
 * @returns {(who: unknown) => ChatScope}
 */
export const chatScopeOf = (chatVeil) => (who) => {
  const veil = chatVeil?.(who);
  const principal = /** @type {{ kind?: string, fingerprint?: string } | null | undefined} */ (/** @type {any} */ (who)?.principal?.());
  // an embedder with no pairing has no clients to tell apart: it is served as it always was
  if (!principal) return { sees: (id) => !veil || veil(id), names: () => true };
  const own = (/** @type {{ byFp?: string }} */ row) => !!principal.fingerprint && row.byFp === principal.fingerprint;
  const all = SEES_ALL.has(String(principal.kind));
  return {
    sees: (id, row) => (!veil || veil(id)) && (all || (!!row && own(row))),
    names: (row) => SEES_NAMES.has(String(principal.kind)) || own(row),
  };
};
