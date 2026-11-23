// What a browser_script may do in a routine's replay (#3571, G4; ctx.lookOnly, which only main can set): open and read pages,
// on the sites the routine recorded. Anything else is refused at run time, and page JavaScript runs with V8 itself refusing
// side effects (pageExec.cjs peekIn). V8 doesn't stop reads, so a script whose code touches cookies, storage or credentials
// doesn't run at all (touchesSecrets). That check reads code, so it can't catch everything (a site's own global, say): it
// refuses what looks like a way around it, and what it misses is limited by the origin check and the taint screen on the result.
const { ToolError } = require('../contract/registry.cjs');
const { oneLine } = require('./hostUtil.cjs');

/** The operations a replayed script may call: anything not named here is refused. Reload, back and forward can send a form again, and listing tabs reaches other sites'. */
const LOOK_OPS = new Set([
  'sleep',
  'tab.resolve',
  'tabs.new',
  'tab.goto',
  'tab.title',
  'tab.url',
  'tab.waitForLoadState',
  'tab.domSnapshot',
  'tab.evaluate',
  'loc.read',
  'loc.waitFor',
]);

/** Code that reaches for a secret, or that hides what it reaches for: a replay doesn't run it. */
const SECRETS =
  /cookie|localStorage|sessionStorage|indexedDB|\bcaches\b|credential|passw|\bpwd\b|secret|token|authorization|api.?key|\.value\b|inputValue|getAttribute\(\s*['"`]value|toHaveValue|innerHTML|outerHTML|defaultValue|\.attributes\b|FormData|\.forms\b|\bdataset\b|__[A-Za-z_]+__|csrf/i;
const HIDING =
  /\beval\b|\bFunction\b|\bimport\s*\(|\batob\b|fromCharCode|\\[ux][0-9a-fA-F{]|\bwith\s*\(|(?:window|document|globalThis|self|top|parent|frames)\s*\[|\bReflect\.|(?:\)|\bthis)\s*\[|\(\s*(?:window|document|globalThis|self)\s*\)|=\s*(?:window|document|globalThis|self)\s*[;,\n]/;

/**
 * Page JavaScript in a replayed script, checked as it is about to run, however the script built it. A script's own code has no
 * page to reach; this does. So a name a page keeps a secret under, a key worked out at run time, or a way to reach an object or
 * getter sideways is refused here, where ordinary script code (`out["a" + id] = ...`) isn't in the way.
 */
const PAGE_REACH =
  /[\w$)\]]\s*\[\s*(?!\d+\s*\])|\{\s*\[|\.\s*(?:defaultView|ownerDocument|getRootNode|constructor|prototype|__proto__)\b|\b(?:Proxy|Reflect|getOwnPropertyDescriptors?|getOwnPropertyNames|getPrototypeOf|__lookupGetter__|Document|HTMLDocument|Object\s*\.\s*(?:entries|values|keys|assign))\b/;

/**
 * Whether a recorded script should not replay because of what its code touches. Fails closed on code it can't read plainly;
 * not a proof of anything when it says no.
 * @param {unknown} code
 */
const touchesSecrets = (code) => typeof code !== 'string' || SECRETS.test(code) || HIDING.test(code);

/** The origin of an address, or null when it has none. @param {unknown} url */
function originOf(url) {
  try {
    const { origin } = new URL(String(url));
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** Whether an address is on a site the routine recorded. @param {{ lookOnly?: any }} ctx @param {unknown} url */
const onRecordedSite = (ctx, url) => {
  const origin = originOf(url);
  return !!origin && !!ctx.lookOnly?.origins?.includes(origin);
};

/** Refuses, and remembers it: a script can catch the refusal, and must not pass for a clean read (lookRefusal). */
function refuse(/** @type {{ lookRefused?: string }} */ ctx, /** @type {string} */ message) {
  ctx.lookRefused = message;
  throw new ToolError(message, 'look_only');
}

/**
 * Refuses an operation a replayed script may not make: one not listed, opening another site, or reading a field's value.
 * @param {{ lookOnly?: any, lookRefused?: string }} ctx @param {string} op @param {any} [args]
 */
function checkLookOnly(ctx, op, args) {
  if (!ctx.lookOnly) return;
  if (!LOOK_OPS.has(op)) refuse(ctx, `A replay only reads, so it stopped before ${oneLine(op, 60)}.`);
  if ((op === 'tab.goto' || (op === 'tabs.new' && args?.url != null)) && !onRecordedSite(ctx, args?.url))
    refuse(ctx, `A replay stays on the sites it recorded, so it stopped before ${oneLine(args?.url, 120)}.`);
  if (
    op === 'loc.read' &&
    (args?.what === 'value' || args?.what === 'innerHTML' || (args?.what === 'attr' && /value/i.test(String(args?.name))))
  )
    refuse(ctx, "A replay doesn't read a field's value or a page's markup.");
}

/**
 * The tab a replayed script is about to read, once it's on a site the routine recorded: a redirect or a changed page stops it.
 * @template {{ url?: string }} T
 * @param {{ lookOnly?: any, lookRefused?: string }} ctx @param {T} tab
 * @returns {T}
 */
function lookTab(ctx, tab) {
  if (ctx.lookOnly && !onRecordedSite(ctx, tab.url))
    refuse(ctx, `A replay stays on the sites it recorded, and this tab is on ${oneLine(tab.url, 120)}.`);
  return tab;
}

/**
 * A page expression's value in a replayed script, with side effects refused. So it is a read: the caller asks for the read
 * gate and no card, since no card should say it can't be undone.
 * @param {{ lookRefused?: string }} ctx @param {any} tabs @param {any} tab @param {string} expression
 */
async function peekValue(ctx, tabs, tab, expression) {
  if (touchesSecrets(expression) || PAGE_REACH.test(expression))
    refuse(ctx, "A replay doesn't run page JavaScript that reaches for what a page keeps out of its text.");
  try {
    const seen = await tabs.peek(tab, `JSON.stringify({ v: (${expression}\n) })`);
    return seen === 'undefined' ? null : (JSON.parse(seen).v ?? null);
  } catch (error) {
    ctx.lookRefused = /** @type {Error} */ (error).message;
    throw error;
  }
}

/** A script that ran on after a refusal it caught still counts as refused. @param {{ lookRefused?: string }} ctx */
function lookRefusal(ctx) {
  if (ctx.lookRefused) throw new ToolError(ctx.lookRefused, 'look_only');
}

module.exports = { LOOK_OPS, checkLookOnly, lookTab, peekValue, lookRefusal, touchesSecrets, originOf };
