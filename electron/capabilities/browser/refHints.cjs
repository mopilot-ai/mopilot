// What a tab's refs named (role, name, tag, page) so a page that replaced its document does not strand them (#3571).
//
// A reload (a form post that redirects back) drops the page agent's own ref table. Each call reports the refs it minted;
// the next call that names one hands back what it stood for, and the agent re-resolves it to the one element with that
// tag, role and name on the same page, never to a different one (pageAgent.cjs adopt).

const MAX_REFS = 20000;

class RefHints {
  constructor() {
    /** ref -> [role, name, tag, url, place] */
    this.meta = new Map();
  }

  /** Remembers the refs a page-agent result minted, and the page they were minted on. */
  note(out, place) {
    if (!Array.isArray(out?.minted)) return;
    for (const [ref, role, name, tag] of out.minted) {
      this.meta.delete(ref);
      this.meta.set(ref, [role, name, tag, out.url, place]);
    }
    while (this.meta.size > MAX_REFS) this.meta.delete(this.meta.keys().next().value);
  }

  /** The `hints` argument of an agent call (", {…}"): what the refs named in `args` stood for in this place, or ''. */
  arg(args, place) {
    const hints = {};
    let any = false;
    for (const ref of new Set(JSON.stringify(args).match(/ref_\d+/g) || [])) {
      const m = this.meta.get(ref);
      if (!m || m[4] !== place) continue;
      hints[ref] = m.slice(0, 4);
      any = true;
    }
    return any ? `, ${JSON.stringify(hints)}` : '';
  }
}

module.exports = { RefHints };
