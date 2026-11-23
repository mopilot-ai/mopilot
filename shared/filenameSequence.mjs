// Compare decimal filename sequences exactly without rounding large integer identities.

/** @param {string} file */
export function filenameSequence(file) {
  const match = /^\s*([+-]?\d+)/.exec(file);
  return match ? BigInt(match[1]) : 0n;
}

/** Ascending numeric prefix order; nonnumeric legacy filenames have sequence zero. @param {string} a @param {string} b */
export function compareFilenameSequences(a, b) {
  const left = filenameSequence(a);
  const right = filenameSequence(b);
  return left === right ? 0 : left < right ? -1 : 1;
}
