// Git path output, including C-quoted filenames with UTF-8 escapes.
export const parseGitPathLine = (out) => String(out || '').replace(/\n$/, '');

const escapes = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '"': '"', '\\': '\\' };

/** Git quotes unusual paths with C escapes; octal sequences encode UTF-8 bytes. @param {string} path */
export function decodeGitPath(path) {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  return path.slice(1, -1).replace(/(?:\\[0-7]{3})+|\\([abtnvfr"\\])/g, (encoded, escape) => {
    if (escape) return escapes[escape];
    const bytes = Uint8Array.from(encoded.matchAll(/[0-7]{3}/g), ([octal]) => parseInt(octal, 8));
    return new TextDecoder().decode(bytes);
  });
}
