// The path helpers main and the window share (the rest are in src/lib/paths.ts). POSIX paths, or
// Windows paths (C:\repo, C:/repo, \\server\share).

const SEP = /[\\/]/;
const TRAIL = /[\\/]+$/;

/** Drive-letter (C:\, C:/, C:) or UNC (\\server\share) path. */
export const isWinPath = (p) => /^[A-Za-z]:([\\/]|$)/.test(p) || /^\\\\[^\\]/.test(p);

/** A Windows path's comparable form: lower-cased, '\' separators, no trailing one. */
export const winPathKey = (p) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

export function basename(p) {
  if (!p) return '';
  if (!isWinPath(p)) {
    const parts = p.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || p;
  }
  // a drive or UNC path keeps a non-empty last segment (C:\ → C:)
  const parts = p.replace(TRAIL, '').split(SEP);
  return parts[parts.length - 1];
}

/** The last `depth` parent folders of `p`, to tell two same-named projects apart ("work/api"). */
export function parentHint(p, depth) {
  const parts = (isWinPath(p) ? p.split(SEP) : p.split('/')).filter(Boolean);
  return parts
    .slice(0, -1)
    .slice(-depth)
    .join(isWinPath(p) ? '\\' : '/');
}

/**
 * What tells projects of one name apart, as the Mac's sidebar shows it after the name: the last parent folders of each project's folder, as many
 * as it takes for them to differ (up to three). Only a name two projects share gets hints; a project with no folder gets none.
 * @param {{ id: string, name: string, path?: string | null }[]} projects every project the list holds
 * @returns {Map<string, string>} project id to its hint
 */
export function projectHints(projects) {
  const byName = new Map();
  for (const p of projects) {
    const key = p.name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), p]);
  }
  const hints = new Map();
  for (const same of byName.values()) {
    if (same.length < 2) continue;
    // the folders there are to compare: a project with none cannot be told apart, and does not make the others say more
    const placed = same.filter((p) => p.path);
    let found = new Map();
    for (let depth = 1; depth <= 3; depth++) {
      found = new Map(placed.map((p) => [p.id, parentHint(p.path, depth)]));
      if (new Set(found.values()).size === placed.length) break;
    }
    for (const [id, hint] of found) if (hint) hints.set(id, hint);
  }
  return hints;
}
