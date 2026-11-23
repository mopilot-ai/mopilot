// A chat as a markdown transcript, labelled by the harness that ran each turn.

import { noteSegments } from '../harness/ownership';
import { harnessLabelOf } from '../harness/registry';
import type { Segment } from '../harness/types';

/** What ran each turn is called: the segment's harness, so 'Kimi Code' for an ACP segment, not 'undefined'. */
export function labelAt(chatId: string, segments: Segment[] | null | undefined, turnsAbove = 0): (turn: number) => string {
  if (!segments?.length) return () => harnessLabelOf(chatId);
  noteSegments(segments);
  return (turn) => harnessLabelOf(segments.reduce((n, seg) => (seg.start <= turn + turnsAbove ? seg.nativeId : n), segments[0].nativeId));
}

// Share and Copy render a chat the same way main builds a referenced chat's snapshot (shared/transcriptMarkdown.mjs)
export { transcriptMarkdown } from '../../shared/transcriptMarkdown.mjs';
