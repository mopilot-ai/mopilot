// Records errors renderer code ignores on purpose in main's ring (electron/ignored.cjs) for "Copy diagnostics"; console.debug without a bridge.
// Use it for best-effort cleanup, optional probes and cosmetic steps; docs/bug-prevention/swallowed-errors.md.

import { describeError, errorText } from '../../shared/userError.mjs';
import { installedNative } from './native';

// one copy for main and the windows (shared/userError.mjs); userError turns an error into a sentence a person reads
export { describeError, errorText };
export { userError } from '../../shared/userError.mjs';

/** The error's string `code` (ENOENT), or '' (a hostile getter included). */
function codeOf(error: unknown): string {
  try {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    return typeof code === 'string' ? code : '';
  } catch {
    return '';
  }
}

/**
 * Records an ignored error with what was being attempted. `expected`: error codes that are a normal answer there
 * (ENOENT for a file that may not exist yet), which are not recorded. Main keeps it, prefixed `renderer:`, with
 * the main process's own; without the bridge (tests, the web build) it is a console.debug line. Never throws.
 */
export function noteIgnored(context: string, error: unknown, expected: readonly string[] = []): void {
  if (expected.length && expected.includes(codeOf(error))) return;
  const message = describeError(error);
  try {
    // the one call it needs, typed here: this module loads where the bridge's own types may not (tests, tooling)
    const bridge = installedNative() as { app?: { ignored?: (context: string, message: string) => void } } | null;
    const send = bridge?.app?.ignored;
    if (typeof send === 'function') return send(context, message);
  } catch (sendError) {
    // the bridge itself failed: say so here, and never route it back through noteIgnored
    console.debug(`[ignored] report an ignored error to main: ${describeError(sendError)}`);
  }
  console.debug(`[ignored] ${context}: ${message}`);
}

/**
 * noteIgnored as a rejection handler, for a best-effort promise nobody awaits:
 * `refresh().catch(ignoring('refresh the usage'))`. Never throws.
 */
export function ignoring(context: string, expected: readonly string[] = []): (error: unknown) => void {
  return (error) => noteIgnored(context, error, expected);
}
