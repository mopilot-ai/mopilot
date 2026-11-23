// The value after a `--name` flag on a script's command line, the one reader the build, package and release scripts use.

/**
 * The argument after `--name` (or `name` when it already starts with `--`) in `argv`; `def` when the flag is absent.
 * @param {string[]} argv
 * @param {string} name
 * @param {string} [def]
 * @returns {string | undefined}
 */
export function flagValue(argv, name, def) {
  const i = argv.indexOf(name.startsWith('--') ? name : `--${name}`);
  return i >= 0 ? argv[i + 1] : def;
}
