// Validate saved per-turn patches before they can replace a harness's native diff.
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');

/** @returns {Record<string, Record<string, string>>} */
function normalizeDiffCache(value) {
  const diffs = Object.create(null);
  if (!isJsonRecord(value)) return diffs;
  for (const [threadId, turns] of Object.entries(value)) {
    if (!isJsonRecord(turns)) continue;
    const patches = Object.create(null);
    for (const [turnId, diff] of Object.entries(turns)) if (typeof diff === 'string') patches[turnId] = diff;
    diffs[threadId] = patches;
  }
  return diffs;
}

module.exports = { normalizeDiffCache };
