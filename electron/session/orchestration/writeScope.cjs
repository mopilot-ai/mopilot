// start_session's write scope for a linked session that shares its parent's folder: the globs it declares (`paths`),
// the refusal of a start whose globs overlap those of another live session of the same parent in that folder, and the
// files a turn edited outside its globs. Checked at start and flagged after; nothing blocks a write while it runs.
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { nameOf, stateWord } = require('./family.cjs');

/** At most this many globs, each at most MAX_GLOB_CHARS long. */
const MAX_PATHS = 20;
const MAX_GLOB_CHARS = 200;
/** A segment with one of these is a pattern; the segments before the first such one are the glob's static prefix. */
const GLOB_CHARS = /[*?[{]/;
/** The states in which a session still writes, or is about to. */
// a session waiting for others (or held by one) starts writing on its own once they finish (dependants.cjs)
const LIVE = new Set(['working', 'queued', 'needs the user', 'waiting', 'held']);

/**
 * @param {string} code
 * @param {string} [message]
 * @returns {never}
 */
function fail(code, message = code) {
  throw Object.assign(new Error(message), { code });
}

const INVALID = `paths is a list of 1 to ${MAX_PATHS} globs relative to the folder (each at most ${MAX_GLOB_CHARS} characters, no absolute path, no "..")`;

/** Whether a glob's braces open and close in order. */
function balanced(glob) {
  let depth = 0;
  for (const c of glob) {
    if (c === '{') depth++;
    else if (c === '}' && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * start_session's `paths`, checked: relative globs with "/" separators, without "./" or a trailing "/", once each;
 * "." alone is the whole folder ("**"). Null when none were passed.
 * @param {unknown} value
 * @returns {string[] | null}
 */
function pathsArg(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || !value.length || value.length > MAX_PATHS) fail('invalid_paths', INVALID);
  const out = value.map((raw) => {
    if (typeof raw !== 'string') fail('invalid_paths', INVALID);
    const glob = raw.trim().replace(/\\/g, '/');
    if (!glob || glob.length > MAX_GLOB_CHARS || glob.startsWith('/') || glob.startsWith('~') || /^[a-zA-Z]:/.test(glob))
      fail('invalid_paths', INVALID);
    const segments = glob.split('/').filter((s) => s && s !== '.');
    if (segments.includes('..') || glob.startsWith('!') || !balanced(glob)) fail('invalid_paths', INVALID);
    return segments.length ? segments.join('/') : '**';
  });
  return [...new Set(out)];
}

/** The segments of a glob before its first pattern segment, lower-cased (folders may not tell case apart). */
function staticPrefix(glob) {
  const segments = glob.toLowerCase().split('/');
  const first = segments.findIndex((s) => GLOB_CHARS.test(s));
  return first < 0 ? segments : segments.slice(0, first);
}

/**
 * Whether two globs may name the same file, conservatively: unless their static prefixes differ in a segment both
 * have, they overlap. A literal path covers what is under it, as a folder would.
 * @param {string} a
 * @param {string} b
 */
function overlaps(a, b) {
  const pa = staticPrefix(a);
  const pb = staticPrefix(b);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) if (pa[i] !== pb[i]) return false;
  return true;
}

const escape = (c) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * A glob as a regular expression over a whole relative path, ignoring case: "**" spans folders, "*" and "?" stay in
 * one, "[...]" is a character class ("[!...]" negated), "{a,b}" either.
 * @param {string} glob
 */
function globRegExp(glob) {
  let re = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    const segmentStart = i === 0 || glob[i - 1] === '/';
    if (c === '*' && glob[i + 1] === '*' && segmentStart && glob[i + 2] === '/') {
      re += '(?:[^/]*/)*';
      i += 2;
    } else if (c === '*' && glob[i + 1] === '*' && segmentStart && i + 2 === glob.length) {
      re += '.*';
      i += 1;
    } else if (c === '*') {
      re += '[^/]*';
      while (glob[i + 1] === '*') i++;
    } else if (c === '?') re += '[^/]';
    else if (c === '[' && glob.indexOf(']', i + 2) > 0) {
      const end = glob.indexOf(']', i + 2);
      const body = glob.slice(i + 1, end);
      re += `[${body.startsWith('!') ? `^${escape(body.slice(1))}` : escape(body)}]`;
      i = end;
    } else if (c === '{') {
      depth++;
      re += '(?:';
    } else if (c === '}' && depth) {
      depth--;
      re += ')';
    } else if (c === ',' && depth) re += '|';
    else re += escape(c);
  }
  return new RegExp(`^${re}$`, 'i');
}

/**
 * Whether the relative path `file` is in scope: a glob matches it or a folder it is in.
 * @param {string} file "/"-separated, relative to the folder
 * @param {RegExp[]} patterns
 */
function covered(file, patterns) {
  const segments = file.split('/');
  for (let n = segments.length; n > 0; n--) {
    const prefix = segments.slice(0, n).join('/');
    if (patterns.some((re) => re.test(prefix))) return true;
  }
  return false;
}

/**
 * An edited path as the folder sees it: relative with "/" separators, or the path as given when it is outside it.
 * @param {string} cwd
 * @param {string} file absolute, or relative to cwd
 * @param {typeof path} [p] the platform's path rules (a Windows path on another drive has no relative form)
 */
function relativeTo(cwd, file, p = path) {
  const full = p.resolve(cwd, file);
  const rel = p.relative(cwd, full);
  if (!rel || rel === '..' || rel.startsWith(`..${p.sep}`) || p.isAbsolute(rel)) return full;
  return rel.split(p.sep).join('/');
}

/**
 * The files of `edited` outside the globs, relative to `cwd` (a file outside the folder keeps its whole path).
 * @param {string[]} edited
 * @param {string} cwd
 * @param {string[]} globs
 */
function outsideOf(edited, cwd, globs) {
  const patterns = globs.map(globRegExp);
  // a harness may name a file by the folder's real path (/private/var/... for /var/...)
  const bases = [...new Set([cwd, realOf(cwd)])];
  const out = new Set();
  for (const file of edited) {
    const rels = bases.map((base) => relativeTo(base, file));
    const rel = rels.find((r) => !path.isAbsolute(r)) ?? rels[0];
    if (path.isAbsolute(rel) || !covered(rel, patterns)) out.add(rel);
  }
  return [...out];
}

/** The folder's real path, or the path itself when it can't be read (a folder since removed). @param {string} dir */
function realOf(dir) {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return dir;
  }
}

/**
 * A start into the parent's own folder, refused while another live session the parent started works there unless its
 * declared paths keep off that one's: one with no paths may write anywhere in it. A lone session needs no paths.
 * @param {{ o: any, journal: any, archived: (chatId: string) => boolean }} orch
 * @param {string} parentId
 * @param {string} cwd the parent's folder
 * @param {string[] | null | undefined} paths the new session's globs
 * @param {string | null} [exclude] an already reserved recipient must not conflict with itself
 */
function checkScope(orch, parentId, cwd, paths, exclude = null) {
  const here = path.resolve(cwd);
  const live = orch.journal.childrenOf(parentId).filter((id) => {
    const c = orch.journal.child(id);
    return (
      id !== exclude &&
      !c.useWorktree &&
      path.resolve(String(c.cwd)) === here &&
      !orch.archived(id) &&
      (c.awaitingBrief || LIVE.has(stateWord(orch.o.controller, orch.journal, id)))
    );
  });
  if (!live.length) return;
  const names = live.map((id) => `${nameOf(orch.journal, id)} (${id})`).join(', ');
  if (!paths?.length)
    fail(
      'paths_required',
      `${names} works in this folder now. Pass paths (globs of the files this session will write, relative to the folder) that keep off theirs, pass use_worktree: true to give it its own worktree, or start it once they are done.`,
    );
  for (const id of live) {
    const theirs = orch.journal.child(id).paths;
    const name = `${nameOf(orch.journal, id)} (${id})`;
    if (!theirs?.length)
      fail(
        'paths_overlap',
        `${name} works in this folder with no declared paths, so it may write anywhere in it. Pass use_worktree: true to give this session its own worktree, or start it once that one is done.`,
      );
    const clash = paths.filter((p) => theirs.some((t) => overlaps(p, t)));
    if (clash.length)
      fail(
        'paths_overlap',
        `${clash.join(', ')} may overlap the paths ${name} declared (${theirs.join(', ')}). Narrow paths so they keep off those, pass use_worktree: true, or start it once that one is done.`,
      );
  }
}

module.exports = { pathsArg, overlaps, staticPrefix, globRegExp, covered, relativeTo, outsideOf, checkScope, MAX_PATHS, MAX_GLOB_CHARS };
