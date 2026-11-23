// Where a harness's binary is, for any kind of harness: a path the user typed in Settings, else the
// first of its names on the login shell's PATH (the env snapshot, electron/platform/env.cjs), else the
// user-tool folders every detector shares (electron/platform/userTools.cjs). SAGE_ACP_BINS (a JSON map of id to path) is the tests'
// override and replaces the whole search for basic harnesses.
const { fs: nodeFs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const quirks = require('./quirks/index.cjs');
const { searchDirs, toolCandidates, toolVersion, fileKey, runnableTool, versionedToolCopies } = require('../platform/userTools.cjs');
const { highestInstalls } = require('./versions.cjs');

/**
 * @param {object} o
 * @param o.names binary names to look for
 * @param [o.manual] the user's path (used while it exists)
 * @param [o.which] (name) => path | null on the snapshot's PATH
 * @param [o.known] folders to try last
 * @param [o.exists] (path) => boolean (tests)
 * @returns {{ path: string, source: 'manual' | 'path' | 'known' } | null}
 */
function detectBin(o) {
  const exists = o.exists ?? nodeFs.existsSync;
  if (o.manual && exists(o.manual)) return { path: o.manual, source: 'manual' };
  for (const n of o.names ?? []) {
    const p = o.which?.(n);
    if (p) return { path: p, source: 'path' };
  }
  for (const dir of o.known ?? []) {
    for (const n of o.names ?? []) {
      const p = path.join(dir, n);
      if (exists(p)) return { path: p, source: 'known' };
    }
  }
  return null;
}

/** A basic harness's binary: the user's own path, else the test override, else the search above (`known`: the shared folders). */
function resolveBasic(id, o = {}) {
  const env = o.env ?? process.env;
  if (o.manual && (o.exists ?? nodeFs.existsSync)(o.manual)) return o.manual;
  if (env.SAGE_ACP_BINS) return quirks.findBin(id, o.which, env);
  return (
    detectBin({ names: quirks.quirks(id)?.bins ?? [], manual: o.manual, which: o.which, known: o.known ?? searchDirs(), exists: o.exists })
      ?.path ?? null
  );
}

/**
 * A desktop ACP harness's automatic path in highest-version mode. Admission owns discovery and reads the result
 * before it probes a binary. A manual path or the test override always wins, including edits during discovery.
 * @param {{ manualOf: (id: string) => string | undefined, which: (name: string) => string | null,
 *   env: () => NodeJS.ProcessEnv }} o
 */
function createHighestBasic({ manualOf, which, env }) {
  /** @type {Map<string, string>} */
  const selected = new Map();
  function explicit(id) {
    const manual = manualOf(id);
    if (manual && nodeFs.existsSync(manual)) return manual;
    if (process.env.SAGE_ACP_BINS) return quirks.findBin(id, which);
    return undefined;
  }
  function resolveBin(id) {
    const override = explicit(id);
    if (override !== undefined) return override;
    const known = selected.get(id);
    return known && runnableTool(known) ? known : resolveBasic(id, { which, exists: runnableTool });
  }
  function discoverBin(id) {
    if (explicit(id) !== undefined) return;
    const q = quirks.quirks(id);
    const seen = new Map();
    for (const bin of toolCandidates(q?.bins ?? [], [], true)) {
      if (!runnableTool(bin)) continue;
      const key = fileKey(bin);
      if (!seen.has(key)) seen.set(key, bin);
    }
    const paths = [...seen.values()];
    const remember = (/** @type {string | undefined} */ bin) => (bin ? selected.set(id, bin) : selected.delete(id));
    if (paths.length < 2) {
      remember(paths[0]);
      return;
    }
    const childEnv = env();
    return versionedToolCopies(paths, (bin) => toolVersion(bin, { env: childEnv })).then((copies) => {
      const order = highestInstalls(copies, `acp:${id}`, q?.admission?.blockedVersions);
      remember(order[0]?.path);
    });
  }
  return { resolveBin, discoverBin };
}

module.exports = { detectBin, resolveBasic, createHighestBasic };
