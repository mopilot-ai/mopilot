// Browser tool argument normalization, result labels, memory views and abortable waits.
const path = require('node:path');
const { agentView } = require('./pageUrl.cjs');
const { redactUrl, oneLine } = require('./host.cjs');

/** How a result names a press held down for `ms` (nothing for an ordinary press). */
const heldFor = (ms) => (ms ? ` (held ${ms / 1000} s)` : '');

/** @returns {Promise<void>} */
const sleep = (ms, signal) =>
  new Promise((resolve) => {
    // a turn already stopped doesn't wait
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/** A stored page as the model may see it: the address (credential-like query values hidden; a high-risk site's host only), and a title unless the site is high-risk. Null for a blocked address. */
function memoryPage(url, title) {
  const v = agentView(url);
  if (!v) return null;
  return v.risk ? { url: v.url, risk: v.risk, title: '' } : { url: redactUrl(v.url), title: oneLine(title, 200) };
}

const tabArg = (args) => args.tabId ?? args.tab_id ?? null;

/** Where a tab is, as a tool's result ends. */
const tabStatus = (tab) =>
  `Tab ${tab.id} is at ${oneLine(tab.url, 300) || 'about:blank'}${tab.title ? ` (${oneLine(tab.title, 120)})` : ''}.`;

/** The point an action names: coordinate/ref, or the public toolset's {target: {type, x, y | ref}}. */
function targetOf(args) {
  const t = args.target;
  if (t && typeof t === 'object') {
    if (t.type === 'ref' || typeof t.ref === 'string') return { ref: t.ref };
    if (Number.isFinite(t.x) && Number.isFinite(t.y)) return { coordinate: [t.x, t.y] };
  }
  return { coordinate: args.coordinate, ref: args.ref };
}

const isInside = (child, root) => {
  const rel = path.relative(root, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** A tool's return value (a string, or content items) as content items. */
const asContent = (out) => [].concat(out).map((c) => (typeof c === 'string' ? { type: 'text', text: c } : c));

module.exports = { heldFor, sleep, memoryPage, tabArg, tabStatus, targetOf, isInside, asContent };
