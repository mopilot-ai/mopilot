// Closed shadow roots and re-rendered refs for the page agent (#3571, G9): the roots main hands over through CDP, and a
// ref re-bound to the one element that replaced its own with the same tag, role and name.
//
// A page script cannot see a closed shadow root, but CDP can (DOM.describeNode with pierce). The agent notes custom
// elements it walks past without a root it knows; main then asks for them (closedHosts), finds each one's closed root
// and hands it back (adopt), and runs the read again. Each host is asked about once.
//
// shadowKit is serialized with Function.prototype.toString into the page agent (pageAgent.cjs), so it must not close
// over anything.

/* eslint-disable no-restricted-globals */
function shadowKit() {
  /** @type {WeakMap<Element, ShadowRoot>} closed roots main handed over, by host */
  const adopted = new WeakMap();
  /** @type {WeakSet<Element>} hosts main was already asked about */
  const probed = new WeakSet();
  let pending = false;

  /** Whether a custom element is upgraded: its constructor, which attaches a closed root, has run. */
  const defined = (el) => {
    try {
      return el.matches(':defined');
    } catch {
      return true; // no :defined support: take it as upgraded
    }
  };
  /** An upgraded custom element (a name with a hyphen) whose shadow root, if any, this world can't see yet. */
  const unknown = (el) => el.localName.includes('-') && !el.shadowRoot && !adopted.has(el) && !probed.has(el) && defined(el);

  /** An element's shadow root: its open one, or a closed one main handed over. Notes a host main may know more about. */
  function shadowOf(el) {
    if (!el || el.nodeType !== 1) return null;
    const root = el.shadowRoot || adopted.get(el) || null;
    if (!root && unknown(el)) pending = true;
    return root;
  }

  /** A frame's document, or null for a cross-origin one (main reads that in its own world). */
  function frameDocument(el) {
    try {
      return el.contentDocument;
    } catch (e) {
      if (e && e.name === 'SecurityError') return null;
      throw e;
    }
  }

  /**
   * The elements under `root`, through every shadow root this world can see (closed ones once adopted), and with
   * `frames` through same-origin frames too.
   */
  function deep(root, frames = false) {
    const out = [];
    const visit = (r) => {
      for (const el of r.querySelectorAll('*')) {
        out.push(el);
        const sr = shadowOf(el);
        if (sr) visit(sr);
        if (!frames || (el.localName !== 'iframe' && el.localName !== 'frame')) continue;
        const doc = frameDocument(el);
        if (doc) visit(doc);
      }
    };
    visit(root);
    return out;
  }

  return {
    shadowOf,
    deep,
    /** Whether the last op walked past a host main may know a closed root of; reading it clears it. */
    takePending() {
      const p = pending;
      pending = false;
      return p;
    },
    /** Up to `limit` hosts main has not been asked about, marked asked. */
    closedHosts(limit = 200) {
      const hosts = [];
      for (const el of deep(document, true)) {
        if (hosts.length >= limit) break;
        if (!unknown(el)) continue;
        probed.add(el);
        hosts.push(el);
      }
      pending = false;
      return hosts;
    },
    /** Main hands over a host's closed root; refused unless the root is that host's own. */
    adopt(host, root) {
      if (!host || !root || root.host !== host || host.shadowRoot) return false;
      adopted.set(host, root);
      return true;
    },
    /**
     * The one connected element that replaced a ref's element: same tag, and `same` (role and name) holds for it and
     * for no other element in the ref's document. Null when there is none or more than one, so a re-render never
     * moves a ref to a different control.
     * @param {{ tag?: string, doc?: WeakRef<Document>, role: string, name: string }} meta
     * @param {(el: Element) => boolean} same
     */
    rebind(meta, same) {
      const doc = meta.doc && meta.doc.deref();
      if (!doc || !meta.tag || !meta.name || meta.role === 'generic') return null;
      let found = null;
      for (const el of deep(doc)) {
        if (el.localName !== meta.tag || !el.isConnected || !same(el)) continue;
        if (found) return null;
        found = el;
      }
      return found;
    },
  };
}

module.exports = { shadowKit };
