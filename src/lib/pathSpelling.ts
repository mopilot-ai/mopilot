// Normalize harmless path spelling differences without collapsing symlink-sensitive parent traversal.
import { absPath, isWinPath } from './paths';

export function pathSpelling(path: string, cwd: string): string {
  const full = absPath(path, cwd);
  const windows = isWinPath(full);
  const separator = windows ? '\\' : '/';
  return full
    .split(windows ? /[\\/]/ : '/')
    .filter((part) => part !== '.')
    .join(separator);
}
