// Git path quoting, UTF-8 escape decoding, and timestamped unified header filenames.
import { decodeGitPath } from '../../shared/gitPathLine.mjs';
export { decodeGitPath };

/** Encode a filename for a patch header without letting control characters split it. */
export function encodeGitPath(path: string): string {
  if (!/[\x00-\x20\x7f"\\]/.test(path)) return path;
  const escaped = path.replace(/[\x00-\x1f\x7f"\\]/g, (char) =>
    char === '"' || char === '\\' ? `\\${char}` : `\\${char.charCodeAt(0).toString(8).padStart(3, '0')}`,
  );
  return `"${escaped}"`;
}

/** Unified file headers may append a tab-separated timestamp after the filename. */
export function decodeDiffHeaderPath(path: string): string {
  const quoted = /^("(?:\\.|[^"\\])*")(?:\t.*)?$/.exec(path);
  return decodeGitPath(quoted ? quoted[1] : path.split('\t', 1)[0]);
}
