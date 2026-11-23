// Which harness owns a chat is the kind of its current segment record (D-40). A chat that never
// switched has one segment, which main sends as `kind`; a Claude id the renderer mints itself is
// noted when it is made. Nothing here reads an id's spelling.
import { isFirstTier, type HarnessKind } from './adapter';
import type { HarnessId, Segment } from './types';

const owners = new Map<string, HarnessId>();
/** A first-tier harness's own kind; a basic harness's ('acp:kimi') is none: its sessions are told apart by their id. */
export const firstTierKind = (kind: string | null | undefined): HarnessId | null =>
  kind && isFirstTier(kind as HarnessKind) ? (kind as HarnessId) : null;

/** Record the kind of the segment a native session (or a single-segment chat) belongs to. */
export function noteOwner(nativeId: string, kind: string | null | undefined) {
  const h = firstTierKind(kind);
  if (h) owners.set(nativeId, h);
}
/** Record every segment of a chat. */
export function noteSegments(segments: Segment[] | null | undefined) {
  for (const s of segments ?? []) noteOwner(s.nativeId, s.harness);
}
/** Record what main says about one chat (its first segment's kind, and every segment of a switched chat). */
export function noteChat(id: string, chat: { kind?: string; segments?: Segment[] | null } | null | undefined) {
  if (!chat) return;
  noteOwner(id, chat.kind);
  noteSegments(chat.segments);
}
/** The harness that owns one native session; Codex when no record says otherwise. */
export const ownerOf = (nativeId: string | null | undefined): HarnessId => (nativeId ? (owners.get(nativeId) ?? 'codex') : 'codex');
/** The native session of a chat's current segment; a chat without segments is its own. */
export const currentNativeId = (segments: Segment[] | null | undefined, chatId: string): string =>
  segments?.length ? segments[segments.length - 1].nativeId : chatId;
