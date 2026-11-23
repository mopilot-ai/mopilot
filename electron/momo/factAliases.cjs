// Search aliases for MoMo's saved facts (#2999 P2, #2139): the terms the alias writer (historyAliases.cjs) has the
// cheap model write for each fact, so a fact saved in English is found by a Chinese question and the other way round.
// Kept beside the facts, never in them, so nothing that returns a fact (the memory tools, the Memory tab, the pass)
// ever carries them: sealed in <momo dir>/fact-aliases.json as { [fact id]: { of, aliases } }, `of` a digest of the
// fact's text when they were written, so a fact whose text changed (an update, an undo) gets new ones and its old ones
// stop matching at once. '' marks a fact tried with none. Deleted by Reset with the memory files; entries of facts no
// longer kept are dropped on the next write.
const crypto = require('node:crypto');
const path = require('node:path');
const { fs: nodeFs } = require('../platform/ports/fs.cjs');
const { SealedJson } = require('../gateway/sealedFile.cjs');
const { factAliasPrompt } = require('./aliases.cjs');
const { sameText } = require('./memoryFacts.cjs');

/** @typedef {import('./memoryFacts.cjs').Fact} Fact */

const FILE = 'fact-aliases.json';

/** The digest of a fact's text its aliases were written for (case and spacing ignored). */
const digestOf = (/** @type {string} */ text) => crypto.createHash('sha256').update(sameText(text)).digest('hex').slice(0, 16);

/** The saved entries, each `{ of, aliases }` with string fields; anything else is left out. */
function shapeOf(/** @type {unknown} */ v) {
  /** @type {Record<string, { of: string, aliases: string }>} */
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v))
    for (const [id, e] of Object.entries(v))
      if (e && typeof e === 'object' && typeof e.of === 'string' && typeof e.aliases === 'string')
        out[id] = { of: e.of, aliases: e.aliases };
  return out;
}

/**
 * @param {{ dir: string, safeStorage: any, store: () => Pick<InstanceType<typeof import('./memory.cjs').MemoryStore>, 'available' | 'list'>,
 *   fs?: Pick<typeof import('node:fs'), 'statSync'> }} o store: MoMo's memory (late bound: it is made after this)
 */
function createFactAliases({ dir, safeStorage, store, fs = nodeFs }) {
  const file = path.join(dir, FILE);
  const sealed = new SealedJson({ file, safeStorage, shape: shapeOf });
  /** The entries as last read, with the file's mtime and size then: search reads them for every query. */
  let cache = { stamp: '', entries: shapeOf(null) };
  /** The entries; null when the file can't be read now (no encryption, another key): search matches facts' own words. */
  const entries = () => {
    let stamp = '';
    try {
      const st = fs.statSync(file);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      // no file yet (or gone with Reset): no aliases
      return shapeOf(null);
    }
    if (stamp !== cache.stamp) {
      try {
        cache = { stamp, entries: sealed.read() };
      } catch {
        return null;
      }
    }
    return cache.entries;
  };
  /** The facts kept, past and expired ones too (an undo may bring one back with the same text). */
  const kept = () =>
    new Set(
      store()
        .list({ includeExpired: true, includePast: true })
        .facts.map((f) => f.id),
    );

  return {
    /**
     * The aliases of each fact, read once (one search ranks every fact with it): '' for a fact with none, or whose text
     * changed since they were written.
     * @returns {(f: Fact) => string}
     */
    lookup() {
      const all = entries();
      return (f) => {
        const e = all?.[f.id];
        return e && e.of === digestOf(f.text) ? e.aliases : '';
      };
    },
    /** The alias writer's source of saved facts (historyAliases.cjs AliasSource): facts in use without current aliases. */
    source: {
      name: 'facts',
      // a file that can't be read now would have every fact sent again each tick
      available: () => store().available() && entries() !== null,
      /** @param {number} n */
      needing(n) {
        const have = entries() ?? {};
        return store()
          .list()
          .facts.filter((f) => have[f.id]?.of !== digestOf(f.text))
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, n)
          .map((f) => ({ key: f.id, text: f.text, of: digestOf(f.text) }));
      },
      prompt: (/** @type {{ text: string }[]} */ items) => factAliasPrompt(items),
      /**
       * Sets each fact's aliases, for the text they were written for; a fact gone or changed since is skipped, and entries
       * of facts no longer kept go. `current()` false (MoMo reset or off since the batch began) sets nothing.
       * @param {{ item: { key: string, of: string }, aliases: string }[]} list
       * @param {() => boolean} [current]
       */
      async set(list, current = () => true) {
        const n = await sealed.change((v) => {
          if (!current()) return 0;
          const ids = kept();
          const live = new Map(
            store()
              .list()
              .facts.map((f) => [f.id, digestOf(f.text)]),
          );
          for (const id of Object.keys(v)) if (!ids.has(id)) delete v[id];
          let set = 0;
          for (const { item, aliases } of list) {
            if (live.get(item.key) !== item.of) continue;
            v[item.key] = { of: item.of, aliases };
            set++;
          }
          return set;
        });
        // what search reads is read again after this write
        cache = { stamp: '', entries: shapeOf(null) };
        return n;
      },
    },
  };
}

module.exports = { createFactAliases, digestOf, FILE };
