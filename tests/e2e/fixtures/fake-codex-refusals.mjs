// Requests the fake Codex refuses on purpose: methods an older app-server lacks, and reads a test makes fail.
import fs from 'node:fs';

// methods in $FAKE_CODEX_MISSING (comma-separated) answer "unknown variant", as an app-server without them does
const MISSING = new Set((process.env.FAKE_CODEX_MISSING || '').split(',').filter(Boolean));
// methods in $FAKE_CODEX_FAIL fail until the file $FAKE_CODEX_LOG.unfail appears, so a failed read can be retried
const FAILING = new Set((process.env.FAKE_CODEX_FAIL || '').split(',').filter(Boolean));
const LOG = process.env.FAKE_CODEX_LOG;

/** The error a request gets instead of its result, or null when it is answered. @param {string} method */
export function refusal(method) {
  if (FAILING.has(method) && !(LOG && fs.existsSync(`${LOG}.unfail`)))
    return { code: -32603, message: `${method} failed (FAKE_CODEX_FAIL)` };
  if (MISSING.has(method)) return { code: -32600, message: `Invalid request: unknown variant \`${method}\`` };
  return null;
}
