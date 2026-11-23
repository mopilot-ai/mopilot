// Records errors main-process code ignores on purpose: a console.debug line, and the last 50 (scrubbed) for "Copy diagnostics".
// Use it for best-effort cleanup, optional probes and cosmetic steps; docs/bug-prevention/swallowed-errors.md.
'use strict';
const os = require('node:os');
const { scrub } = require('../shared/scrub.cjs');
const { prefixUnits } = require('../shared/textPrefix.mjs');

const LIMIT = 50;
/** longest context and message kept, in characters */
const MAX_TEXT = 500;
/**
 * longest text cleaned: only the first MAX_TEXT characters are kept, and the URL pattern below scans from each URL to
 * the next space, so an error message of megabytes without spaces would take quadratic time
 */
const MAX_CLEANED = 64 * MAX_TEXT;
/** @type {{ context: string, message: string, at: string, count: number }[]} */
const ring = [];

/** Scrubbed, without URL queries and fragments (they can carry codes and tokens), and bounded. */
function clean(text) {
  // the scheme is bounded, as in shared/scrub.cjs: an unbounded one is retried from every position of a long word
  const out = scrub(prefixUnits(text, MAX_CLEANED), { home: os.homedir() }).replace(
    /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s?#]*)[?#][^\s'"]*/gi,
    '$1?…',
  );
  return out.length > MAX_TEXT ? `${prefixUnits(out, MAX_TEXT)}…` : out;
}

/**
 * Records an ignored error with what was being attempted. `expected`: error codes that are a normal answer
 * there (ENOENT for a file that may not exist yet), which are not recorded. The same error in the same place
 * again moves to the end with a count, so a frequent one does not push the others out.
 * @param {string} context what was being done, e.g. 'close the browser tab'
 * @param {unknown} error
 * @param {string[]} [expected]
 */
function noteIgnored(context, error, expected = []) {
  if (expected.length && expected.includes(/** @type {any} */ (error)?.code)) return;
  const raw = error instanceof Error && error.name !== 'Error' ? `${error.name}: ${error.message}` : messageOf(error);
  const what = clean(String(context));
  const message = clean(raw);
  const i = ring.findIndex((e) => e.context === what && e.message === message);
  const count = i < 0 ? 1 : ring.splice(i, 1)[0].count + 1;
  ring.push({ context: what, message, at: new Date().toISOString(), count });
  if (ring.length > LIMIT) ring.shift();
  console.debug(`[ignored] ${what}: ${message}`);
}

/**
 * noteIgnored as a rejection handler, for a best-effort promise nobody awaits:
 * `refresh().catch(ignoring('refresh the switches'))`.
 * @param {string} context
 * @param {string[]} [expected]
 * @returns {(error: unknown) => void}
 */
function ignoring(context, expected = []) {
  return (error) => noteIgnored(context, error, expected);
}

/**
 * What an error says: an Error's message, anything else as a string (something thrown that is not an Error).
 * @param {unknown} error
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** The recorded errors, oldest first. */
function recentIgnored() {
  return ring.map((e) => ({ ...e }));
}

/** Forgets every recorded error (tests). */
function clearIgnored() {
  ring.length = 0;
}

module.exports = { noteIgnored, ignoring, messageOf, recentIgnored, clearIgnored, IGNORED_LIMIT: LIMIT };
