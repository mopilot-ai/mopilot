// Validated text and reasoning indices across harnesses, plus Claude SDK stream-event translation.
export const TEXT_METHODS = new Set([
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
]);
const CLAUDE_DELTAS = new Map([
  ['text_delta', { method: 'item/agentMessage/delta', field: 'text', params: {} }],
  ['thinking_delta', { method: 'item/reasoning/summaryTextDelta', field: 'thinking', params: { summaryIndex: 0 } }],
]);
// Live reasoning arrays are dense: cap one item at 4096 parts so an external index cannot
// allocate unbounded padding. This is a client resource limit, not a protocol limit.
export const MAX_REASONING_PARTS = 4096;
const REASONING_INDICES = new Map([
  ['item/reasoning/summaryPartAdded', 'summaryIndex'],
  ['item/reasoning/summaryTextDelta', 'summaryIndex'],
  ['item/reasoning/textDelta', 'contentIndex'],
]);
const invalidReasoningIndex = (method, params) => {
  const field = REASONING_INDICES.get(method);
  if (!field) return false;
  const index = params?.[field] ?? (field === 'contentIndex' ? 0 : null);
  return !Number.isInteger(index) || index < 0 || index >= MAX_REASONING_PARTS;
};
const textOf = (value) => (typeof value === 'string' ? value : null);

/** Validate display fragments before batching, appenders or retry progress; other payloads retain their contracts. */
export const isInvalidStreamNotification = (method, params) =>
  (TEXT_METHODS.has(method) && textOf(params?.delta) === null) || invalidReasoningIndex(method, params);

/** A missing/malformed stream fragment is no model progress. Empty strings remain valid fragments. */
export function claudeTextDelta(delta) {
  const entry = CLAUDE_DELTAS.get(delta?.type);
  if (!entry) return null;
  const text = textOf(delta?.[entry.field]);
  return text === null ? null : { method: entry.method, params: { ...entry.params, delta: text } };
}
