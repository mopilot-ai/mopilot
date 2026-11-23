// Folder trust for a Codex thread MoPilot starts, kept off the user's ~/.codex/config.toml (#1346). The app-server
// writes `[projects."<git root>"] trust_level = "trusted"` into that file when a thread starts in a folder with no trust
// entry and a sandbox that can write (measured on 0.163: workspace-write and danger-full-access, never read-only). Any
// trust_level for the folder in the thread's own config makes it skip the write, so the thread carries one instead.
const path = require('node:path');

const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** The trust the app-server would have written, and the thread then ran with. */
const TRUST_LEVEL = 'trusted';

/**
 * The folder-trust entries the user's own config holds, by path, from config/read.
 * @param {any} read what config/read answered
 * @returns {Record<string, string>}
 */
function userTrust(read) {
  const projects = read?.config?.projects;
  if (!isPlain(projects)) return {};
  return Object.fromEntries(
    Object.entries(projects)
      .filter(([, v]) => typeof v?.trust_level === 'string')
      .map(([k, v]) => [k, v.trust_level]),
  );
}

/** Whether the user's config already says something about the folder or a folder above it (the app-server keys trust by git root). */
function userDecides(cwd, trust) {
  let dir = cwd;
  while (!(dir in trust)) {
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
  return true;
}

/**
 * thread/start params with the folder trusted for this thread only. Left alone: a read-only thread (it never writes
 * trust), a start without an absolute cwd, a folder the user's config already decides, and a trust a window set itself.
 * @param {any} params @param {Record<string, string>} trust userTrust of the user's config
 */
function withTrust(params, trust) {
  const p = params || {};
  const cwd = p.cwd;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || p.sandbox === 'read-only') return p;
  if (userDecides(cwd, trust) || p.config?.projects?.[cwd]) return p;
  const projects = { ...(isPlain(p.config?.projects) ? p.config.projects : {}), [cwd]: { trust_level: TRUST_LEVEL } };
  return { ...p, config: { ...(isPlain(p.config) ? p.config : {}), projects } };
}

module.exports = { TRUST_LEVEL, userTrust, userDecides, withTrust };
