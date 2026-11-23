// Git path quoting, UTF-8 escape decoding, and timestamped unified header filenames.

const escapes: Record<string, string> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '"': '"', '\\': '\\' };

/** Git quotes unusual paths with C escapes; octal sequences encode UTF-8 bytes. */
export function decodeGitPath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  return path.slice(1, -1).replace(/(?:\\[0-7]{3})+|\\([abtnvfr"\\])/g, (encoded, escape: string | undefined) => {
    if (escape) return escapes[escape];
    const bytes = encoded.match(/[0-7]{3}/g)!.map((octal: string) => parseInt(octal, 8));
    return new TextDecoder().decode(Uint8Array.from(bytes));
  });
}

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
