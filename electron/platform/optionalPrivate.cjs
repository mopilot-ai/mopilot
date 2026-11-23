// Load a module under electron/private, which the open-source export omits: null when this build has none of it.
/**
 * The module at `file`, or null when that file is not in this build. Only its own absence reads as none: a private
 * module that is there but fails to load (or a module it needs that is missing) is a broken build, and throws.
 * @param {string} file absolute path
 * @param {(file: string) => any} [load]
 */
function optionalPrivate(file, load = require) {
  try {
    return load(file);
  } catch (error) {
    if (
      /** @type {NodeJS.ErrnoException} */ (error)?.code === 'MODULE_NOT_FOUND' &&
      String(error.message).startsWith(`Cannot find module '${file}'`)
    )
      return null;
    throw error;
  }
}

module.exports = { optionalPrivate };
