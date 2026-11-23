// The phone's private modules (mobile/src/private, omitted from the open-source export): Metro bundles
// mobile/src/private/<path> in place of mobile/src/<path> where the checkout has it, so a private build signs in with
// MoPilot and the open-source one keeps the shared stand-in.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const PRIVATE = path.join(SRC, 'private');

/**
 * The file to bundle for `file`: its private counterpart where there is one, else itself.
 * @param {string} file absolute
 * @param {(file: string) => boolean} [exists]
 */
function privateCounterpart(file, exists = fs.existsSync) {
  const rel = path.relative(SRC, file);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep)[0] === 'private') return file;
  const counterpart = path.join(PRIVATE, rel);
  return exists(counterpart) ? counterpart : file;
}

/**
 * A Metro `resolveRequest` that resolves as `upstream` (the config's own, else Metro's) would, then takes a source file's
 * private counterpart.
 * @param {null | ((context: any, moduleName: string, platform: string | null) => any)} [upstream]
 * @param {(file: string) => boolean} [exists]
 */
function resolvePrivate(upstream = null, exists = fs.existsSync) {
  return (context, moduleName, platform) => {
    const resolved = (upstream ?? context.resolveRequest)(context, moduleName, platform);
    return resolved.type === 'sourceFile' ? { ...resolved, filePath: privateCounterpart(resolved.filePath, exists) } : resolved;
  };
}

module.exports = { privateCounterpart, resolvePrivate, SRC, PRIVATE };
