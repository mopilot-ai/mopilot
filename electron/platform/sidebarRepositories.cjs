// Shared bounded reads of sidebar repository identities and their last verified values.
const path = require('node:path');
const fs = require('node:fs');
const { writeAtomic } = require('./fsutil.cjs');
const { noteIgnored } = require('../ignored.cjs');

const services = new Map();
const LIMIT = 4;
const FRESH_MS = 60_000;
const MAX_ENTRIES = 2048;

/** @param {string} directory */
function sidebarRepositories(directory) {
  const existing = services.get(directory);
  if (existing) return existing;
  const file = path.join(directory, 'sidebar-repositories.json');
  /** @type {Map<string, string>} */
  const known = new Map();
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (stored?.version === 1 && Array.isArray(stored.entries))
      for (const row of stored.entries.slice(-MAX_ENTRIES))
        if (Array.isArray(row) && typeof row[0] === 'string' && typeof row[1] === 'string') known.set(row[0], row[1]);
  } catch (error) {
    if (error?.code !== 'ENOENT') noteIgnored('read sidebar repository identities', error);
  }
  const pending = new Map();
  const checked = new Map();
  /** @type {(() => void)[]} */
  const waiting = [];
  let active = 0;

  /** @param {string} key @param {() => Promise<string | null | undefined>} probe undefined means the source could not answer */
  function read(key, probe) {
    if (pending.has(key)) return pending.get(key);
    if (Date.now() - (checked.get(key) ?? 0) < FRESH_MS) return Promise.resolve(known.get(key) ?? null);
    const answer = (active < LIMIT ? Promise.resolve(++active) : new Promise((resolve) => waiting.push(() => resolve(undefined))))
      .then(probe)
      .then((value) => {
        if (value === undefined) return;
        checked.delete(key);
        checked.set(key, Date.now());
        if (checked.size > MAX_ENTRIES) checked.delete(checked.keys().next().value);
        if ((known.get(key) ?? null) === value) return;
        known.delete(key);
        if (value) known.set(key, value);
        if (known.size > MAX_ENTRIES) known.delete(known.keys().next().value);
        writeAtomic(file, JSON.stringify({ version: 1, entries: [...known] }));
      })
      .catch((error) => noteIgnored('refresh a sidebar repository identity', error))
      .finally(() => {
        pending.delete(key);
        const next = waiting.shift();
        if (next) next();
        else active--;
      })
      .then(() => known.get(key) ?? null);
    pending.set(key, answer);
    return answer;
  }

  services.set(directory, read);
  return read;
}

module.exports = { sidebarRepositories };
