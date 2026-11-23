// Decode completed Biome JSON reports without turning missing output or process failures into clean lint results.

/** @typedef {{ status: number | null, signal?: NodeJS.Signals | null, error?: Error, stdout?: string | null, stderr?: string | null }} BiomeResult */
/** @typedef {{ message: string, severity: string, category?: string, location?: { path?: string, start?: { line?: number } | null } | null }} Diagnostic */
/** @typedef {{ diagnostics: Diagnostic[] }} BiomeReport */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Only the fields consumers read are checked; global diagnostics and extra reporter fields remain valid. */
function diagnostic(/** @type {unknown} */ value) {
  if (!record(value) || typeof value.message !== 'string' || typeof value.severity !== 'string') return false;
  if (value.category !== undefined && typeof value.category !== 'string') return false;
  if (value.location == null) return true;
  if (!record(value.location)) return false;
  const { path, start } = value.location;
  if (path !== undefined && typeof path !== 'string') return false;
  if (start == null) return true;
  return record(start) && (start.line === undefined || typeof start.line === 'number');
}

/** Bound each text field before escaping it so empty, multiline and truncated output is unambiguous. */
function excerpt(/** @type {string | null | undefined} */ value) {
  if (value == null) return '<unavailable>';
  const limit = 2048;
  return JSON.stringify(value.slice(0, limit)) + (value.length > limit ? ` ... (${value.length - limit} more characters)` : '');
}

/**
 * Lint findings legitimately exit 1. Other exit statuses, spawn errors and signals never yield usable reports.
 * @param {BiomeResult} result
 * @param {{ file: string, input?: string }} context A fixture path/input or the ratchet's requested file scope.
 * @returns {BiomeReport}
 */
export function decodeBiomeReport(result, context) {
  try {
    if (result.error) throw result.error;
    if (result.signal || (result.status !== 0 && result.status !== 1)) throw new Error('Biome did not complete normally');
    const report = JSON.parse(result.stdout ?? '');
    if (!record(report) || !Array.isArray(report.diagnostics) || !report.diagnostics.every(diagnostic))
      throw new TypeError('Expected a Biome report object with a diagnostics array of diagnostic records');
    return /** @type {BiomeReport} */ (report);
  } catch (cause) {
    throw new Error(
      [
        `Biome did not produce a usable report for ${excerpt(context.file)}`,
        `status=${result.status}; signal=${result.signal ?? 'none'}`,
        `cause=${excerpt(cause instanceof Error ? cause.message : String(cause))}`,
        `input=${excerpt(context.input)}`,
        `stderr=${excerpt(result.stderr)}`,
        `stdout=${excerpt(result.stdout)}`,
      ].join('\n'),
      { cause },
    );
  }
}
