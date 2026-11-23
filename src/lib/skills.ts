// Skill links and documents: which links point to a local SKILL.md, the skill's name and its frontmatter split from the body.

import { absPath, basename, dirname, decodeLinkPath, localLinkParts, isAbsolutePath } from './paths';
import { parseJson } from '../../shared/jsonRecord.mjs';

/** Only local SKILL.md links are skill references; web documentation stays a web link. */
export function skillPath(href: string, cwd?: string | null, asUrl = false): string | null {
  if (/^[a-z][\w+.-]*:/i.test(href) && !/^file:\/\//i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return null;
  const file = localLinkParts(href, asUrl);
  const destination = file.path.replace(/((?:^|[\\/])SKILL\.md)(?:#.*|:L?\d+(?:[-:]\d+)?)$/i, '$1');
  const path = decodeLinkPath(destination, file, cwd);
  if (basename(path).toLowerCase() !== 'skill.md' || (!isAbsolutePath(path) && !cwd)) return null;
  return absPath(path, cwd);
}

export const skillName = (path: string) => basename(dirname(path));

/** Keep frontmatter out of the rendered instructions and preserve every field for inspection. */
export function skillDocument(source: string) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(source);
  if (!match) return { body: source, metadata: [] as [string, string][] };
  const metadata: [string, string][] = [];
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([\w-]+):\s*(.*)$/.exec(line);
    if (field) metadata.push([field[1], field[2]]);
    else if (metadata.length && /^\s+\S/.test(line)) metadata[metadata.length - 1][1] += '\n' + line.trimEnd();
  }
  return {
    body: source.slice(match[0].length),
    metadata: metadata.map(([key, value]): [string, string] => {
      if (/^[>|][-+]?\n/.test(value)) {
        const folded = value[0] === '>';
        value = value.slice(value.indexOf('\n') + 1).replace(/^\s+/gm, '');
        if (folded) value = value.replace(/\n(?=\S)/g, ' ');
      } else if (/^"[^\n]*"$/.test(value)) {
        // a quoted JSON string is a string; one that isn't valid JSON keeps the quotes as written
        const parsed = parseJson(value);
        if (parsed.ok) value = parsed.value as string;
      } else if (/^'[^\n]*'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'");
      return [key, value];
    }),
  };
}
