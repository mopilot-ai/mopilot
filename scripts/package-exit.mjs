// Preserves packaging failure status through builder teardown listeners, so npm and CI cannot report a failed artifact as successful.
/** @param {number} code @param {NodeJS.Process} [proc] */
export function packageExit(code, proc = process) {
  if (code === 0) return;
  proc.exitCode = code;
  proc.once('exit', () => {
    proc.exitCode = code;
  });
}
