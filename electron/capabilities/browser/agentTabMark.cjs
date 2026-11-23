// Favicon marks on the agent's tabs in the user's Chrome, as ChatGPT's extension draws them: the tab's own icon dimmed under the agent's pointer while it works there, a yellow dot while the chat waits for the user's OK, and at the turn's end a green dot on a tab left for the user to look at (deliverable) or a yellow one on a tab handed to them, until they see it.
//
// - "Seen" is the tab coming into view, or the user's own click, key or wheel on it while in view. The page can't tell at the
//   turn's end whether it is in view: while the agent holds a tab, Chrome's input emulation makes a background page read
//   visible and focused (measured in the VM), so the mark always goes on and the user's look takes it off.
//
// - Drawn from the cursor's isolated world (agentCursorOverlay.cjs mounts it with the control frame), through the debugger the agent
//   already holds: no new extension permission. The script stays in the page after the turn's debugger lets go, so a turn-end dot
//   clears itself when the tab is seen.
// - An SVG favicon can't load another address, so the tab's icon goes in as a data: URL, fetched as the page would; an icon the
//   page can't read (another origin with no CORS, too large) gives way to a plain tile, and the dot still shows.
// - The page's own icon links come back as they were when the mark goes; one the page changes meanwhile is marked again.
// - Each turn's debugger session makes a new world, so a page can hold an earlier turn's mark script: the new one takes over
//   (a DOM event every world hears), and the earlier one gives the page its icon back and stops, so two never redraw each other.

/* eslint-disable no-restricted-globals */
/** Runs in the cursor world (serialized with toString: it must not close over anything). Returns `{ set(state) }`. */
function tabMark() {
  const G = globalThis;
  if (G.__mopilotMark) return G.__mopilotMark;
  const OURS = 'data-mopilot-mark';
  const ICONS = 'link[rel~="icon"]';
  const MAX_BYTES = 64 * 1024;
  /** the agent cursor's arrow (agentCursorOverlay.cjs), in its 22-unit box */
  const ARROW = 'M3 2 L3 18 L7.5 14 L10.5 20.5 L13.5 19 L10.5 12.8 L16.5 12.8 Z';
  const DOT = { waiting: '#facc15', handoff: '#facc15', deliverable: '#22c55e' };
  /** @type {Map<string, Promise<string | null>>} an icon's address -> its data: URL (null: unreadable) */
  const icons = new Map();
  /** @type {[HTMLLinkElement, string | null][]} the links marked, with the address each had (null: added by the mark) */
  let marked = [];
  /** @type {string | null} */
  let state = null;
  /** bumped by every set: a fetch for an older state draws nothing */
  let turn = 0;
  /** @type {MutationObserver | null} */
  let watch = null;
  /** the marked icon's address, as the links carry it */
  let ours = '';

  const read = (href) => {
    if (href.startsWith('data:')) return Promise.resolve(href.length <= MAX_BYTES * 1.4 ? href : null);
    let p = icons.get(href);
    if (!p) {
      p = fetch(href)
        .then((r) => (r.ok ? r.blob() : null))
        .then((b) =>
          !b || b.size > MAX_BYTES
            ? null
            : new Promise((resolve) => {
                const f = new FileReader();
                f.onload = () => resolve(typeof f.result === 'string' ? f.result : null);
                f.onerror = () => resolve(null);
                f.readAsDataURL(b);
              }),
        )
        .catch((error) => {
          // the mark draws a plain tile instead (another origin with no CORS, offline)
          console.warn("MoPilot couldn't read this tab's icon for its mark:", error);
          return null;
        });
      icons.set(href, p);
    }
    return p;
  };

  const drawn = (icon, s) => {
    const base = icon
      ? `<image href="${icon.replace(/"/g, '%22')}" width="32" height="32"${s === 'active' ? ' opacity="0.3"' : ''}/>`
      : `<rect x="3" y="3" width="26" height="26" rx="7" fill="#9aa0a6"${s === 'active' ? ' opacity="0.3"' : ''}/>`;
    const mark =
      s === 'active'
        ? `<path d="${ARROW}" transform="translate(3 2) scale(1.3)" fill="#2f6fed" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>`
        : `<circle cx="24" cy="24" r="7" fill="${DOT[s]}" stroke="#fff" stroke-width="1.5"/>`;
    return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" ${OURS}="1" width="32" height="32" viewBox="0 0 32 32">${base}${mark}</svg>`)}`;
  };

  const quiet = (fn) => {
    watch?.disconnect();
    fn();
    if (watch && state)
      watch.observe(document.head || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['href', 'rel'],
      });
  };

  const restore = () =>
    quiet(() => {
      for (const [link, href] of marked) {
        link.removeAttribute(OURS);
        if (href === null) link.remove();
        else link.setAttribute('href', href);
      }
      marked = [];
    });

  const apply = async (s, mine) => {
    restore();
    const links = /** @type {HTMLLinkElement[]} */ ([...document.querySelectorAll(ICONS)]);
    const href = links.find((l) => l.href)?.href || `${location.origin}/favicon.ico`;
    const icon = await read(href);
    if (mine !== turn) return;
    const url = drawn(icon, s);
    ours = url;
    quiet(() => {
      for (const link of links) {
        marked.push([link, link.getAttribute('href')]);
        link.setAttribute(OURS, '1');
        link.setAttribute('href', url);
      }
      if (!links.length && (document.head || document.documentElement)) {
        const link = document.createElement('link');
        link.rel = 'icon';
        link.setAttribute(OURS, '1');
        link.href = url;
        (document.head || document.documentElement).appendChild(link);
        marked.push([link, null]);
      }
    });
  };

  const api = {
    /** 'active' | 'waiting' | 'deliverable' | 'handoff' | null; a turn-end mark ('deliverable', 'handoff') stays until the tab is seen. */
    set(s) {
      const next = DOT[s] || s === 'active' ? s : null;
      const mine = ++turn;
      state = next;
      if (!next) restore();
      else void apply(next, mine);
      return true;
    },
    get state() {
      return state;
    },
  };
  const TAKEOVER = 'mopilot-mark-takeover';
  const iconish = (n) => n.nodeName === 'LINK' && /(^|\s)icon(\s|$)/i.test(n.getAttribute('rel') || '');
  // the page changed or added an icon while marked: it is marked too; other changes in <head> (styles, scripts) aren't ours
  // (it only listens while marked: restore() disconnects it, which drops records not yet delivered)
  watch = new MutationObserver((records) => {
    if (!records.some((r) => (r.type === 'attributes' ? iconish(r.target) : [...r.addedNodes, ...r.removedNodes].some(iconish)))) return;
    // an icon the page set over the mark is the one to give back
    marked = marked.map(([link, href]) => [link, link.getAttribute('href') === ours ? href : link.getAttribute('href')]);
    void apply(/** @type {string} */ (state), ++turn);
  });
  // a turn-end mark goes once the user sees the tab: it comes into view, or they click, type or scroll in it (the agent no longer acts)
  const seen = (e) => {
    if (e.type !== 'visibilitychange' && !e.isTrusted) return;
    if (document.visibilityState === 'visible' && (state === 'deliverable' || state === 'handoff')) api.set(null);
  };
  for (const type of ['visibilitychange', 'pointerdown', 'keydown', 'wheel']) document.addEventListener(type, seen, true);
  // an earlier turn's script in this page lets go first, then this one listens for the next turn's
  document.dispatchEvent(new CustomEvent(TAKEOVER));
  document.addEventListener(TAKEOVER, () => {
    turn++;
    state = null;
    restore();
  });
  G.__mopilotMark = api;
  return api;
}
/* eslint-enable no-restricted-globals */

/**
 * The mark a tab keeps when the turn ends (hostTabs.cjs turnEnded): the turn's own mark ('deliverable' or 'handoff'), or the hand-off
 * the user still holds; a mark from an earlier turn lapses with it.
 * @param {{ mark?: string | null, markTurn?: number, signin?: unknown }} tab @param {number} ended the turns ended before this one
 */
const finalMark = (tab, ended) => (tab.mark && (tab.signin || tab.markTurn === ended) ? tab.mark : null);

module.exports = { tabMark, finalMark, MARK_SOURCE: `(${tabMark.toString()})` };
