// What the offline WebGames server answers: static files from the built dist (single-page fallback, never outside
// it) and the completion record a page posts when it sees its game solved.
import path from 'node:path';

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
};

/** @param {string} file */
export const contentType = (file) => TYPES[path.extname(file)] ?? 'application/octet-stream';

/**
 * The file to serve for a URL path: the file itself when it is inside dist and exists, else index.html.
 * @param {string} dist @param {string} pathname @param {(p: string) => boolean} isFile
 */
export function staticFile(dist, pathname, isFile) {
  const root = path.resolve(dist);
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = '/';
  }
  const file = path.resolve(path.join(root, decoded));
  const inside = file.startsWith(`${root}${path.sep}`);
  return inside && isFile(file) ? file : path.join(root, 'index.html');
}

/**
 * The log line for a completion a page posted: when, which browser, and what the page sent (raw text when it was
 * not JSON).
 * @param {string} body @param {string | undefined} ua
 */
export function completionEntry(body, ua, now = Date.now()) {
  let entry;
  try {
    entry = JSON.parse(body);
  } catch {
    entry = { raw: body };
  }
  return `${JSON.stringify({ at: now, ua, ...entry })}\n`;
}
