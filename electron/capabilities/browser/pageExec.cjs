// Runs model-written JavaScript in a page for browser_javascript_exec and browser_script's tab.evaluate: the value of the last
// expression comes back as text, and a Promise's resolved value in place of the Promise (an async function's result, fetch().then(...)).
// REPL mode lets a call use top-level await and declare the same name again, but its `awaitPromise` unwraps a Promise's
// result as the REPL's own `{value}` wrapper, so a Promise came back as `{}` and every tab.evaluate returned null (#3571).
const { ToolError } = require('../contract/registry.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { oneLine } = require('./hostUtil.cjs');

/** The group the handles of one call's result are made in, and released from: one per call, so overlapping calls on a tab never release each other's. */
let groups = 0;

/**
 * The text of the value `text` evaluates to in `tab`'s page: JSON for an object, the value itself otherwise.
 * @param {{ send: (method: string, params: object) => Promise<any> }} tab
 * @param {unknown} text
 * @returns {Promise<string>}
 */
async function execIn(tab, text) {
  const objectGroup = `mopilot-exec-${++groups}`;
  const failed = (/** @type {any} */ r) =>
    new ToolError(`JavaScript error: ${oneLine(r.exceptionDetails.exception?.description || r.exceptionDetails.text, 2000)}`, 'js_error');
  try {
    let r = await tab.send('Runtime.evaluate', {
      expression: String(text),
      replMode: true,
      returnByValue: false,
      objectGroup,
      userGesture: true,
      timeout: 30_000,
    });
    if (r?.exceptionDetails) throw failed(r);
    if (r?.result?.subtype === 'promise' && r.result.objectId) {
      r = await tab.send('Runtime.awaitPromise', { promiseObjectId: r.result.objectId, returnByValue: true });
      if (r?.exceptionDetails) throw failed(r);
    } else if (r?.result?.objectId) {
      // an object (or array): its value, not the handle
      r = await tab.send('Runtime.callFunctionOn', {
        objectId: r.result.objectId,
        functionDeclaration: 'function () { return this; }',
        returnByValue: true,
      });
      if (r?.exceptionDetails) throw failed(r);
    }
    const res = r?.result || {};
    if (res.type === 'undefined') return 'undefined';
    if ('value' in res) return typeof res.value === 'string' ? res.value : (JSON.stringify(res.value, null, 2) ?? String(res.value));
    return res.unserializableValue || res.description || res.type || '';
  } finally {
    // the handles of this call's result: nothing else reads them
    await tab
      .send('Runtime.releaseObjectGroup', { objectGroup })
      .catch((/** @type {unknown} */ error) => noteIgnored('release the objects a JavaScript call returned', error));
  }
}

/**
 * The value of `text` in `tab`'s page, where V8 itself refuses anything with a side effect (Runtime.evaluate's
 * throwOnSideEffect: a click, an assignment, a form submit, fetch, a call into the page's own functions). Reads DOM text and
 * attributes as usual. Not REPL mode and no user gesture: this is a look, and an async function counts as a side effect.
 * @param {{ send: (method: string, params: object) => Promise<any> }} tab
 * @param {unknown} text
 * @returns {Promise<string>}
 */
async function peekIn(tab, text) {
  const r = await tab.send('Runtime.evaluate', { expression: String(text), throwOnSideEffect: true, returnByValue: true, timeout: 30_000 });
  if (r?.exceptionDetails) {
    const why = oneLine(r.exceptionDetails.exception?.description || r.exceptionDetails.text, 2000);
    throw new ToolError(`A replay only reads, and this JavaScript would change the page: ${why}`, 'look_only');
  }
  return String(r?.result?.value);
}

module.exports = { execIn, peekIn };
