// The MCP gateway's per-tool rules (#2999 C3), as a pure matcher and evaluator: a rule is {connector, pattern, stance, scope, harness?}; the rules that match a call are those for its server (or `*`) whose glob matches the tool's own name, whose scope covers the chat (all, its harness, or a project folder it works in, as a `/` path or a `C:/` one), and whose `harness`, when it names one, is the chat's; the most specific scope wins (a deeper project over a shallower one, a project over a harness, a harness over all) and on a tie block beats ask beats allow, so a block written later at the same scope as an allow wins. With no rule the chat's permission mode decides: Full access allows, otherwise a tool the server says only reads is allowed and every other one asks. A rule holds in every permission mode, so a block holds under Full access too. While the rules file can't be read, the blocks and asks last read still hold and nothing is allowed without asking (fail closed).

/** The stances, weakest first: on a tie of scope the later one wins. */
export const STANCES = Object.freeze(['allow', 'ask', 'block']);

/** A glob over a tool's name: `*` any run of characters, `?` one, `\` escapes the next (a tool named `a*b` is `a\*b`). */
export function globMatch(pattern, name) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) re += escapeChar(pattern[++i]);
    else if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else re += escapeChar(c);
  }
  return new RegExp(`^${re}$`, 's').test(name);
}

const escapeChar = (c) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** A tool's own name as a pattern that matches it alone (what "Always allow" writes). */
export const exactPattern = (name) => String(name).replace(/[\\*?]/g, '\\$&');

/** A folder without its trailing separators (the root stays `/`). */
const folder = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/** Whether `path` is `dir` or inside it (both as written: the caller gives real paths, in the file system's own case). */
function within(path, dir) {
  const d = folder(dir);
  const p = folder(path);
  return p === d || p.startsWith(d.endsWith('/') ? d : `${d}/`);
}

/** An absolute folder as rules and chats write it: `/…`, a drive's `C:/…` or a network share's `//server/share…` (Windows, with `/` separators). */
const ABSOLUTE = /^(?:\/|[A-Z]:\/)/;

/**
 * A project folder written plainly, so the same folder is always the same text: absolute, `/` separators, an upper-case
 * drive letter, no `.` or `..` part, no empty one (but a network share's leading `//`), no trailing `/` (but a root's).
 * The folder as kept, or null.
 */
function plainFolder(f) {
  if (!ABSOLUTE.test(f) || f.includes('\\')) return null;
  const unc = f.startsWith('//');
  const rest = unc ? f.slice(1) : f;
  const cut = rest.length > 1 && !/^[A-Z]:\/$/.test(rest) ? rest.replace(/\/+$/, '') : rest;
  // a drive's root keeps its `/` (`C://` is `C:/`)
  const trimmed = /^[A-Z]:$/.test(cut) ? `${cut}/` : cut;
  if (/\/\.{1,2}(?:\/|$)|\/\//.test(trimmed) || (unc && !/^\/[^/]+\/[^/]+/.test(trimmed))) return null;
  return unc ? `/${trimmed}` : trimmed;
}

/** Whether a harness id (a kind or a family) names the chat's harness kind. */
const namesHarness = (id, harness) => !!id && !!harness && (id === harness || id === harness.split(':')[0]);

/**
 * How specifically `scope` covers the chat: -1 when it doesn't, 0 all, 1 its harness, 2 + the folder's length for a
 * project it works in (a deeper folder is more specific). `undefined` (with `project` unknown) for a project scope that
 * might cover it. `project`: the chat's folder (a worktree's project), null for none.
 * @param {string} scope @param {{ harness: string | null, project: string | null | undefined }} ctx
 */
export function scopeRank(scope, ctx) {
  if (scope === 'all') return 0;
  if (scope.startsWith('harness:')) return namesHarness(scope.slice('harness:'.length), ctx.harness) ? 1 : -1;
  if (scope.startsWith('project:')) {
    const dir = scope.slice('project:'.length);
    if (!ABSOLUTE.test(dir)) return -1;
    if (ctx.project === undefined) return undefined;
    return ctx.project && within(ctx.project, dir) ? 2 + folder(dir).length : -1;
  }
  return -1;
}

/**
 * The stance for one call (or one listing) of a gateway tool.
 * @param {{ rules: readonly { connector: string, pattern: string, stance: string, scope: string, harness?: string }[], connector: string, tool: string,
 *   readOnly: boolean, harness: string | null, project: string | null | undefined, fullAccess: boolean, unreadable?: boolean }} o
 *   project: the chat's folder, null for none, undefined while it isn't known (a listing, a folder that couldn't be
 *   read): then a project rule that might apply makes the answer uncertain
 * @returns {{ stance: 'allow' | 'ask' | 'block', rule: object | null, certain: boolean, why: 'rule' | 'unreadable' | 'full-access' | 'read-only' | 'default' }}
 */
export function decideStance({ rules, connector, tool, readOnly, harness, project, fullAccess, unreadable = false }) {
  let best = null;
  let bestRank = -1;
  /** the stances of project rules that might apply while the folder isn't known */
  const maybe = new Set();
  for (const r of rules) {
    if (!STANCES.includes(r.stance)) continue;
    // rules that can't be read now: an allow last read is not trusted (a block or an ask still holds)
    if (unreadable && r.stance === 'allow') continue;
    if (r.harness !== undefined && !namesHarness(r.harness, harness)) continue;
    if (r.connector !== '*' && r.connector !== connector) continue;
    if (!globMatch(r.pattern, tool)) continue;
    // naming a harness too narrows where a rule applies, not how specific its scope is: a later block at the same scope wins the tie
    const rank = scopeRank(r.scope, { harness, project });
    if (rank === undefined) {
      maybe.add(r.stance);
      continue;
    }
    if (rank < 0) continue;
    if (rank > bestRank || (rank === bestRank && STANCES.indexOf(r.stance) > STANCES.indexOf(best.stance))) {
      best = r;
      bestRank = rank;
    }
  }
  /** @type {{ stance: 'allow' | 'ask' | 'block', rule: object | null, why: any }} */
  const d = best
    ? { stance: /** @type {any} */ (best.stance), rule: best, why: 'rule' }
    : // rules that couldn't be read: no allow is trusted, so everything without a block or an ask asks
      unreadable
      ? { stance: 'ask', rule: null, why: 'unreadable' }
      : fullAccess
        ? { stance: 'allow', rule: null, why: 'full-access' }
        : readOnly
          ? { stance: 'allow', rule: null, why: 'read-only' }
          : { stance: 'ask', rule: null, why: 'default' };
  // a project rule that might apply outranks every rule that does (a project over a harness over all): the answer is
  // sure only when each such rule would give the same stance
  const certain = [...maybe].every((m) => m === d.stance);
  return { ...d, certain };
}

const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

/**
 * A rule as the store keeps it, or null when it isn't a valid one: a connector (a server's key, or `*`), a glob of 1 to
 * 256 characters, a stance, and a scope (`all`, `harness:<id>`, `project:<absolute folder>`).
 */
export function ruleOf(v) {
  const r = record(v);
  if (!r) return null;
  const { connector, pattern, stance, scope, harness } = r;
  if (harness !== undefined && (typeof harness !== 'string' || !/^[a-z0-9][a-z0-9:._-]{0,127}$/.test(harness))) return null;
  if (typeof connector !== 'string' || !connector || connector.length > 8192) return null;
  if (typeof pattern !== 'string' || !pattern || pattern.length > 256 || /[\u0000-\u001f\u007f]/.test(pattern)) return null;
  if (!STANCES.includes(stance)) return null;
  if (typeof scope !== 'string' || scope.length > 4096 || /[\u0000-\u001f\u007f]/.test(scope)) return null;
  const dir = scope.startsWith('project:') ? plainFolder(scope.slice('project:'.length)) : null;
  if (scope !== 'all' && !/^harness:[a-z0-9][a-z0-9:._-]{0,127}$/.test(scope) && !dir) return null;
  const kept = dir ? `project:${dir}` : scope;
  return harness === undefined ? { connector, pattern, stance, scope: kept } : { connector, pattern, stance, scope: kept, harness };
}
