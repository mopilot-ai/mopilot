// Path helpers for paths that come from the main process, Codex or Claude Code: POSIX paths, or
// Windows paths (C:\repo, C:/repo, \\server\share). A Windows path splits on both separators and
// compares case-insensitively; a POSIX path is handled exactly as plain string slicing on '/'.

// isWinPath and basename are in shared/paths.mjs, since main runs them too
import { isWinPath, winPathKey } from '../../shared/paths.mjs';
export { isWinPath, basename, parentHint } from '../../shared/paths.mjs';
const SEP = /[\\/]/;
const TRAIL = /[\\/]+$/;

export function isAbsolutePath(p: string) {
  return p.startsWith('/') || isWinPath(p);
}

/** Path segments, without empty ones (the drive stays as "C:"). */
export function splitPath(p: string) {
  return (isWinPath(p) ? p.split(SEP) : p.split('/')).filter(Boolean);
}

export function dirname(p: string) {
  if (!isWinPath(p)) {
    const i = p.replace(/\/+$/, '').lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
  }
  const t = p.replace(TRAIL, '');
  const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'));
  if (i < 0) return p;
  const d = t.slice(0, i);
  // keep the root: C:\ not C:, \\server\share not \\server
  if (/^[A-Za-z]:$/.test(d)) return d + '\\';
  if (/^\\\\[^\\]+$/.test(d) || d === '\\') return p;
  return d;
}

/** `rel` under `base` (an absolute `rel` is returned as is), with the base's separator. */
export function joinPath(base: string, rel: string) {
  if (!base || isAbsolutePath(rel)) return rel;
  if (!isWinPath(base)) return `${base.replace(/\/+$/, '')}/${rel}`;
  return `${base.replace(TRAIL, '')}\\${rel.replace(/\//g, '\\')}`;
}

/** Comparable form: Windows paths lower-cased with '\' separators and no trailing one. */
function key(p: string) {
  return isWinPath(p) ? winPathKey(p) : p;
}

/** macOS lists /tmp, /var and /etc as /private/...: a session's reported cwd can use either spelling. */
const unprivate = (p: string) => p.replace(/^\/private(?=\/(?:tmp|var|etc)(?:\/|$))/, '');

export function samePath(a: string, b: string) {
  return (
    a === b || (isWinPath(a) && isWinPath(b) && key(a) === key(b)) || (!isWinPath(a) && !isWinPath(b) && unprivate(a) === unprivate(b))
  );
}

/** `p` is `root` itself or inside it. */
export function isUnder(p: string, root: string) {
  if (!p || !root) return false;
  if (!isWinPath(root)) {
    const r = root.replace(/\/+$/, '');
    const within = (q: string, base: string) => q === base || q.startsWith(base + '/');
    return within(p, r) || within(unprivate(p), unprivate(r));
  }
  const k = key(p);
  const r = key(root);
  return k === r || k.startsWith(r + '\\');
}

/** Equivalent directory roots, ignoring trailing separators and Windows case. */
export function sameDirectory(a: string, b: string) {
  return isUnder(a, b) && isUnder(b, a);
}

/** `p` relative to `cwd` when it's inside it, else `p` unchanged. */
export function relPath(p: string, cwd?: string | null) {
  if (!cwd) return p;
  if (!isWinPath(cwd)) {
    const root = cwd.replace(/\/+$/, '');
    return !sameDirectory(p, cwd) && p.startsWith(root + '/') ? p.slice(root.length + 1) : p;
  }
  return isUnder(p, cwd) && !samePath(p, cwd) ? p.slice(cwd.replace(TRAIL, '').length + 1) : p;
}

/** `p` resolved against `cwd` when it's relative. */
export function absPath(p: string, cwd?: string | null) {
  return isAbsolutePath(p) || !cwd ? p : joinPath(cwd, p);
}

/** Any user's home folder shortened to "~" (/Users/<name>, C:\Users\<name>). */
export function abbreviateHome(p: string) {
  if (isWinPath(p)) return p.replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+/i, '~');
  return p.replace(/^\/Users\/[^/]+/, '~');
}

/** The filesystem root ("/", "C:\", "C:"). */
export function isRootPath(p: string) {
  return p === '/' || /^[A-Za-z]:[\\/]?$/.test(p);
}

/** A Claude Code worktree (<repo>/.claude/worktrees/<name>/…) folded into its repo. */
export function foldClaudeWorktree(p: string) {
  return isWinPath(p) ? p.replace(/[\\/]\.claude[\\/]worktrees[\\/][^\\/]+.*$/, '') : p.replace(/\/\.claude\/worktrees\/[^/]+.*$/, '');
}

/** The repo folder name of a managed worktree (…/.mopilot/worktrees/<id>/<repo>/…, or the official app's …/.codex/worktrees/…), or null. */
export function codexWorktreeRepo(p: string) {
  const re = isWinPath(p)
    ? /[\\/]\.(?:codex|mopilot)[\\/]worktrees[\\/][^\\/]+[\\/]([^\\/]+)/
    : /\/\.(?:codex|mopilot)\/worktrees\/[^/]+\/([^/]+)/;
  return re.exec(p)?.[1] ?? null;
}

export function isCodexWorktree(p: string) {
  return isWinPath(p) ? /[\\/]\.(?:codex|mopilot)[\\/]worktrees[\\/]/.test(p) : /\/\.(?:codex|mopilot)\/worktrees\//.test(p);
}

/**
 * Last segment of a path that may be relative (src/a.ts, or src\a.ts from a Windows agent), for display.
 * `win`: backslashes separate too (the app runs on Windows).
 */
export function fileName(p: string, win = false): string {
  // split always gives at least one part: the last is the name ('' for a path ending in a separator)
  const parts = win || isWinPath(p) ? p.split(SEP) : p.split('/');
  return parts[parts.length - 1];
}

/** A path as git wants it in a patch header: forward slashes. */
export function gitPath(p: string, win = false) {
  return win || isWinPath(p) ? p.replace(/\\/g, '/') : p;
}

/** URL the main process's codex-asset: protocol serves a local image from. */
export function assetUrl(p: string) {
  if (!isWinPath(p)) return `codex-asset://${encodeURI(p).replace(/[?#]/g, encodeURIComponent)}`;
  return `codex-asset:///${encodeURI(p.replace(/\\/g, '/')).replace(/[?#]/g, encodeURIComponent)}`;
}

/**
 * Map key for a folder, equal for the paths samePath takes as one: Windows paths that differ only in case or
 * separators, and macOS's /private/tmp and /tmp (a session can report either spelling).
 */
export function pathKey(p: string) {
  return isWinPath(p) ? key(p) : unprivate(p);
}

/**
 * The folder a chat outside any saved project groups under: its cwd, with a Claude worktree
 * (<repo>/.claude/worktrees/<name>) folded into its repo. None for the home folder, the filesystem
 * root, the projectless task folder, or a managed worktree whose repo isn't known
 * (~/.mopilot/worktrees/<id>/<repo>, ~/.codex/worktrees/...).
 */
export function chatFolder(cwd: string | undefined, home: string, projectless: string) {
  const path = foldClaudeWorktree(cwd || '');
  if (!path || sameDirectory(path, home) || isRootPath(path)) return null;
  if (isUnder(path, projectless)) return null;
  if (isCodexWorktree(path)) return null;
  return path;
}

/** `decode(text)`, or the text as written when it holds a malformed escape (URIError is the normal answer there). */
export function decodeOrRaw(text: string, decode: (s: string) => string = decodeURIComponent): string {
  try {
    return decode(text);
  } catch (error) {
    if (error instanceof URIError) return text;
    throw error;
  }
}

/** A local link's encoded pathname and URI metadata; plain tool filenames keep literal reserved characters. */
export function localLinkParts(href: string, asUrl = false) {
  const isFileUrl = /^file:/i.test(href);
  const isUrl = asUrl || isFileUrl;
  const metadata = /(\?[^#]*)?(#[\s\S]*)?$/.exec(href)!;
  const path = (isUrl ? href.slice(0, metadata.index) : href)
    .replace(/^file:(?:\/\/([^/]*))?/i, (_prefix, host?: string) => {
      if (!host || /^localhost$/i.test(host)) return '';
      if (/^[A-Za-z]:$/.test(host)) return host;
      return `//${host}`;
    })
    .replace(/^\/([A-Za-z]:\/)/, '$1');
  return { path, search: isUrl ? (metadata[1] ?? '') : '', fragment: isUrl ? (metadata[2] ?? '') : '', isUrl, isFileUrl };
}

/** A literal match with the known folder resolves an ambiguous bare Markdown path; explicit file URLs decode as URIs. */
export function decodeLinkPath(path: string, link: Pick<ReturnType<typeof localLinkParts>, 'isUrl' | 'isFileUrl'>, folder?: string | null) {
  if (!link.isUrl) return path;
  if (link.isFileUrl || !folder?.includes('%') || !isAbsolutePath(path) || !isAbsolutePath(folder)) return decodeOrRaw(path);

  const windows = isWinPath(folder);
  if (windows !== isWinPath(path)) return decodeOrRaw(path);
  const nameKey = (name: string) => (windows ? name.toLowerCase() : name);
  const known = splitPath(nameKey(folder)).filter((part) => part !== '.');
  let index = 0;
  let end = 0;
  let prefix = '';
  // Compare components, ignoring repeated separators and `.`. Preserve the destination's original separators.
  for (const match of path.matchAll(windows ? /[^\\/]+/g : /[^/]+/g)) {
    const [part] = match;
    if (part === '.') continue;
    const expected = known[index++];
    const literal = nameKey(part) === expected;
    if (!literal && nameKey(decodeOrRaw(part)) !== expected) break;
    if (literal && part.includes('%')) {
      prefix += decodeOrRaw(path.slice(end, match.index)) + part;
      end = match.index + part.length;
    }
  }
  return prefix + decodeOrRaw(path.slice(end));
}
