// The three-way merge that keeps a Claude Code account folder's .claude.json and the CLI's own in step
// (electron/harness/claude/accounts.cjs syncConfig): which fields belong to the login and stay where they are, and how
// the rest merges against what both sides last agreed on.
const { fs } = require('../../platform/ports/fs.cjs');
const { isJsonRecord } = require('../../../shared/jsonRecord.mjs');

/** .claude.json fields that describe the login rather than the user's setup. */
const LOGIN_FIELD =
  /^(oauthAccount|userID|primaryApiKey|customApiKeyResponses|claudeCodeFirstTokenDate|claudeAiMcpEverConnected)$|^cached|Cache$|CacheSlots$|CacheAt$|^passes|[sS]ubscription|^s1m/;
/** Never synced: the folder's own setup. */
const NO_SYNC = new Set(['hasCompletedOnboarding']);
/** A sync input may be missing, but an unreadable or malformed one must never become an empty merge side. */
function readConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const value = JSON.parse(text);
  if (!isJsonRecord(value)) throw new Error('Expected a config JSON object');
  return { text, value };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/**
 * Three-way merge of JSON values: `base` is what both sides last agreed on. A side that changed
 * wins over one that didn't; objects merge key by key; when both changed the same leaf, `mine` wins
 * (it is the side in live use). `undefined` means absent (and a deletion when base had it).
 */
function merge3(base, theirs, mine) {
  if (same(theirs, mine)) return mine;
  if (same(base, theirs)) return mine;
  if (same(base, mine)) return theirs;
  if (isJsonRecord(theirs) && isJsonRecord(mine)) {
    const b = isJsonRecord(base) ? base : {};
    const out = {};
    for (const k of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
      const v = merge3(b[k], theirs[k], mine[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return mine;
}

/** The non-login, non-local fields of a .claude.json. */
function syncable(cfg) {
  const out = {};
  for (const [k, v] of Object.entries(cfg || {})) if (!LOGIN_FIELD.test(k) && !NO_SYNC.has(k)) out[k] = v;
  return out;
}

module.exports = { LOGIN_FIELD, NO_SYNC, readConfig, same, merge3, syncable };
