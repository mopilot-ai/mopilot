// A turn's identity across how it is named live and read back: Claude Code's ct-/h-, ACP's at-, a window's pending-.

/**
 * The part of a turn id every name of that turn shares: a Claude Code turn is ct-<prompt> live and h-<prompt> in its
 * transcript, an ACP turn at-<prompt>, and a window shows either as pending-<prompt> until it is named.
 * @param {string} id
 */
export function turnKey(id) {
  return String(id).replace(/^(?:pending|ct|h|at)-/, '');
}
