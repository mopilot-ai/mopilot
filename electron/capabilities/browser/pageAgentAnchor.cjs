// Semantic anchors for action memory (#3571, G4): the element a step acted on, as locator steps the page agent's query
// op resolves again on a later run (role and name, the container that tells twins apart, the same-process frames it is
// in), never as a ref, which means nothing on another page load.
//
// anchorKit is serialized with Function.prototype.toString into the page agent (pageAgent.cjs), so it must not close
// over anything: the page agent hands it the helpers it needs.

/* eslint-disable no-restricted-globals */
/**
 * @param {{ roleOf: (el: Element, style?: any) => string, styleOf: (el: Element) => any, nameOf: (el: Element, role: string) => string,
 *           clean: (s: unknown) => string, run: (steps: any[], roots: any[], scope: { doc: Document }) => Element[],
 *           deref: (ref: string) => Element | null, atPoint: (x: number, y: number) => any, frameOf: (view: Window | null) => Element | null,
 *           isSecret: (el: Element) => boolean }} h
 */
function anchorKit(h) {
  /** Roles whose name or text tells apart two controls of the same role and name (a row's "Delete"). */
  const CONTAINERS = new Set(['row', 'listitem', 'article', 'region', 'form', 'dialog', 'group', 'cell', 'navigation', 'complementary']);
  const TEXT_MAX = 80;

  /** Whether `steps`, run in `doc`, match `el` alone. */
  const only = (steps, doc, el) => {
    const found = h.run(steps, [doc], { doc });
    return found.length === 1 && found[0] === el;
  };

  /** The element's own step: its role and exact name, or its exact text when it has no role. Null when neither says anything. */
  function own(el) {
    const role = h.roleOf(el, h.styleOf(el));
    if (role) {
      const name = h.nameOf(el, role).slice(0, 150);
      return name ? { k: 'role', role, name: { s: name, exact: true } } : { k: 'role', role };
    }
    const text = h.clean(el.textContent).slice(0, TEXT_MAX);
    return text ? { k: 'text', m: { s: text, exact: true } } : null;
  }

  /** The closest container of a kind that names a part of the page, crossing open and adopted shadow roots. */
  function* containers(el) {
    // a shadow root (11) has no role of its own: its host is next
    for (let n = el.parentNode; n && n.nodeType !== 9; n = n.parentNode || n.host) {
      if (n.nodeType === 11) continue;
      const role = h.roleOf(n, h.styleOf(n));
      if (CONTAINERS.has(role)) yield { n, role };
    }
  }

  /** The step for a container: its role and name, else its role and the start of its text. */
  function containerStep({ n, role }) {
    const name = h.clean(h.nameOf(n, role)).slice(0, 150);
    if (name) return [{ k: 'role', role, name: { s: name, exact: true } }];
    const text = h.clean(n.textContent).slice(0, TEXT_MAX);
    return text
      ? [
          { k: 'role', role },
          { k: 'filter', hasText: { s: text } },
        ]
      : null;
  }

  /**
   * The steps that find `el` in its own document: its own step when that matches it alone, else under the closest
   * container that makes it unique, else its index among its twins (weak: a reordered list moves it).
   */
  function within(el) {
    const base = own(el);
    if (!base) return null;
    const doc = el.ownerDocument;
    if (only([base], doc, el)) return { steps: [base], weak: false };
    for (const c of containers(el)) {
      const lead = containerStep(c);
      if (lead && only([...lead, base], doc, el)) return { steps: [...lead, base], weak: false };
    }
    const twins = h.run([base], [doc], { doc });
    const i = twins.indexOf(el);
    return i < 0 ? null : { steps: [base, { k: 'nth', i }], weak: true };
  }

  /** The steps from this world's top document: the frames it is in (same process), each entered with a frame step. */
  function chain(el) {
    const part = within(el);
    if (!part) return null;
    if (el.ownerDocument === document) return part;
    // a document this world reached has a readable frame element up to the top
    const fe = h.frameOf(el.ownerDocument.defaultView);
    const up = fe && chain(fe);
    // the frame element's steps, then a step into it, then what is inside
    return up ? { steps: [...up.steps, { k: 'frame' }, ...part.steps], weak: up.weak || part.weak } : null;
  }

  /**
   * The anchor of a ref, or of the control at a top-frame point: { steps, weak, secret } (secret: a password field,
   * whose value is never kept), { frame: true } for a point inside a cross-origin frame (main can't anchor it), or null.
   * @param {{ ref?: string, x?: number, y?: number }} [o]
   */
  function anchor({ ref, x, y } = {}) {
    let el = ref ? h.deref(ref) : typeof x === 'number' ? h.atPoint(x, Number(y)) : null;
    if (el && !el.nodeType && el.frame) return { frame: true };
    if (!el || el.nodeType !== 1) return null;
    if (!ref) {
      el = el.closest('button, a[href], input, select, textarea, [role="button"], [role="link"], [role="menuitem"], label') || el;
      if (el.localName === 'label' && el.control) el = el.control;
    }
    const found = chain(el);
    return found ? { ...found, secret: h.isSecret(el) } : null;
  }

  return { anchor };
}

module.exports = { anchorKit };
