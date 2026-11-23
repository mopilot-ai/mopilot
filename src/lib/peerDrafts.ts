// Unsent peer message drafts per chat, kept in memory for the app run only.

/** Matches composer drafts: app-run state, without persisting temporary message bodies to disk. */
export type PeerDraft = {
  body: string;
  target: string;
  replyTo: string | null;
  open: boolean;
  request: { signature: string; id: string } | null;
};
const drafts = new Map<string, PeerDraft>();
export const emptyPeerDraft = (): PeerDraft => ({ body: '', target: '', replyTo: null, open: false, request: null });
export function peerDraft(chatId: string): PeerDraft {
  return structuredClone(drafts.get(chatId) ?? emptyPeerDraft());
}
export function patchPeerDraft(chatId: string, patch: Partial<PeerDraft>) {
  drafts.set(chatId, { ...peerDraft(chatId), ...patch });
}
export function clearPeerDraft(chatId: string) {
  drafts.delete(chatId);
}
