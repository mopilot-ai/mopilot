// What the Codex Browser plugin reads through the iab backend can taint the turn (G3, #3571). The plugin's CDP results go
// back to its own code in the Codex thread, never through the Registry, so they can't be marked or noted for the model
// (that would change values the plugin parses). Their text is screened all the same and recorded in the Registry's taint
// ledger by the tab's origin: the turn's sends, deletes and submits then ask on MoPilot's card, quoting it.
const { noteIgnored } = require('../../../ignored.cjs');
const { prefixUnits } = require('../../../../shared/textPrefix.mjs');

/** The most text one result is screened for. */
const MAX_TEXT = 200_000;

/** The text a read's result carries: a script's value, a document's HTML (tags dropped), the accessibility tree's names and values. */
function textOf(method, result) {
  if (!result || typeof result !== 'object') return '';
  if (method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn') {
    const v = result.result?.value;
    return typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
  }
  if (method === 'DOM.getOuterHTML') return String(result.outerHTML ?? '').replace(/<[^>]*>/g, '\n');
  if (method.startsWith('Accessibility.') && Array.isArray(result.nodes))
    return result.nodes
      .map((n) => [n?.name?.value, n?.value?.value].filter((s) => typeof s === 'string' && s).join(' '))
      .filter(Boolean)
      .join('\n');
  return '';
}

/** A URL's origin, or '' when it has none. @param {string} url */
const originOf = (url) => {
  const o = URL.canParse(String(url)) ? new URL(String(url)).origin : 'null';
  return o === 'null' ? '' : o;
};

/**
 * Screens one CDP read's result for the turn's taint. Never throws and never changes the result (the ledger's screenRead
 * taints the turn as not screened when its detector fails).
 * @param {{ screenRead: (chatId: string, read: { origin: string, text: string }) => void } | null | undefined} ledger
 * @param {string} chatId @param {string} url the page the command read @param {string} method @param {any} result
 */
function screenRead(ledger, chatId, url, method, result) {
  if (!ledger) return;
  const text = prefixUnits(textOf(method, result), MAX_TEXT);
  if (!text.trim()) return;
  try {
    ledger.screenRead(chatId, { origin: originOf(url) || 'unknown', text });
  } catch (error) {
    // the plugin's read still reaches it: a ledger that fails only loses this read's taint
    noteIgnored("record the Codex Browser plugin's read in the taint ledger", error);
  }
}

module.exports = { screenRead, textOf, MAX_TEXT };
