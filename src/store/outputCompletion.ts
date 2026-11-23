// Capture output evidence before reducing a live notification; reveal only a changed write afterward.
import type { ThreadItem } from './types';
import { get } from './core';
import { ignoring } from '../lib/ignored';
import { writtenFiles } from '../lib/sessionOutputs';
import { revealSessionOutputs } from './outputReveal';

export function outputCompletion(threadId: string, turnId: string, change: { item: ThreadItem } | { diff: string }): () => void {
  const turn = get().runtime[threadId]?.turns.find((t) => t.id === turnId);
  const writes = 'item' in change ? writtenFiles(change.item) : undefined;
  const changed =
    'item' in change
      ? change.item.type === 'fileChange' &&
        JSON.stringify(turn?.items.find((i) => i.id === change.item.id)) !== JSON.stringify(change.item)
      : turn?.diff !== change.diff;
  return () => {
    if (changed) void revealSessionOutputs(threadId, turnId, writes).catch(ignoring('show a generated output'));
  };
}
