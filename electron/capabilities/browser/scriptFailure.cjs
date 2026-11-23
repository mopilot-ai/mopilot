// How a browser_script's outcome reads: the line it failed on, advice for the kind of failure, the error code it reports, and
// a result cut to length.
const { ownTable } = require('../../../shared/ownTable.mjs');
const { prefixUnits } = require('../../../shared/textPrefix.mjs');
const { oneLine } = require('./hostUtil.cjs');

const HINTS = ownTable({
  strict: 'Make the locator match one element: first(), nth(i), filter({ hasText }) or a more specific role and name.',
  timeout: 'Look at what the page shows (await tab.playwright.domSnapshot(), or tab.screenshot()) and adjust the locator or wait.',
  script_timeout: 'Split the work into shorter scripts, or pass a larger timeoutMs (at most 55000).',
  syntax: 'The code is the body of an async function: use await, and return or end with an expression for the result.',
});

/** Where a failure happened: "line N: <code>" from its stack (script lines are 1-based, after the wrapper line). */
function lineOf(code, err) {
  let n = err.line ?? null;
  if (n == null) {
    const m = /browser_script:(\d+):\d+/.exec(String(err.stack || ''));
    if (m) n = Number(m[1]) - 1;
  }
  const text = n != null ? code.split('\n')[n - 1] : undefined;
  return text === undefined ? '' : ` at line ${n}: ${oneLine(text, 200)}`;
}

function hintOf(err) {
  if (HINTS[err.code]) return HINTS[err.code];
  if (err.name === 'ReferenceError')
    return 'Only tab, browser, tabs, console, sleep and agent are defined: there is no require, process, fetch or setTimeout.';
  if (err.name === 'TypeError' && /is not a function|Cannot read properties/.test(String(err.message)))
    return 'Check the method against the API in the browser_script description.';
  return '';
}

/** The tool error code of a script's failure. @param {{ code?: string }} e */
function failureCode(e) {
  if (e.code === 'aborted' || e.code === 'look_only') return e.code;
  return e.code === 'timeout' || e.code === 'script_timeout' ? 'timeout' : 'script_failed';
}

const capped = (s, n) => (s.length > n ? `${prefixUnits(s, n)}\n[Truncated at ${n.toLocaleString('en-US')} characters.]` : s);

module.exports = { lineOf, hintOf, failureCode, capped };
