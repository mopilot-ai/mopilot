// The local path and cited lines a message link names, shared by the click that opens it and the link's path menu.

import { lineSpan, type LineSpan } from './lineSpan';
import { decodeLinkPath, localLinkParts } from './paths';
import { parseRemoteCwd } from './remotePaths';

/**
 * The path (and cited lines) a message link names, or null for a web or mail link. `#L12`, `:12:5` (a column) or a
 * range `#L5-L20` / `:5-20` is the location; `asUrl` reads the link as a URL (Markdown), so `%20` is a space.
 */
export function linkTarget(href: string, cwd?: string | null, asUrl = false): { path: string; span: LineSpan } | null {
  if (/^https?:|^mailto:/i.test(href)) return null;
  const file = localLinkParts(href, asUrl);
  let path = file.path;
  const citation = /[#:]L?(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?|:\d+)?$/;
  const inPath = citation.exec(path);
  const fragment = citation.exec(file.fragment);
  const location = fragment?.index === 0 ? fragment : inPath;
  if (inPath) path = path.slice(0, inPath.index);
  const folder = parseRemoteCwd(cwd)?.folder ?? cwd;
  return { path: decodeLinkPath(path, file, folder), span: location ? lineSpan(location[1], location[2]) : {} };
}
