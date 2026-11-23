// Attachment kinds that can reach a remote chat. Only images and files need an upload.
const REMOTE_KINDS = new Set(['image', 'file', 'selection']);

/** @param {string} kind */
export const remoteAttachmentKind = (kind) => REMOTE_KINDS.has(kind);
