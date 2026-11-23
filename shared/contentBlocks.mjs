// Record-shaped message blocks with typed text fields, retaining original transcript item indices.
import { isJsonRecord } from './jsonRecord.mjs';

const TEXT_FIELDS = new Map([
  ['text', 'text'],
  ['thinking', 'thinking'],
  ['redacted_thinking', 'thinking'],
]);

/** Missing text means empty; other non-string values are malformed, never coerced into message text. */
export function normalizeContentBlock(block) {
  if (!isJsonRecord(block)) return null;
  const field = TEXT_FIELDS.get(block.type);
  if (!field) return block;
  const value = block[field];
  if (value == null) return { ...block, [field]: '' };
  return typeof value === 'string' ? block : null;
}

export const contentBlockEntries = (content) =>
  Array.isArray(content) ? content.map((block, index) => [index, normalizeContentBlock(block)]).filter(([, block]) => block !== null) : [];
export const contentBlocks = (content) => contentBlockEntries(content).map(([, block]) => block);
