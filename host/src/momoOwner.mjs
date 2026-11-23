// Who may act on MoMo's home on a Host: a paired desktop or phone, the owner's own devices. The local CLI (a token beside the socket, so any process on the machine) and any narrower kind of client may not.

/** The kinds of paired client that are the owner's own devices. */
export const OWNER_KINDS = ['desktop', 'phone'];

/** @param {unknown} principal whether it is one of the owner's own devices */
export const isOwner = (principal) => OWNER_KINDS.includes(/** @type {{ kind?: string } | null} */ (principal)?.kind ?? '');
