// The text a page hides from people (G3, #3571): off screen, zero size, aria-hidden, transparent, tiny or the same color
// as its background. The prompt-injection screen (contract/untrustedScreen.cjs) judges a span holding such text with a
// lower bar, since a person reading the page never sees it but an agent reading its text does.
//
// hiddenTextIn is serialized with Function.prototype.toString and evaluated in the page's top frame, so it must not close
// over anything.
const { noteIgnored } = require('../../ignored.cjs');
const { withTimeout } = require('../../platform/timeout.cjs');

/** How long a call waits for the page to say what it hides: a page that is busy or stuck never slows the call more. */
const HIDDEN_MS = 1500;

/** The tools whose result is the page's text: their tab is checked even when no action touched it. */
const READS = new Set(['browser_read_page', 'browser_get_page_text', 'browser_find']);

/* eslint-disable no-restricted-globals */
/**
 * The page's hidden strings (whitespace collapsed, 12+ characters, at most 40 of 300 characters), in document order: not a
 * closed menu's options, and not a string the page also shows.
 * @param {Window} win
 * @returns {string[]}
 */
function hiddenTextIn(win) {
  const doc = win.document;
  const root = doc.documentElement;
  const width = Math.max(root.scrollWidth, win.innerWidth);
  const height = Math.max(root.scrollHeight, win.innerHeight);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const rgb = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(String(c));
    const p = m
      ? m[1]
          .split(/[\s,/]+/)
          .filter(Boolean)
          .map(Number)
      : [];
    return p.length < 3 || p[3] === 0 ? null : p.slice(0, 3);
  };
  /** The color behind an element: the nearest ancestor's opaque background, else the page's white. */
  const behind = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const c = rgb(win.getComputedStyle(e).backgroundColor);
      if (c) return c;
    }
    return [255, 255, 255];
  };
  const lum = (p) => {
    const f = (v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]);
  };
  const hidden = (el) => {
    if (el.closest('[aria-hidden="true"]')) return true;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return true;
    const s = win.getComputedStyle(el);
    if (parseFloat(s.fontSize) < 2) return true;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return true;
    const x = r.left + win.scrollX;
    const y = r.top + win.scrollY;
    if (x + r.width < 0 || y + r.height < 0 || x > width || y > height) return true;
    const fg = rgb(s.color);
    if (!fg) return false;
    const [a, b] = [lum(fg), lum(behind(el))];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) < 1.2;
  };
  const clean = (v) => String(v).replace(/\s+/g, ' ').trim();
  const out = new Set();
  const add = (v) => {
    if (v.length >= 12) out.add(v.slice(0, 300));
  };
  /** The text people can see: a string that is also here is not what the page hides (a closed menu's options repeat the visible values). */
  const shown = new Set();
  const scope = doc.body || root;
  /** An element's text when it is short enough to be one thought, else null; reads a bounded part of it, however big it is. */
  const shortText = (e) => {
    const inner = doc.createTreeWalker(e, 4);
    let joined = '';
    let nodes = 0;
    for (let t = inner.nextNode(); t && joined.length <= 600 && ++nodes <= 64; t = inner.nextNode())
      if (!SKIP.has(/** @type {any} */ (t.parentElement).tagName)) joined += ` ${t.nodeValue}`;
    return joined.length > 600 || nodes > 64 || clean(joined).length > 300 ? null : clean(joined);
  };
  /** Parents a climb stopped at: the next node under them need not read them again. */
  const stops = new Set();
  const walk = doc.createTreeWalker(scope, 4);
  for (let t = walk.nextNode(), n = 0; t && n < 4000 && out.size < 40; t = walk.nextNode(), n++) {
    const el = /** @type {any} */ (t.parentElement); // a text node under the scope has one
    const text = clean(t.nodeValue);
    if (!text || SKIP.has(el.tagName)) continue;
    // A closed menu's options have no box of their own: the control's concealment decides, or the option's own hiding.
    // A datalist is display:none by design, so what surrounds it decides.
    const box = el.closest('datalist')?.parentElement ?? el.closest('select') ?? el;
    const menu = box !== el;
    const concealed =
      hidden(box) ||
      (menu &&
        [el, el.closest('optgroup')].some(
          (o) => o && (o.hidden || o.getAttribute('aria-hidden') === 'true' || win.getComputedStyle(o).display === 'none'),
        ));
    if (!concealed) {
      shown.add(text.slice(0, 300));
      continue;
    }
    add(text);
    if (menu) continue;
    // An order to an address, split across text nodes of one concealed block, is one order: report the block too, whatever
    // each node's length. Without an address a merged block is only a list of labels (a hidden menu).
    let top = el;
    let block = text;
    while (top !== scope && !stops.has(top.parentElement)) {
      const up = top.parentElement;
      const whole = shortText(up);
      if (whole === null || !hidden(up)) {
        stops.add(up);
        break;
      }
      top = up;
      block = whole;
    }
    if (/@|:\/\//.test(block)) add(block);
  }
  return [...out].filter((v) => !shown.has(v)).slice(0, 40);
}
/* eslint-enable no-restricted-globals */

const HIDDEN_TEXT_SOURCE = `(${hiddenTextIn.toString()})(window)`;

/**
 * The hidden strings of a tab's page (the browser host's hiddenText, hostPage.cjs), or null when its answer isn't a list.
 * @param {{ send: (method: string, params: any) => Promise<any> }} tab
 */
async function readHidden(tab) {
  const r = await tab.send('Runtime.evaluate', { expression: HIDDEN_TEXT_SOURCE, returnByValue: true, timeout: HIDDEN_MS });
  const list = r?.result?.value;
  return Array.isArray(list) ? list.filter((s) => typeof s === 'string') : null;
}

/**
 * The page's hidden strings for one call's screen: the tab its action touched, else the tab a read named (or the current
 * one). Null when there was no page to check or it could not be read: the screen then judges by the text alone.
 * @param {{ tabs: any, name: string, args: any, ctx: any, tabArg: (args: any) => any }} o
 * @returns {Promise<string[] | null>}
 */
async function screenHidden({ tabs, name, args, ctx, tabArg }) {
  try {
    const tab = ctx.touched ?? (READS.has(name) ? await tabs.resolve(ctx.chatId, tabArg(args)) : null);
    // no page, or a host that can't read one for it: judged by the text alone
    if (!tab || typeof tabs.hiddenText !== 'function') return null;
    return await withTimeout(Promise.resolve(tabs.hiddenText(tab)), HIDDEN_MS, 'the page did not say what it hides in time', {
      unref: true,
    });
  } catch (error) {
    noteIgnored('read the text a page hides, for the injection screen', error);
    return null;
  }
}

/**
 * Leaves the call's hidden strings on the handler's context for the Registry's screen (`screen.hidden`); leaves the
 * context as it was when there are none to give.
 * @param {{ screen?: { hidden: string[] } }} handlerCtx @param {Parameters<typeof screenHidden>[0]} o
 */
async function noteHidden(handlerCtx, o) {
  const hidden = await screenHidden(o);
  if (hidden) handlerCtx.screen = { hidden };
}

module.exports = { hiddenTextIn, screenHidden, noteHidden, readHidden, HIDDEN_TEXT_SOURCE, HIDDEN_MS, READS };
