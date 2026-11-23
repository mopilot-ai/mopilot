// Stable diagnostic grouping shared by explicit user bug reports and optional private uploaders.
const crypto = require('node:crypto');

/** "macOS" / "Windows" / "Linux", for the batch header. */
const osName = () => ({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' })[process.platform] ?? process.platform;

function fingerprint(message, stack) {
  const frames = String(stack || '')
    .split('\n')
    .filter((l) => /^\s+at /.test(l))
    .slice(0, 3)
    .map((l) =>
      l
        .replace(/\(.*[/\\]/, '(')
        .replace(/(at\s+)\S*[/\\]/, '$1')
        .replace(/:\d+:\d+/g, '')
        // a build renames its bundles and minified functions: the same error must stay one group across builds
        .replace(/-[\w-]{6,}(?=\.m?js)/g, '')
        .replace(/^(\s*at )(?:new )?\S{1,3} \(/, '$1(')
        .trim(),
    );
  const msg = String(message || '')
    .replace(/\d+/g, 'N')
    .replace(/(["']).*?\1/g, '""')
    .slice(0, 200);
  return crypto
    .createHash('sha256')
    .update([msg, ...frames].join('|'))
    .digest('hex')
    .slice(0, 32);
}

module.exports = { fingerprint, osName };
