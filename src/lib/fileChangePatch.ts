// Serialize file-change patches for Undo/Restore, preserving filenames, modes and newline records.
import { gitPath, relPath, isWinPath } from './paths';
import { diffFileText, fileChangeToDiff } from './diff';
import { encodeGitPath } from './gitPath';

/** Build an undo/restore patch from a file change, preserving existing full patches. */
export function fileChangePatch(
  change: { path: string; kind?: { type?: string } | string | null; diff?: string | null },
  cwd: string,
): string {
  const d = change.diff ?? '';
  if (/^(?:diff --git (?:a\/|")|--- [^\n]+\n\+\+\+ [^\n]+)/.test(d)) return d;
  const path = gitPath(relPath(change.path, cwd), isWinPath(cwd));
  const file = fileChangeToDiff({ path, kind: change.kind, diff: d });
  if (!d && !file.isNew && !file.isDeleted) return '';
  const patch = diffFileText(file);
  return patch.startsWith('diff --git ') ? patch : `diff --git ${encodeGitPath(`a/${path}`)} ${encodeGitPath(`b/${path}`)}\n${patch}`;
}
