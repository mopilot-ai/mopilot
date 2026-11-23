// The script the browser tools inject into a page. It runs in an isolated world (never the page's own
// JavaScript world), once per frame document, and keeps element refs on the DOM nodes themselves: a
// WeakMap from element to ref and a map from ref to a WeakRef of the element. A ref stays valid while
// its element is connected and keeps its role and name; refs are never renumbered for a tab, because
// the main process passes the tab's ref counter in with every call.
//
// pageAgent is serialized with Function.prototype.toString, so it must not close over anything: its parameters, the bot-check
// test (botCheck.cjs, #1615), the consent test (consent.cjs, #1619), the label joiner (labelText.mjs) and the closed shadow
// roots and ref re-binding (pageAgentShadow.cjs, #3571) and action memory's anchors (pageAgentAnchor.cjs, G4) go beside it.
const { botCheckIn } = require('./botCheck.cjs');
const { consentIn, CONSENT_SOURCE } = require('./consent.cjs');
const { labelText } = require('../../../shared/labelText.mjs');
const { shadowKit } = require('./pageAgentShadow.cjs');
const { anchorKit } = require('./pageAgentAnchor.cjs');

/* eslint-disable no-restricted-globals */
function pageAgent(botCheck = botCheckIn, consent = consentIn, joinLabels = labelText, shadows = shadowKit, anchors = anchorKit) {
  const G = globalThis;
  if (G.__mopilotAgent) return G.__mopilotAgent;
  const kit = shadows();

  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'base']);
  const INTERACTIVE = new Set([
    'button',
    'link',
    'textbox',
    'searchbox',
    'combobox',
    'checkbox',
    'radio',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'listbox',
    'treeitem',
    'clickable',
  ]);
  const FROM_CONTENT = new Set([
    'button',
    'link',
    'heading',
    'option',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'treeitem',
    'cell',
    'columnheader',
    'rowheader',
    'switch',
    'tooltip',
    'clickable',
    'label',
    'legend',
    'caption',
  ]);
  const INPUTS = Object.assign(Object.create(null), {
    button: 'button',
    submit: 'button',
    reset: 'button',
    image: 'button',
    file: 'button',
    color: 'button',
    checkbox: 'checkbox',
    radio: 'radio',
    range: 'slider',
    number: 'spinbutton',
    search: 'searchbox',
  });
  const TAGS = Object.assign(Object.create(null), {
    button: 'button',
    textarea: 'textbox',
    option: 'option',
    nav: 'navigation',
    main: 'main',
    header: 'banner',
    footer: 'contentinfo',
    aside: 'complementary',
    form: 'form',
    search: 'search',
    dialog: 'dialog',
    table: 'table',
    tr: 'row',
    td: 'cell',
    th: 'columnheader',
    ul: 'list',
    ol: 'list',
    menu: 'list',
    li: 'listitem',
    summary: 'button',
    details: 'group',
    fieldset: 'group',
    p: 'paragraph',
    blockquote: 'blockquote',
    hr: 'separator',
    progress: 'progressbar',
    meter: 'meter',
    iframe: 'iframe',
    frame: 'iframe',
    video: 'video',
    audio: 'audio',
    article: 'article',
    figure: 'figure',
    output: 'status',
    legend: 'legend',
    caption: 'caption',
  });

  let next = 0;
  /** refs minted since the last call began: [ref, role, name, tag, element]; main gets the ones that name a unique element (hintRows) */
  let minted = [];
  /** ref -> { el: WeakRef, role, name, tag, doc: WeakRef } */
  const byRef = new Map();
  /** element -> ref */
  const refs = new WeakMap();
  let mutations = 0;
  let lastMutation = Date.now();
  /** inputs that were password fields before the page changed their type (a "show password" toggle) */
  const secrets = new WeakSet();
  /** sign-in fields MoPilot filled: masked like secrets, but not counted as passwords when a form is read */
  const filled = new WeakSet();
  /** @type {string | null} why the page can't be watched for changes (state() tells main, which then doesn't wait for a quiet DOM) */
  let observeError = null;
  try {
    new MutationObserver((list) => {
      mutations += list.length;
      lastMutation = Date.now();
      for (const m of list) if (m.attributeName === 'type' && String(m.oldValue).toLowerCase() === 'password') secrets.add(m.target);
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true });
  } catch (e) {
    observeError = String(e);
  }

  /**
   * A frame element's document, or null when the frame is cross-origin: null is the normal answer there
   * (older engines threw a SecurityError instead). Any other error is a real failure and reaches main.
   * @param {Element} el an iframe or frame
   * @returns {Document | null}
   */
  function frameDoc(el) {
    try {
      return /** @type {HTMLIFrameElement} */ (el).contentDocument;
    } catch (e) {
      if (e && e.name === 'SecurityError') return null;
      throw e;
    }
  }

  /**
   * The frame element a window is shown in; null at the top, for a detached document's null view, and
   * behind a cross-origin parent (null there, or a SecurityError in older engines). Other errors reach main.
   * @param {Window | null} view
   * @returns {Element | null}
   */
  function frameOf(view) {
    if (!view) return null;
    try {
      return view.frameElement;
    } catch (e) {
      if (e && e.name === 'SecurityError') return null;
      throw e;
    }
  }

  const clean = (s) =>
    String(s == null ? '' : s)
      .replace(/\s+/g, ' ')
      .trim();
  const MASK = '••••';
  /**
   * A field whose value never reaches the agent: a password input, one the page turned from a
   * password into text, or one named or marked for a password.
   */
  function isSecret(el) {
    return isPasswordLike(el) || (!!el && el.localName === 'input' && secrets.has(el));
  }
  /** An input meant for a password, by type, autocomplete or name (not merely masked: a sign-in username MoPilot filled is masked too). */
  function isPasswordLike(el) {
    if (!el || el.localName !== 'input') return false;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'password' || /\b(current|new)-password\b/i.test(el.getAttribute('autocomplete') || '')) return true;
    return type === 'text' && /pass(word|wd)|\bpwd\b/i.test(`${el.getAttribute('name') || ''} ${el.id || ''}`);
  }
  /** A field for card or bank account details. */
  function isPayment(el) {
    if (!el || !/^(input|select)$/.test(el.localName)) return false;
    if (/\bcc-(number|csc|exp|exp-month|exp-year)\b/i.test(el.getAttribute('autocomplete') || '')) return true;
    return /card.?num|cc.?num|\bcvv|\bcvc|\bcsc\b|security.?code|\biban\b|routing|account.?num|sort.?code/i.test(
      `${el.getAttribute('name') || ''} ${el.id || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''}`,
    );
  }
  /**
   * A frame that hosts card fields from a payment provider (Stripe, Braintree, Adyen, Checkout.com, Square): its card
   * number lives in another origin, so the form around it holds payment details its own fields don't show.
   */
  function isPaymentFrame(el) {
    return /card.?(num|number|payment|input|field|form)|credit.?card|\bcvc\b|\bcvv\b|security.?code|hosted.?field|privatestripeframe|checkout-frames/i.test(
      `${el.getAttribute('name') || ''} ${el.id || ''} ${el.getAttribute('title') || ''}`,
    );
  }
  /** Whether a provider's card fields sit near a formless button: in one of its closest containers (a checkout panel). */
  function paymentFrameNear(el) {
    let box = el.parentElement;
    for (let i = 0; box && i < 6 && !/^(body|html)$/.test(box.localName); i++, box = box.parentElement)
      if ([...box.querySelectorAll('iframe, frame')].slice(0, 50).some(isPaymentFrame)) return true;
    return false;
  }
  const q = (s, n = 150) => {
    const t = clean(s);
    const cut = t.length > n ? t.slice(0, n - 1).replace(/[\uD800-\uDBFF]$/, '') : t; // a cut says what it left out (clippedText.mjs)
    return (cut === t ? t : `${cut}… [+${t.length - cut.length} chars]`).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  };
  /** An element's own text (its text-node children): what find() names a role-less element by. */
  const ownText = (el) =>
    clean(
      [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.data)
        .join(' '),
    ).slice(0, 150);
  const styleOf = (el) => {
    try {
      return el.ownerDocument.defaultView.getComputedStyle(el);
    } catch {
      return null;
    }
  };

  function roleOf(el, style) {
    const explicit = clean(el.getAttribute('role')).split(' ')[0];
    if (explicit && explicit !== 'none' && explicit !== 'presentation' && explicit !== 'generic') return explicit;
    const tag = el.localName;
    if (tag === 'a' || tag === 'area') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden') return '';
      if (INPUTS[type]) return INPUTS[type];
      return el.hasAttribute('list') ? 'combobox' : 'textbox';
    }
    if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return el.getAttribute('alt') === '' ? '' : 'img';
    if (tag === 'svg') return el.getAttribute('aria-label') || el.querySelector(':scope > title') ? 'img' : '';
    if (tag === 'section') return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : '';
    if (TAGS[tag]) return TAGS[tag];
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'textbox';
    if (el.hasAttribute('onclick')) return 'clickable';
    const tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && Number(tabindex) >= 0) return 'clickable';
    if (style && style.cursor === 'pointer') {
      const parent = el.parentElement && styleOf(el.parentElement);
      if (!parent || parent.cursor !== 'pointer') return 'clickable';
    }
    return '';
  }

  function nameOf(el, role) {
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    const labelledby = clean(el.getAttribute('aria-labelledby'));
    if (labelledby) {
      const doc = el.ownerDocument;
      const t = joinLabels(
        labelledby
          .split(' ')
          .map((id) => doc.getElementById(id))
          .filter(Boolean)
          .map((e) => e.textContent),
      );
      if (t) return t;
    }
    const tag = el.localName;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const labels = el.labels ? joinLabels([...el.labels].map((l) => l.innerText || l.textContent)) : '';
      if (labels) return labels;
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'input' && (type === 'button' || type === 'submit' || type === 'reset'))
        return clean(el.value) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
      if (tag === 'input' && type === 'image') return clean(el.getAttribute('alt') || el.value);
      const placeholder = clean(el.getAttribute('placeholder'));
      if (placeholder) return placeholder;
    }
    if (tag === 'img' || tag === 'area') return clean(el.getAttribute('alt') || el.getAttribute('title'));
    if (tag === 'svg') {
      const t = el.querySelector(':scope > title');
      return clean(t ? t.textContent : '');
    }
    if (tag === 'iframe' || tag === 'frame') return clean(el.getAttribute('title') || el.getAttribute('name'));
    if (tag === 'fieldset') {
      const legend = el.querySelector(':scope > legend');
      if (legend) return clean(legend.textContent);
    }
    if (tag === 'table') {
      const caption = el.querySelector(':scope > caption');
      if (caption) return clean(caption.textContent);
    }
    if (tag === 'figure') {
      const caption = el.querySelector(':scope > figcaption');
      if (caption) return clean(caption.textContent);
    }
    if (FROM_CONTENT.has(role) || role === 'heading') {
      const t = clean(el.innerText !== undefined ? el.innerText : el.textContent);
      if (t) return t;
      const img = el.querySelector('img[alt]');
      if (img) return clean(img.getAttribute('alt'));
    }
    return clean(el.getAttribute('title'));
  }

  function attrsOf(el, role) {
    const out = [];
    const tag = el.localName;
    if (role === 'heading') out.push(`[level=${/^h[1-6]$/.test(tag) ? tag[1] : el.getAttribute('aria-level') || 2}]`);
    if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox' || role === 'menuitemradio') {
      const checked = 'checked' in el ? el.checked : el.getAttribute('aria-checked') === 'true';
      out.push(checked ? '[checked]' : '[unchecked]');
    }
    if (tag === 'input' || tag === 'textarea') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (role === 'textbox' || role === 'searchbox' || role === 'combobox' || role === 'spinbutton' || role === 'slider') {
        if (el.value) out.push(`value="${isSecret(el) ? MASK : q(el.value, 200)}"`);
        if (type && type !== 'text') out.push(`type=${type}`);
      } else if (type === 'file' && el.files?.length) out.push(`files="${q([...el.files].map((f) => f.name).join(', '), 200)}"`);
    } else if (tag === 'select') {
      const chosen = [...el.selectedOptions].map((o) => clean(o.text)).join(', ');
      if (chosen) out.push(`value="${q(chosen, 200)}"`);
    } else if (role === 'textbox' && el.isContentEditable) {
      const t = clean(el.innerText);
      if (t) out.push(`value="${q(t, 200)}"`);
    }
    if (role === 'link') {
      const href = el.getAttribute('href');
      if (href && !href.startsWith('javascript:')) out.push(`href="${q(href, 200)}"`);
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.push('[disabled]');
    const expanded = el.getAttribute('aria-expanded');
    if (expanded === 'true') out.push('[expanded]');
    if (expanded === 'false') out.push('[collapsed]');
    if (el.getAttribute('aria-selected') === 'true' || (tag === 'option' && el.selected)) out.push('[selected]');
    if (el.required) out.push('[required]');
    return out.length ? ` ${out.join(' ')}` : '';
  }

  function refOf(el, role, name) {
    let ref = refs.get(el);
    const meta = ref && byRef.get(ref);
    if (meta && meta.role === role && meta.name === name) return ref;
    // a new element, or one whose role or name changed (its old ref is stale from now on)
    if (ref) byRef.delete(ref);
    ref = `ref_${++next}`;
    refs.set(el, ref);
    byRef.set(ref, { el: new WeakRef(el), role, name, tag: el.localName, doc: new WeakRef(el.ownerDocument) });
    minted.push([ref, role, name, el.localName, el]);
    if (byRef.size > 20000) {
      for (const [k, m] of byRef) {
        if (!m.el.deref()) byRef.delete(k);
        if (byRef.size <= 15000) break;
      }
    }
    return ref;
  }

  /**
   * The element a ref names, or null when it is stale: its role or name changed, or it is gone and no single element of
   * the same tag, role and name replaced it (a re-render); a replacement takes the ref over.
   */
  function deref(ref) {
    const meta = byRef.get(ref);
    let el = meta && meta.el.deref();
    if (meta && (!el || !el.isConnected)) {
      el = kit.rebind(meta, (c) => roleOf(c, styleOf(c)) === meta.role && nameOf(c, meta.role).slice(0, 150) === meta.name);
      if (el) meta.el = new WeakRef(el);
      if (el && !refs.has(el)) refs.set(el, ref);
    }
    if (!el || !el.isConnected) return null;
    const role = roleOf(el, styleOf(el));
    // find() names a role-less element 'generic' by its own text
    if (meta.role === 'generic' && !role) return ownText(el) === meta.name ? el : null;
    if (role !== meta.role || nameOf(el, role).slice(0, 150) !== meta.name) return null;
    return el;
  }

  /** Viewport offset of an element's own document within the top document (same-origin frames only). */
  function frameOffset(doc) {
    let x = 0;
    let y = 0;
    // a cross-origin parent hides its frame element: offsets stop there
    /** @type {Element | null} */
    let fe = frameOf(doc.defaultView);
    while (fe) {
      const r = fe.getBoundingClientRect();
      const cs = styleOf(fe);
      x += r.left + fe.clientLeft + (cs ? parseFloat(cs.paddingLeft) || 0 : 0);
      y += r.top + fe.clientTop + (cs ? parseFloat(cs.paddingTop) || 0 : 0);
      fe = frameOf(fe.ownerDocument.defaultView);
    }
    return { x, y };
  }

  function inViewport(el) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null; // no box of its own (display: contents, empty): decide by its children
    const win = el.ownerDocument.defaultView;
    return r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth;
  }

  function childrenOf(node) {
    if (node.localName === 'slot' && typeof node.assignedNodes === 'function') {
      const assigned = node.assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
    return (kit.shadowOf(node) || node).childNodes;
  }

  /**
   * The tree as lines. mode: 'visible' (in the viewport), 'interactive' (visible and interactive),
   * 'all' (also outside the viewport). Cross-origin frames become placeholders the main process fills.
   */
  function tree({ filter = 'visible', depth = 15, ref = null, maxChars = 50000 } = {}) {
    const lines = [];
    const frames = [];
    let size = 0;
    let truncated = false;
    const interactiveOnly = filter === 'interactive';
    const viewportOnly = filter !== 'all';
    const emit = (d, text) => {
      if (truncated) return;
      const line = `${'  '.repeat(interactiveOnly ? 0 : d)}- ${text}`;
      if (size + line.length + 1 > maxChars) {
        truncated = true;
        return;
      }
      size += line.length + 1;
      lines.push(line);
    };
    const ctx = { buf: '', mute: 0 };
    const flush = (d) => {
      const t = clean(ctx.buf);
      ctx.buf = '';
      if (t && !ctx.mute && !interactiveOnly) emit(d, `text "${q(t, 300)}"`);
    };

    function element(el, role, style, d) {
      const full = nameOf(el, role);
      const name = full.slice(0, 150);
      const r = refOf(el, role, name);
      const visible = !viewportOnly || inViewport(el) !== false;
      if (visible && (!interactiveOnly || INTERACTIVE.has(role)))
        emit(d, `${role}${name ? ` "${q(full)}"` : ''}${attrsOf(el, role)} [${r}]`);
      if (d + 1 >= depth) return;
      if (role === 'iframe') {
        // a cross-origin frame is not readable here: it is listed for main to read in its own process
        const doc = frameDoc(el);
        if (doc && doc.documentElement) walk(doc.documentElement, d + 1);
        else {
          frames.push(r);
          if (!truncated) lines.push(`\u0001FRAME ${r} ${interactiveOnly ? 0 : d + 1}\u0001`);
        }
        return;
      }
      const muted = FROM_CONTENT.has(role) && !!name;
      if (muted) ctx.mute++;
      walk(el, d + 1);
      flush(d + 1);
      if (muted) ctx.mute--;
    }

    function walk(parent, d) {
      for (const child of childrenOf(parent)) {
        if (truncated) return;
        if (child.nodeType === 3) {
          ctx.buf += child.data;
          continue;
        }
        if (child.nodeType !== 1) continue;
        const el = child;
        if (SKIP.has(el.localName)) continue;
        if (el.localName === 'br') {
          ctx.buf += ' ';
          continue;
        }
        if (el.getAttribute('aria-hidden') === 'true' || el.hidden) continue;
        const style = styleOf(el);
        if (style && style.display === 'none') continue;
        if (
          viewportOnly &&
          style &&
          style.position !== 'fixed' &&
          style.position !== 'sticky' &&
          inViewport(el) === false &&
          el.localName !== 'body' &&
          el.localName !== 'html'
        ) {
          // off-screen: nothing of it is visible (absolutely positioned children may be, rarely)
          continue;
        }
        const shown = !style || (style.visibility !== 'hidden' && style.visibility !== 'collapse');
        const role = shown ? roleOf(el, style) : '';
        const block = !style || !String(style.display).startsWith('inline');
        if (role) {
          flush(d);
          element(el, role, style, d);
        } else {
          if (block) flush(d);
          walk(el, d);
          if (block) flush(d);
        }
      }
    }

    let start = null;
    if (ref) {
      start = deref(ref);
      if (!start) return { error: 'stale', ref };
    }
    if (start) {
      const style = styleOf(start);
      const role = roleOf(start, style);
      if (role) element(start, role, style, 0);
      else walk(start, 0);
      flush(0);
    } else {
      const root = document.body || document.documentElement;
      if (root) walk(root, 0);
      flush(0);
    }
    return { lines, frames, truncated };
  }

  /** Up to `limit` elements whose line (role, name, value, text) contains every word of the query. */
  /** @param {{ query?: string, limit?: number }} [o] */
  function find({ query, limit = 20 } = {}) {
    const words = clean(query).toLowerCase().split(' ').filter(Boolean);
    const out = [];
    const frames = [];
    if (!words.length) return { lines: out, frames };
    const visit = (parent) => {
      for (const child of childrenOf(parent)) {
        if (out.length >= limit) return;
        if (child.nodeType !== 1) continue;
        const el = child;
        if (SKIP.has(el.localName) || el.getAttribute('aria-hidden') === 'true' || el.hidden) continue;
        const style = styleOf(el);
        if (style && style.display === 'none') continue;
        let role = style && (style.visibility === 'hidden' || style.visibility === 'collapse') ? '' : roleOf(el, style);
        // the name as the tree shows it (whole up to q's marked cut), so a line find() hands the page diff matches the tree's
        let full = role ? nameOf(el, role) : '';
        let name = full.slice(0, 150);
        if (!role) {
          // a plain element matched by its own text
          const own = ownText(el);
          if (own) {
            role = 'generic';
            name = full = own;
          }
        }
        if (role) {
          const attrs = attrsOf(el, role);
          const hay = `${role} ${name} ${attrs} ${el.getAttribute('placeholder') || ''} ${el.id || ''}`.toLowerCase();
          if (words.every((w) => hay.includes(w))) out.push(`- ${role}${name ? ` "${q(full)}"` : ''}${attrs} [${refOf(el, role, name)}]`);
        }
        if (el.localName === 'iframe' || el.localName === 'frame') {
          // a cross-origin frame is not readable here: it is listed for main to search in its own process
          const doc = frameDoc(el);
          if (doc && doc.documentElement) visit(doc.documentElement);
          else if (role) frames.push(refOf(el, role, name));
          continue;
        }
        visit(el);
      }
    };
    if (document.documentElement) visit(document.documentElement);
    return { lines: out, frames };
  }

  /** Visible text, the main content first when the page marks one. */
  function text({ maxChars = 50000 } = {}) {
    const main = /** @type {HTMLElement | null} */ (document.querySelector('main, [role="main"], article'));
    const mainText = main ? String(main.innerText || '').trim() : '';
    const body = document.body ? String(document.body.innerText || '') : '';
    const t = mainText.length > 200 ? mainText : body;
    const truncated = t.length > maxChars;
    // never half of an emoji at the cut: the result goes on to the model as JSON (prefixUnits, inlined: this runs in the page)
    const cut = truncated ? t.slice(0, maxChars).replace(/[\uD800-\uDBFF]$/, '') : t;
    return { text: cut, truncated, title: document.title, url: location.href };
  }

  /* ---------------------------------------------------------------- */
  /* locators (browser_script): query steps, element state, focus, select */
  /* ---------------------------------------------------------------- */

  /** A text matcher from a script: { s, exact } (a substring, ignoring case, unless exact) or { re, flags }. */
  function matcher(m) {
    if (typeof m.re === 'string') {
      const re = new RegExp(m.re, String(m.flags || '').replace(/[gy]/g, ''));
      return (t) => re.test(clean(t));
    }
    const want = clean(m.s);
    if (m.exact) return (t) => clean(t) === want;
    const low = want.toLowerCase();
    return (t) => clean(t).toLowerCase().includes(low);
  }

  /** The elements under each root (a document or an element, not the root itself), open shadow roots included. */
  function under(roots, sel = '*') {
    const out = new Set();
    const visit = (r) => {
      for (const el of r.querySelectorAll(sel)) out.add(el);
      for (const el of r.querySelectorAll('*')) {
        const sr = kit.shadowOf(el);
        if (sr) visit(sr);
      }
    };
    for (const root of roots) {
      const sr = kit.shadowOf(root);
      if (sr) visit(sr);
      visit(root);
    }
    return [...out];
  }

  /** The text a text locator reads: a button input's value, otherwise the text content. */
  const textOf = (el) =>
    el.localName === 'input' && /^(button|submit|reset)$/i.test(el.getAttribute('type') || '') ? el.value : el.textContent;

  /** Rendered: a box with a size and not visibility: hidden. */
  function visible(el) {
    const style = styleOf(el);
    if (style && (style.visibility === 'hidden' || style.visibility === 'collapse')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** Left out of the accessibility tree: aria-hidden, hidden or display: none up the (shadow-including) ancestors. */
  function a11yHidden(el) {
    for (let n = el; n; n = n.parentElement || n.getRootNode().host || null) {
      if (n.getAttribute('aria-hidden') === 'true' || n.hidden) return true;
      const s = styleOf(n);
      if (s && s.display === 'none') return true;
    }
    return !visibleStyle(el);
  }
  const visibleStyle = (el) => {
    const s = styleOf(el);
    return !s || (s.visibility !== 'hidden' && s.visibility !== 'collapse');
  };

  function enabled(el) {
    if (el.disabled === true || el.closest('[aria-disabled="true"]')) return false;
    return !(/^(input|select|textarea|button)$/.test(el.localName) && el.closest('fieldset[disabled]'));
  }

  const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'color', 'range', 'hidden']);
  function editable(el) {
    if (!enabled(el) || el.readOnly === true || el.getAttribute('aria-readonly') === 'true') return false;
    if (el.localName === 'textarea') return true;
    if (el.localName === 'input') return !NOT_TEXT.has((el.getAttribute('type') || 'text').toLowerCase());
    return !!el.isContentEditable;
  }

  /** true, false or 'mixed' for checkboxes, radios and switches; null for anything else. */
  function checkedOf(el) {
    if (el.localName === 'input' && /^(checkbox|radio)$/i.test(el.getAttribute('type') || '')) return !!el.checked;
    const a = el.getAttribute('aria-checked');
    return a === 'mixed' ? 'mixed' : a === 'true' ? true : a === 'false' ? false : null;
  }

  /** getByRole's states: option name -> the element's value for it. */
  const ROLE_STATES = {
    checked: checkedOf,
    disabled: (el) => !enabled(el),
    expanded: (el) => el.getAttribute('aria-expanded') === 'true',
    selected: (el) => el.getAttribute('aria-selected') === 'true' || (el.localName === 'option' && !!el.selected),
    pressed: (el) => el.getAttribute('aria-pressed') === 'true',
    level: (el) => (/^h[1-6]$/.test(el.localName) ? Number(el.localName[1]) : Number(el.getAttribute('aria-level')) || 2),
  };

  /** What getByLabel matches: label elements, aria-labelledby targets and aria-label. */
  function labelsOf(el) {
    const out = el.labels ? [...el.labels].map((l) => l.textContent) : [];
    for (const id of clean(el.getAttribute('aria-labelledby')).split(' ').filter(Boolean)) {
      const e = el.ownerDocument.getElementById(id);
      if (e) out.push(e.textContent);
    }
    if (el.hasAttribute('aria-label')) out.push(el.getAttribute('aria-label'));
    return out;
  }

  /** A short description for a message: role "name", or <tag#id> "text". */
  function describe(el) {
    const role = roleOf(el, styleOf(el));
    if (role) {
      const name = nameOf(el, role);
      return `${role}${name ? ` "${q(name, 60)}"` : ''}`;
    }
    const t = clean(el.textContent);
    return `<${el.localName}${el.id ? `#${el.id}` : ''}>${t ? ` "${q(t, 60)}"` : ''}`;
  }

  const refAny = (el) => {
    const role = roleOf(el, styleOf(el));
    return refOf(el, role, nameOf(el, role).slice(0, 150));
  };

  /** The elements Playwright's text engine picks: matching ones none of whose child elements match too. */
  function byText(roots, m) {
    const test = matcher(m);
    const memo = new Map();
    const hit = (el) => {
      if (!memo.has(el)) memo.set(el, !SKIP.has(el.localName) && test(textOf(el)));
      return memo.get(el);
    };
    return under(roots).filter((el) => hit(el) && ![...el.children].some(hit));
  }

  /** A CSS selector; Playwright's trailing :has-text(), :text(), :text-is() and :visible become filters. */
  function css(roots, sel) {
    const m = /^(.*?)((?::(?:has-text|text-is|text)\((["'])(?:\\.|(?!\3).)*\3\)|:visible)+)\s*$/.exec(sel);
    const base = m ? m[1].trim() : sel;
    let out = under(roots, !base || /[>+~,]$/.test(base) ? `${base}*` : base);
    if (!m) return out;
    for (const p of m[2].matchAll(/:(has-text|text-is|text)\((["'])((?:\\.|(?!\2).)*)\2\)|:visible/g)) {
      if (!p[1]) {
        out = out.filter(visible);
        continue;
      }
      const s = p[3].replace(/\\(.)/g, '$1');
      out =
        p[1] === 'has-text'
          ? out.filter((el) => matcher({ s })(textOf(el)))
          : byText([...new Set(out.map((el) => el.parentNode))], { s, exact: p[1] === 'text-is' }).filter((el) => out.includes(el));
    }
    return out;
  }

  function xpath(roots, expr) {
    const out = new Set();
    for (const root of roots) {
      const doc = root.ownerDocument || root;
      const r = doc.evaluate(root.nodeType === 1 && expr.startsWith('/') ? `.${expr}` : expr, root, null, 7, null);
      for (let i = 0; i < r.snapshotLength; i++) if (r.snapshotItem(i).nodeType === 1) out.add(r.snapshotItem(i));
    }
    return [...out];
  }

  /** One locator step over the current set (the roots, or the elements matched so far). */
  function step(s, set, scope) {
    switch (s.k) {
      case 'css':
        return css(set, s.s);
      case 'xpath':
        return xpath(set, s.s);
      case 'text':
        return byText(set, s.m);
      case 'role': {
        const name = s.name ? matcher(s.name) : null;
        return under(set).filter((el) => {
          const role = roleOf(el, styleOf(el));
          if (role !== s.role && !(s.role === 'textbox' && role === 'searchbox')) return false;
          if (!s.includeHidden && a11yHidden(el)) return false;
          if (name && !name(nameOf(el, role))) return false;
          return Object.keys(ROLE_STATES).every((k) => s[k] === undefined || ROLE_STATES[k](el) === s[k]);
        });
      }
      case 'label': {
        const t = matcher(s.m);
        return under(set).filter((el) => labelsOf(el).some(t));
      }
      case 'attr': {
        const t = matcher(s.m);
        return under(set, `[${s.name}]`).filter((el) => t(el.getAttribute(s.name)));
      }
      case 'nth': {
        const el = set[s.i < 0 ? set.length + s.i : s.i];
        return el ? [el] : [];
      }
      case 'visible':
        return set.filter((el) => visible(el) === s.v);
      case 'filter': {
        const has = s.hasText ? matcher(s.hasText) : null;
        const hasNot = s.hasNotText ? matcher(s.hasNotText) : null;
        return set.filter(
          (el) =>
            (!has || has(textOf(el))) &&
            (!hasNot || !hasNot(textOf(el))) &&
            (!s.has || run(s.has, [el], scope).length > 0) &&
            (!s.hasNot || run(s.hasNot, [el], scope).length === 0) &&
            (s.visible === undefined || visible(el) === s.visible),
        );
      }
      case 'and': {
        const other = new Set(run(s.steps, [scope.doc], scope));
        return set.filter((el) => other.has(el));
      }
      case 'or': {
        const all = new Set([...set, ...run(s.steps, [scope.doc], scope)]);
        return [...all].sort((a, b) => (a.compareDocumentPosition(b) & 4 ? -1 : 1));
      }
      case 'ref': {
        const el = deref(s.ref);
        return el ? [el] : [];
      }
      default:
        throw new Error(`unknown locator step "${s.k}"`);
    }
  }

  /** Runs frame-free steps from `roots` (has/hasNot/and/or). */
  function run(steps, roots, scope) {
    let set = roots;
    for (const s of steps) set = step(s, set, scope);
    return set;
  }

  /**
   * Resolves locator steps in this frame: { refs, count, desc }. A 'frame' step enters the one iframe
   * matched so far; a cross-origin one hands back { hop: its ref, rest: the later steps } for the main
   * process to continue in that frame. A bad selector or an ambiguous frame is { error }.
   */
  function query({ steps = [], limit = 1000 } = {}) {
    /**
     * The document, then the elements matched so far.
     * @type {any[]}
     */
    let set = [document];
    const scope = { doc: document };
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.k === 'frame') {
        if (!set.length) break;
        if (set.length > 1)
          return {
            error: `The frame locator matched ${set.length} elements (${set.slice(0, 3).map(describe).join(', ')}). Use .first() or .nth(i).`,
            strict: true,
          };
        const fe = set[0];
        if (fe.localName !== 'iframe' && fe.localName !== 'frame')
          return { error: `The frame locator matched ${describe(fe)}, which is not a frame.` };
        // a cross-origin frame is not readable here: handled as a hop below
        const fd = frameDoc(fe);
        if (!fd || !fd.documentElement) return { hop: refAny(fe), rest: steps.slice(i + 1) };
        set = [fd];
        scope.doc = fd;
        continue;
      }
      try {
        set = step(s, set, scope);
      } catch (e) {
        return { error: `Invalid locator: ${String(e && e.message)}` };
      }
    }
    const els = set.filter((n) => n.nodeType === 1);
    return { refs: els.slice(0, limit).map(refAny), count: els.length, desc: els.slice(0, 5).map(describe) };
  }

  /** Properties of elements by ref (null for a stale one): 'state', innerText, textContent, innerHTML, attr, value. */
  /** @param {{ refs?: string[], what?: string, name?: string }} [o] */
  function inspect({ refs = [], what, name } = {}) {
    return refs.map((ref) => {
      const el = deref(ref);
      if (!el) return null;
      switch (what) {
        case 'state':
          return {
            visible: visible(el),
            enabled: enabled(el),
            editable: editable(el),
            checked: checkedOf(el),
            tag: el.localName,
            type: (el.getAttribute('type') || '').toLowerCase(),
          };
        case 'innerText':
          return String(el.innerText === undefined ? el.textContent : el.innerText);
        case 'textContent':
          return el.textContent;
        case 'innerHTML':
          return scrubbed(el);
        case 'attr':
          return isSecret(el) && String(name).toLowerCase() === 'value' && el.hasAttribute('value') ? MASK : el.getAttribute(String(name));
        case 'value':
          if (!/^(input|textarea|select)$/.test(el.localName))
            return { error: `inputValue needs an input, textarea or select element, not <${el.localName}>.` };
          return isSecret(el) && el.value ? MASK : String(el.value);
        default:
          return { error: `unknown property ${what}` };
      }
    });
  }

  /** An element's innerHTML with the value attributes of its password fields masked. */
  function scrubbed(el) {
    const inputs = [...el.querySelectorAll('input')];
    if (!inputs.some((i) => isSecret(i) && i.hasAttribute('value'))) return el.innerHTML;
    const copy = el.cloneNode(true);
    const copies = copy.querySelectorAll('input');
    inputs.forEach((i, n) => {
      if (isSecret(i) && i.hasAttribute('value')) copies[n].setAttribute('value', MASK);
    });
    return copy.innerHTML;
  }

  /* ---------------------------------------------------------------- */
  /* what an action targets (sensitive actions), and masking secrets     */
  /* ---------------------------------------------------------------- */

  const SEND = /\b(send|post|reply|submit|publish|comment)\b/i;

  const submitsForm = (b) => (b.localName === 'button' || b.localName === 'input') && (b.type === 'submit' || b.type === 'image');

  /** What submitting from an element would be: its form's fields and submit button, or a nearby Send button. */
  function formOf(el) {
    const form = el.form || el.closest('form');
    if (form) {
      const fields = [...form.querySelectorAll('input, select, textarea')].slice(0, 200);
      // the default button, wherever it sits; by its normalized type (an empty or unknown type on a button submits)
      const sub = submitsForm(el)
        ? el
        : [...el.getRootNode().querySelectorAll('button, input')].find((b) => b.form === form && submitsForm(b));
      return {
        secrets: fields.filter((f) => isPasswordLike(f) || (secrets.has(f) && !filled.has(f))).length,
        newPassword: fields.some((f) => /\bnew-password\b/i.test(f.getAttribute('autocomplete') || '')),
        payment: fields.some(isPayment) || [...form.querySelectorAll('iframe, frame')].slice(0, 50).some(isPaymentFrame),
        submit: sub ? nameOf(sub, roleOf(sub, styleOf(sub))).slice(0, 120) : '',
        // the prototype's getter: a field named "action" shadows form.action
        action: sub?.hasAttribute('formaction')
          ? sub.formAction
          : /** @type {any} */ (Object.getOwnPropertyDescriptor(el.ownerDocument.defaultView.HTMLFormElement.prototype, 'action')).get.call(
              form,
            ),
      };
    }
    // a composer outside a form (chat apps): the Send button next to it
    let box = el.parentElement;
    for (let i = 0; box && i < 6; i++, box = box.parentElement) {
      const names = [...box.querySelectorAll('button, [role="button"], input[type="submit"]')]
        .slice(0, 50)
        .map((b) => nameOf(b, roleOf(b, styleOf(b))));
      if (!names.length) continue;
      return { secrets: 0, newPassword: false, payment: false, submit: (names.find((n) => SEND.test(n)) || '').slice(0, 120) };
    }
    return null;
  }

  /**
   * The element focus is in, through open shadow roots and same-origin frames; { frame } (the frame element) when it
   * is in a cross-origin one, which main reads in that frame itself.
   */
  function focused() {
    let el = document.activeElement;
    for (;;) {
      while (el && kit.shadowOf(el) && kit.shadowOf(el).activeElement) el = kit.shadowOf(el).activeElement;
      if (!el || (el.localName !== 'iframe' && el.localName !== 'frame')) return el;
      // a cross-origin frame cannot be read from here: main follows the frame marker into it
      const doc = frameDoc(el);
      if (!doc) return { frame: el };
      el = doc.activeElement;
    }
  }

  /**
   * The element at a top-frame viewport point, through open shadow roots and same-origin frames; { frame, x, y } for
   * a cross-origin one: the frame element and the point in that frame's own viewport, which main reads there.
   */
  function atPoint(x, y) {
    let doc = document;
    for (;;) {
      let el = doc.elementFromPoint(x, y);
      while (el && kit.shadowOf(el) && typeof kit.shadowOf(el).elementFromPoint === 'function') {
        const inner = kit.shadowOf(el).elementFromPoint(x, y);
        if (!inner || inner === el) break;
        el = inner;
      }
      if (!el || (el.localName !== 'iframe' && el.localName !== 'frame')) return el;
      const r = el.getBoundingClientRect();
      x -= r.left + el.clientLeft;
      y -= r.top + el.clientTop;
      // a cross-origin frame cannot be read from here: main follows the frame marker into it, at the point in it
      const inner = frameDoc(el);
      if (!inner) return { frame: el, x, y };
      doc = inner;
    }
  }

  /**
   * What an action would act on: the element a ref names, the one at a point, or the focused one.
   * { tag, type, role, name, button, submits, editable, secret, payment, form }; for a cross-origin frame
   * { frame: true, owner, x?, y? }: the ref of the frame element and, for a point, the point inside that frame, so
   * main asks the frame itself (hostPage.cjs intent); null for nothing (or a stale ref). Either carries
   * `botCheck: true` when the target is part of a bot check or CAPTCHA (botCheck.cjs), which no agent action may solve.
   */
  /** @param {{ ref?: string, x?: number, y?: number }} [options] */
  function intent({ ref, x, y } = {}) {
    const point = typeof x === 'number' && typeof y === 'number';
    const hit = ref ? deref(ref) : point ? atPoint(x, y) : focused();
    if (hit && !hit.nodeType && hit.frame) {
      const role = roleOf(hit.frame, styleOf(hit.frame));
      const owner = refOf(hit.frame, role, nameOf(hit.frame, role).slice(0, 150));
      const bot = botCheck(hit.frame, hit.frame, '') ? { botCheck: true } : {};
      return point ? { frame: true, owner, x: hit.x, y: hit.y, ...bot } : { frame: true, owner, ...bot };
    }
    if (!hit || hit.nodeType !== 1) return null;
    let el = hit.closest('button, a[href], input, select, textarea, [role="button"], [role="link"], [role="menuitem"], label') || hit;
    if (el.localName === 'label' && el.control) el = el.control;
    const role = roleOf(el, styleOf(el));
    const tag = el.localName;
    const type = (el.getAttribute('type') || '').toLowerCase();
    const submits = !!el.form && submitsForm(el);
    const edit = editable(el);
    const button = role === 'button' || role === 'link' || role === 'menuitem';
    const name = clean(nameOf(el, role)).slice(0, 120);
    return {
      tag,
      type,
      role,
      name,
      ...(tag === 'a' && el.href ? { href: String(el.href).slice(0, 500) } : {}), // where a link goes: its sensitive click's card
      button,
      submits,
      editable: edit,
      secret: isSecret(el),
      payment: isPayment(el),
      // a button in a form (inside it, or tied by form=) carries it too: "Pay" sends card details though no submit button; so does a formless one by a provider's card fields
      form:
        submits || edit || (button && !!(el.form || el.closest('form')))
          ? formOf(el)
          : button && paymentFrameNear(el)
            ? { secrets: 0, newPassword: false, payment: true, submit: '' }
            : null,
      ...(botCheck(hit, el, name) ? { botCheck: true } : {}),
      consent: button ? consent(hit, el, name) : null,
    };
  }

  /** inputs masked for a capture -> their style attribute before */
  const masked = new Map();
  /** Hides password fields (on) for a screenshot, or puts them back (off). Same-origin frames included. */
  function mask({ on = true } = {}) {
    if (!on) {
      for (const [el, prev] of masked) {
        if (prev === null) el.removeAttribute('style');
        else el.setAttribute('style', prev);
      }
      const count = masked.size;
      masked.clear();
      return { count };
    }
    const docs = [document];
    /** @type {string[]} frames that failed for another reason than being cross-origin: skipped, and told to main */
    const unreadable = [];
    // cross-origin frames cannot be read from here, so they are skipped
    for (const f of under([document], 'iframe, frame')) {
      try {
        const doc = frameDoc(f);
        if (doc) docs.push(doc);
      } catch (e) {
        // one broken frame must not leave the password fields of the others visible
        unreadable.push(String(e));
      }
    }
    for (const el of under(docs, 'input')) {
      if (!isSecret(el) || masked.has(el)) continue;
      masked.set(el, el.getAttribute('style'));
      el.style.setProperty('color', 'transparent', 'important');
      el.style.setProperty('-webkit-text-fill-color', 'transparent', 'important');
      el.style.setProperty('text-shadow', 'none', 'important');
    }
    return unreadable.length ? { count: masked.size, unreadable } : { count: masked.size };
  }

  /** @param {{ ref?: string }} [options] */
  function focus({ ref } = {}) {
    const el = deref(ref);
    if (!el) return { error: 'stale', ref };
    el.focus();
    return { ok: true };
  }

  /** selectOption on a native <select>: strings match an option's value or label; or { value, label, index }. */
  /** @param {{ ref?: string, wants?: any[] }} [o] */
  function select({ ref, wants = [] } = {}) {
    const el = deref(ref);
    if (!el) return { error: 'stale', ref };
    if (el.localName !== 'select')
      return {
        error: `selectOption needs a <select> element, not ${describe(el)}. For a custom dropdown, click it and then click the option.`,
      };
    const opts = [...el.options];
    const picked = [];
    for (const w of wants) {
      const hit = opts.find((o, i) =>
        typeof w === 'string'
          ? o.value === w || clean(o.text) === clean(w)
          : (w.value === undefined || o.value === w.value) &&
            (w.label === undefined || clean(o.text) === clean(w.label)) &&
            (w.index === undefined || i === w.index),
      );
      if (!hit)
        return {
          error: `No option matches ${JSON.stringify(w)}. Options: ${opts
            .slice(0, 30)
            .map((o) => `"${q(o.text, 60)}" (${q(o.value, 60)})`)
            .join(', ')}`,
        };
      picked.push(hit);
    }
    if (!el.multiple && picked.length > 1) return { error: 'This <select> takes one option.' };
    for (const o of opts) o.selected = picked.includes(o);
    fire(el, 'input');
    fire(el, 'change');
    return { ok: true, values: picked.map((o) => o.value) };
  }

  /** Whether `t` (what is under the point) is `el`, inside it (shadow-including), or a label for it. */
  function hits(el, t) {
    for (let n = t; n; n = n.parentNode || n.host) if (n === el) return true;
    return t.localName === 'label' && t.control === el;
  }

  /** Viewport geometry of a ref: its center, in the top frame's CSS pixels as far as this frame knows. */
  /** @param {{ ref?: string, scroll?: boolean, hit?: boolean }} [o] */
  function locate({ ref, scroll = true, hit = false } = {}) {
    const el = deref(ref);
    if (!el) return { error: 'stale', ref };
    const win = el.ownerDocument.defaultView;
    let r = el.getBoundingClientRect();
    const fully = r.top >= 0 && r.left >= 0 && r.bottom <= win.innerHeight && r.right <= win.innerWidth;
    if (scroll && !fully) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      r = el.getBoundingClientRect();
    }
    if (!r.width && !r.height) {
      const first = el.getClientRects()[0];
      if (first) r = first;
    }
    const off = frameOffset(el.ownerDocument);
    const cs = styleOf(el);
    const content = {
      x: off.x + r.left + el.clientLeft + (cs ? parseFloat(cs.paddingLeft) || 0 : 0),
      y: off.y + r.top + el.clientTop + (cs ? parseFloat(cs.paddingTop) || 0 : 0),
    };
    let name = '';
    /** @type {string | null} why the name could not be read; the name is optional detail, so main records this and goes on */
    let nameError = null;
    try {
      name = clean(nameOf(el, roleOf(el, cs))).slice(0, 80);
    } catch (e) {
      nameError = String(e);
    }
    const out = {
      x: off.x + r.left + r.width / 2,
      y: off.y + r.top + r.height / 2,
      w: r.width,
      h: r.height,
      content,
      tag: el.localName,
      name,
    };
    if (nameError) out.nameError = nameError;
    if (hit) {
      // what would take a click at the center (in this frame's own viewport): another element covering it?
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      let t = el.ownerDocument.elementFromPoint(cx, cy);
      while (t && kit.shadowOf(t) && typeof kit.shadowOf(t).elementFromPoint === 'function') {
        const inner = kit.shadowOf(t).elementFromPoint(cx, cy);
        if (!inner || inner === t) break;
        t = inner;
      }
      out.cover = t && !hits(el, t) ? describe(t) : null;
    }
    return out;
  }

  /** @param {{ ref?: string }} [o] */
  function scrollTo({ ref } = {}) {
    const el = deref(ref);
    if (!el) return { error: 'stale', ref };
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    return { ok: true };
  }

  function fire(el, type) {
    const win = el.ownerDocument.defaultView;
    const Ev = type === 'input' ? win.InputEvent || win.Event : win.Event;
    el.dispatchEvent(new Ev(type, { bubbles: true, cancelable: false, composed: true }));
  }

  /** Sets a field's value directly and fires input and change, as typing would. */
  /** @param {{ ref?: string, value?: unknown }} [o] */
  function formInput({ ref, value } = {}) {
    const el = deref(ref);
    if (!el) return { error: 'stale', ref };
    const win = el.ownerDocument.defaultView;
    const tag = el.localName;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (el.disabled) return { error: 'This field is disabled.' };
    if (tag === 'select') {
      const want = (Array.isArray(value) ? value : [value]).map((v) => clean(v));
      const hit = (opt) => want.includes(opt.value) || want.includes(clean(opt.text));
      let matched = 0;
      if (el.multiple) {
        // a miss changes nothing: the selection is replaced only when some option matches
        const hits = [...el.options].map(hit);
        matched = hits.filter(Boolean).length;
        if (matched)
          [...el.options].forEach((opt, i) => {
            opt.selected = hits[i];
          });
      } else {
        const opt = [...el.options].find(hit);
        if (opt) {
          opt.selected = true;
          matched = 1;
        }
      }
      if (!matched)
        return {
          error: `No option matches. Options: ${[...el.options]
            .slice(0, 30)
            .map((o) => `"${q(o.text, 60)}" (${q(o.value, 60)})`)
            .join(', ')}`,
        };
      fire(el, 'input');
      fire(el, 'change');
      return { ok: true, value: [...el.selectedOptions].map((o) => clean(o.text)).join(', ') };
    }
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
      const want = typeof value === 'boolean' ? value : /^(true|1|on|yes|checked)$/i.test(String(value));
      if (el.checked !== want) el.click();
      return { ok: true, value: el.checked };
    }
    if (tag === 'input' && type === 'file') return { error: 'This is a file input. Use browser_file_upload.' };
    if (tag === 'input' || tag === 'textarea') {
      el.focus();
      const proto = tag === 'input' ? win.HTMLInputElement.prototype : win.HTMLTextAreaElement.prototype;
      // HTMLInputElement and HTMLTextAreaElement always define `value` as an accessor with a setter
      const setter = /** @type {{ set: (v: string) => void }} */ (Object.getOwnPropertyDescriptor(proto, 'value')).set;
      setter.call(el, String(value));
      fire(el, 'input');
      fire(el, 'change');
      return { ok: true, value: isSecret(el) ? MASK : el.value };
    }
    if (el.isContentEditable) {
      el.focus();
      const sel = win.getSelection();
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      if (!el.ownerDocument.execCommand('insertText', false, String(value))) {
        el.textContent = String(value);
        fire(el, 'input');
      }
      return { ok: true, value: clean(el.innerText) };
    }
    return { error: `This element (${tag}) is not a form field.` };
  }

  /** Page geometry and readiness. */
  function state() {
    return {
      w: innerWidth,
      h: innerHeight,
      dpr: devicePixelRatio,
      sx: scrollX,
      sy: scrollY,
      visibility: document.visibilityState,
      ready: document.readyState,
      quietMs: Date.now() - lastMutation,
      mutations,
      ...(observeError ? { observeError } : {}),
      url: location.href,
      title: document.title,
    };
  }

  /* ---------------------------------------------------------------- */
  /* the credential hand-off (browser_request_credentials): sign-in      */
  /* fields, focusing one for MoPilot to fill, and checking it filled.   */
  /* Values never leave the page: only kinds, refs and lengths do.       */
  /* ---------------------------------------------------------------- */

  const OTP_HINT = /otp|one.?time|2fa|mfa|totp|passcode|verification.?code|auth.?code|\bcode\b/i;
  const LOGIN_HINT = /user|login|e-?mail|account|identifier|phone/i;
  /** What a sign-in field holds: 'password', 'otp', 'username', or '' (not one; `loose`: any text field is a username). */
  function credentialKind(el, loose = false) {
    if (!el || el.localName !== 'input' || !editable(el) || isPayment(el)) return '';
    if (isSecret(el)) return 'password';
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (!/^(text|email|tel|number)$/.test(type)) return '';
    const auto = (el.getAttribute('autocomplete') || '').toLowerCase();
    const hint = `${el.getAttribute('name') || ''} ${el.id} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''}`;
    if (/\bone-time-code\b/.test(auto) || OTP_HINT.test(hint)) return 'otp';
    if (/\b(username|email)\b/.test(auto) || type === 'email' || LOGIN_HINT.test(hint) || loose) return 'username';
    return '';
  }

  /**
   * This frame's sign-in fields: the ones `refs` name (each must be one), or the first visible field of
   * each kind. { origin, fields: [{ ref, kind, label }] }, or { error: 'stale' | 'not_credential', ref }.
   */
  /** @param {{ refs?: string[] | null }} [options] */
  function credentialFields({ refs: wanted = null } = {}) {
    const fields = [];
    const add = (el, kind) => {
      const role = roleOf(el, styleOf(el));
      const name = nameOf(el, role).slice(0, 150);
      fields.push({ ref: refOf(el, role, name), kind, label: clean(name).slice(0, 80) });
    };
    if (Array.isArray(wanted)) {
      for (const ref of wanted) {
        const el = deref(ref);
        if (!el) return { error: 'stale', ref };
        const kind = credentialKind(el, true);
        if (!kind) return { error: 'not_credential', ref };
        add(el, kind);
      }
    } else {
      const seen = new Set();
      for (const el of under([document], 'input')) {
        const kind = credentialKind(el);
        if (!kind || seen.has(kind) || !visible(el)) continue;
        seen.add(kind);
        add(el, kind);
      }
    }
    return { origin: location.origin, fields };
  }

  /**
   * Focuses a sign-in field and selects what it holds, so the text MoPilot inserts replaces it; only on
   * `origin`. From now on the field is masked like a password field (reads, screenshots, agent typing).
   */
  /** @param {{ ref?: string, origin?: string }} [options] */
  function credentialFocus({ ref, origin } = {}) {
    if (location.origin !== origin) return { error: 'origin' };
    const el = deref(ref);
    if (!el) return { error: 'stale', ref };
    secrets.add(el);
    filled.add(el);
    el.focus();
    el.select();
    return { ok: true };
  }

  /** How many characters a filled field holds (never its value); `submit` then submits its form, if it has one. */
  /** @param {{ ref?: string, submit?: boolean }} [options] */
  function credentialCheck({ ref, submit = false } = {}) {
    const el = deref(ref);
    if (!el) return { error: 'stale', ref };
    const length = String(el.value).length;
    if (!submit) return { length };
    if (!el.form) return { length, submitted: false };
    try {
      el.form.requestSubmit();
    } catch {
      return { length, submitted: false };
    }
    return { length, submitted: true };
  }

  const { anchor } = anchors({ roleOf, styleOf, nameOf, clean, run, deref, atPoint, frameOf, isSecret });
  const ops = {
    anchor,
    tree,
    find,
    text,
    locate,
    scrollTo,
    formInput,
    state,
    query,
    inspect,
    focus,
    select,
    intent,
    mask,
    credentialFields,
    credentialFocus,
    credentialCheck,
  };
  /** The page's address without its fragment: a ref is only re-resolved on the page it was minted on. */
  const pageUrl = () => {
    const l = document.location;
    return `${l.origin}${l.pathname}${l.search}`;
  };
  /**
   * Re-resolves refs this document does not know (it replaced the one they were minted in, e.g. a form post that
   * redirected back to the same page): `hints` is { ref: [role, name, tag, url] } from main. A ref moves only to the
   * one element of its tag, role and name on the same page (kit.rebind); anything else stays stale.
   */
  function adopt(hints) {
    if (!hints) return;
    for (const ref of Object.keys(hints)) {
      const [role, name, tag, url] = hints[ref] || [];
      if (byRef.has(ref) || url !== pageUrl()) continue;
      const meta = { role, name, tag, doc: new WeakRef(document) };
      const el = kit.rebind(meta, (c) => roleOf(c, styleOf(c)) === role && nameOf(c, role).slice(0, 150) === name);
      if (!el) continue;
      byRef.set(ref, { ...meta, el: new WeakRef(el) });
      if (!refs.has(el)) refs.set(el, ref);
    }
  }
  /**
   * What main may keep of the refs this call minted: [ref, role, name, tag] of those in this document (not a frame's)
   * that are the only element with their tag, role and name there, so a ref that named one of several look-alikes is
   * never re-resolved to whichever of them survives a reload.
   */
  function hintRows() {
    const own = minted.filter((m) => m[4].ownerDocument === document && m[2] && m[1] !== 'generic');
    if (!own.length) return own;
    const tags = new Set(own.map((m) => m[3]));
    const count = new Map();
    for (const el of kit.deep(document)) {
      if (!tags.has(el.localName)) continue;
      const role = roleOf(el, styleOf(el));
      const key = `${el.localName}\n${role}\n${nameOf(el, role).slice(0, 150)}`;
      count.set(key, (count.get(key) || 0) + 1);
    }
    return own.filter((m) => count.get(`${m[3]}\n${m[1]}\n${m[2]}`) === 1).map((m) => m.slice(0, 4));
  }
  const agent = {
    /** Runs an op; `seq` is the tab's ref counter, so refs never repeat for a tab. `hints`: see adopt. */
    call(op, args, seq, hints) {
      if (typeof seq === 'number' && seq > next) next = seq;
      if (!ops[op]) return { value: { error: `unknown op ${op}` }, seq: next };
      kit.takePending();
      adopt(hints);
      minted = [];
      const value = ops[op](args || {});
      const out = { value, seq: next };
      const rows = hintRows();
      if (rows.length) {
        out.minted = rows;
        out.url = pageUrl();
      }
      if (kit.takePending()) out.closedRoots = true;
      return out;
    },
    /** Hosts whose closed shadow roots main may hand over (adopt), each offered once: see pageAgentShadow.cjs. */
    closedHosts: (limit) => kit.closedHosts(limit),
    adopt: (host, root) => kit.adopt(host, root),
    /** The element behind a ref (for CDP calls that take an object, such as setting files). */
    element(ref, hints) {
      adopt(hints);
      return deref(ref);
    },
    /** The ref of an element (a frame's owner, found through CDP). */
    refFor(el, seq) {
      if (typeof seq === 'number' && seq > next) next = seq;
      const role = roleOf(el, styleOf(el));
      return { ref: refOf(el, role, nameOf(el, role).slice(0, 150)), seq: next };
    },
  };
  Object.defineProperty(G, '__mopilotAgent', { value: agent, configurable: false, enumerable: false, writable: false });
  return agent;
}

const PAGE_AGENT_SOURCE = `(${pageAgent.toString()})(${botCheckIn.toString()}, ${CONSENT_SOURCE}, ${labelText.toString()}, ${shadowKit.toString()}, ${anchorKit.toString()})`;

module.exports = { pageAgent, PAGE_AGENT_SOURCE };
