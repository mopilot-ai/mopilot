// Types for the shared rule of how a context compaction reads in a chat (shared/compaction.mjs).
export interface CompactionItem {
  type: 'contextCompaction';
  id: string;
  trigger: string | null;
  summary?: string;
}
export const COMPACT_COMMAND: RegExp;
export function compactionItem(id: string, o?: { trigger?: string | null; summary?: string | null }): CompactionItem;
