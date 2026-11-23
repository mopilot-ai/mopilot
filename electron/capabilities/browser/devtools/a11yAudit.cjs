// browser_accessibility_audit's page side: an axe-style accessibility audit (our own rules, axe rule ids) run in an isolated world; returns violations without field values.
'use strict';

// The rule ids a11yAudit implements, in the order it reports them. Keep in sync with META inside the function (a test checks it).
const RULES = Object.freeze([
  'image-alt',
  'input-image-alt',
  'input-button-name',
  'area-alt',
  'svg-img-alt',
  'label',
  'button-name',
  'link-name',
  'document-title',
  'html-has-lang',
  'html-lang-valid',
  'duplicate-id-aria',
  'aria-valid-attr',
  'aria-required-attr',
  'aria-hidden-focus',
  'heading-order',
  'page-has-heading-one',
  'landmark-one-main',
  'frame-title',
  'tabindex',
  'meta-viewport',
  'list',
  'listitem',
  'color-contrast',
  'autocomplete-valid',
]);

// Runs inside the page, serialized with toString(): only document / getComputedStyle globals, every helper nested.
// opts: { maxNodes (per rule, default 10), rules (ids to run), selector (audit only inside it), maxContrast (text elements, default 2000) }.
// Never reads .value of a field; the html of a node drops every value attribute.
function a11yAudit(opts) {
  opts = opts || {};
  const maxNodes = opts.maxNodes > 0 ? Math.max(1, Math.floor(opts.maxNodes)) : 10;
  const maxContrast = opts.maxContrast || 2000;
  const META = {
    'image-alt': ['critical', 'Images must have alternate text', ['1.1.1']],
    'input-image-alt': ['critical', 'Image buttons must have alternate text', ['1.1.1', '4.1.2']],
    'input-button-name': ['critical', 'Input buttons must have discernible text', ['4.1.2']],
    'area-alt': ['critical', 'Image map areas must have alternate text', ['1.1.1', '2.4.4', '4.1.2']],
    'svg-img-alt': ['serious', 'SVG images with a role must have an accessible name', ['1.1.1']],
    label: ['critical', 'Form elements must have labels', ['1.3.1', '4.1.2']],
    'button-name': ['critical', 'Buttons must have discernible text', ['4.1.2']],
    'link-name': ['serious', 'Links must have discernible text', ['2.4.4', '4.1.2']],
    'document-title': ['serious', 'Documents must have a title', ['2.4.2']],
    'html-has-lang': ['serious', 'The html element must have a lang attribute', ['3.1.1']],
    'html-lang-valid': ['serious', 'The html lang attribute must have a valid value', ['3.1.1']],
    'duplicate-id-aria': ['critical', 'IDs used in ARIA and labels must be unique', ['4.1.2']],
    'aria-valid-attr': ['critical', 'ARIA attributes must be valid names', ['4.1.2']],
    'aria-required-attr': ['critical', 'Roles must have their required ARIA attributes', ['4.1.2']],
    'aria-hidden-focus': ['serious', 'aria-hidden content must not contain focusable elements', ['4.1.2', '1.3.1']],
    'heading-order': ['moderate', 'Heading levels should only increase by one', []],
    'page-has-heading-one': ['moderate', 'The page should contain a level-one heading', []],
    'landmark-one-main': ['moderate', 'The page should have exactly one main landmark', []],
    'frame-title': ['serious', 'Frames must have an accessible name', ['2.4.1', '4.1.2']],
    tabindex: ['serious', 'tabindex should not be greater than zero', []],
    'meta-viewport': ['critical', 'Zooming and scaling must not be disabled', ['1.4.4']],
    list: ['serious', 'Lists must only directly contain li elements', ['1.3.1']],
    listitem: ['serious', 'li elements must be contained in a list', ['1.3.1']],
    'color-contrast': ['serious', 'Text must have sufficient color contrast', ['1.4.3']],
    'autocomplete-valid': ['serious', 'The autocomplete attribute must have a valid value', ['1.3.5']],
  };
  const IMPACT = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  const ARIA_ATTRS = new Set(
    (
      'activedescendant atomic autocomplete braillelabel brailleroledescription busy checked colcount ' +
      'colindex colindextext colspan controls current describedby description details disabled dropeffect errormessage expanded ' +
      'flowto grabbed haspopup hidden invalid keyshortcuts label labelledby level live modal multiline multiselectable orientation ' +
      'owns placeholder posinset pressed readonly relevant required roledescription rowcount rowindex rowindextext rowspan selected ' +
      'setsize sort valuemax valuemin valuenow valuetext'
    )
      .split(' ')
      .map((n) => 'aria-' + n),
  );
  const AUTOFILL = new Set(
    (
      'on off name honorific-prefix given-name additional-name family-name honorific-suffix nickname ' +
      'username new-password current-password one-time-code organization-title organization street-address address-line1 ' +
      'address-line2 address-line3 address-level4 address-level3 address-level2 address-level1 country country-name postal-code ' +
      'cc-name cc-given-name cc-additional-name cc-family-name cc-number cc-exp cc-exp-month cc-exp-year cc-csc cc-type ' +
      'transaction-currency transaction-amount language bday bday-day bday-month bday-year sex url photo tel tel-country-code ' +
      'tel-national tel-area-code tel-local tel-local-prefix tel-local-suffix tel-extension email impp'
    ).split(' '),
  );
  const REQUIRED = {
    checkbox: 'aria-checked',
    radio: 'aria-checked',
    switch: 'aria-checked',
    slider: 'aria-valuenow',
    combobox: 'aria-expanded',
    heading: 'aria-level',
  };

  const ids = Object.keys(META);
  const runIds = opts.rules && opts.rules.length ? ids.filter((id) => opts.rules.indexOf(id) >= 0) : ids;
  const on = new Set(runIds);
  const base = { url: document.URL, title: document.title };
  const root = opts.selector ? document.querySelector(opts.selector) : document.documentElement;
  if (!root) return { ...base, rulesRun: 0, violations: [], incomplete: [], passes: 0, error: 'selector matched no element' };
  const docLevel = !opts.selector;

  const attr = (el, n) => el.getAttribute(n) || '';
  const txt = (el) => el.textContent.replace(/\s+/g, ' ').trim();
  const q = (s) => (root.matches(s) ? [root] : []).concat(Array.from(root.querySelectorAll(s)));

  // A short unique selector: a unique id, else tag:nth-of-type steps up to 5 levels.
  function selectorOf(el) {
    const parts = [];
    let cur = el;
    while (cur && parts.length < 5) {
      const id = cur.id;
      if (id && /^[A-Za-z_][\w-]*$/.test(id) && document.querySelectorAll('[id="' + id + '"]').length === 1) {
        parts.unshift('#' + id);
        break;
      }
      let n = 1;
      for (let s = cur.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === cur.localName) n++;
      parts.unshift(cur.localName + ':nth-of-type(' + n + ')');
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  // The opening tag only; no value attribute, and a password field keeps just type / name / id / class.
  function openTag(el) {
    const pw = el.localName === 'input' && attr(el, 'type').toLowerCase() === 'password';
    let s = '<' + el.localName;
    Array.from(el.attributes).forEach((a) => {
      if (a.name === 'value' || (pw && !/^(type|name|id|class)$/.test(a.name))) return;
      s += ' ' + a.name + '="' + a.value.replace(/\s+/g, ' ') + '"';
    });
    s += '>';
    const chars = Array.from(s); // code points, so a cut never splits a surrogate pair
    return chars.length > 160 ? chars.slice(0, 159).join('') + '\u2026' : s;
  }

  const vio = {};
  const inc = {};
  function add(id, el, why, incomplete) {
    if (!on.has(id)) return;
    const bucket = incomplete ? inc : vio;
    const b = bucket[id] || (bucket[id] = { count: 0, nodes: [] });
    b.count++;
    if (b.nodes.length < maxNodes) b.nodes.push({ selector: selectorOf(el), html: openTag(el), why });
  }

  // Visibility: 0 visible, 1 inside aria-hidden, 2 not rendered (display none, visibility hidden, hidden attribute).
  const state = new Map();
  q('*').forEach((el) => {
    let s = state.get(el.parentElement) || 0;
    if (s !== 2) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || el.hasAttribute('hidden')) s = 2;
      else if (attr(el, 'aria-hidden') === 'true') s = 1;
    }
    state.set(el, s);
  });
  const shown = (el) => state.get(el) === 0;
  const each = (sel, fn) => q(sel).forEach((el) => shown(el) && fn(el));

  // Simplified accessible name: aria-labelledby, aria-label, native source, title, placeholder (fields only).
  const labelFor = new Map();
  Array.from(document.querySelectorAll('label[for]')).forEach((l) => {
    const k = l.getAttribute('for');
    labelFor.set(k, (labelFor.get(k) || '') + ' ' + txt(l));
  });
  function nameOf(el) {
    const by = attr(el, 'aria-labelledby');
    const byText = by
      .split(/\s+/)
      .map((i) => (document.getElementById(i) ? txt(document.getElementById(i)) : ''))
      .join(' ')
      .trim();
    if (byText) return byText;
    const label = attr(el, 'aria-label').trim();
    if (label) return label;
    const tag = el.localName;
    const type = attr(el, 'type').toLowerCase();
    const field = /^(input|select|textarea)$/.test(tag);
    let s;
    if (tag === 'img' || tag === 'area' || type === 'image') s = attr(el, 'alt');
    else if (tag === 'input' && /^(button|submit|reset)$/.test(type)) s = attr(el, 'value');
    else if (field) s = (labelFor.get(el.id) || '') + ' ' + (el.closest('label') ? txt(el.closest('label')) : '');
    else
      s =
        txt(el) +
        ' ' +
        Array.from(el.querySelectorAll('img[alt]'))
          .map((i) => i.getAttribute('alt'))
          .join(' ');
    return s.trim() || attr(el, 'title').trim() || (field ? attr(el, 'placeholder').trim() : '');
  }
  const roleOf = (el) => attr(el, 'role').trim().toLowerCase().split(/\s+/)[0];
  const decorative = (el) => /^(presentation|none)$/.test(roleOf(el));

  // --- Names ---
  each('img', (el) => !el.hasAttribute('alt') && !decorative(el) && !nameOf(el) && add('image-alt', el, 'Image has no alt attribute'));
  each('input[type="image"]', (el) => !nameOf(el) && add('input-image-alt', el, 'Image button has no alt text'));
  each('input[type="button"]', (el) => !nameOf(el) && add('input-button-name', el, 'Input button has no value or label'));
  each('area[href]', (el) => !nameOf(el) && add('area-alt', el, 'Image map area has no alt text'));
  each('svg[role="img"]', (el) => !nameOf(el) && add('svg-img-alt', el, 'SVG with role img has no accessible name'));
  each('input,select,textarea', (el) => {
    if (/^(hidden|submit|button|reset|image)$/.test(attr(el, 'type').toLowerCase()) || decorative(el) || nameOf(el)) return;
    add('label', el, 'Form field has no label or accessible name');
  });
  each('button,[role="button"]', (el) => !nameOf(el) && add('button-name', el, 'Button has no discernible text'));
  each('a[href],[role="link"]', (el) => !nameOf(el) && add('link-name', el, 'Link has no discernible text'));
  each('iframe,frame', (el) => !nameOf(el) && add('frame-title', el, 'Frame has no title'));

  // --- Document ---
  if (docLevel) {
    const html = document.documentElement;
    if (!document.title.trim()) add('document-title', html, 'Document has no title');
    const lang = attr(html, 'lang').trim();
    if (!lang) add('html-has-lang', html, 'html element has no lang attribute');
    else if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(lang))
      add('html-lang-valid', html, 'lang "' + lang.slice(0, 20) + '" is not a valid language tag');
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta) {
      const content = attr(meta, 'content').toLowerCase();
      const max = /maximum-scale\s*=\s*([\d.]+)/.exec(content);
      if (/user-scalable\s*=\s*(no|0)/.test(content) || (max && Number(max[1]) < 2))
        add('meta-viewport', meta, 'Viewport disables or limits zooming');
    }
    const mains = q('main,[role="main"]').filter(shown);
    if (mains.length !== 1)
      mains.length
        ? mains.forEach((m) => add('landmark-one-main', m, 'More than one main landmark'))
        : add('landmark-one-main', html, 'Page has no main landmark');
  }

  // --- Headings ---
  let prev = 0;
  let sawH1 = false;
  each('h1,h2,h3,h4,h5,h6,[role="heading"]', (el) => {
    const level = /^h[1-6]$/.test(el.localName) ? Number(el.localName[1]) : Number(attr(el, 'aria-level')) || 2;
    sawH1 = sawH1 || level === 1;
    if (prev && level > prev + 1) add('heading-order', el, 'Heading level jumps from ' + prev + ' to ' + level);
    prev = level;
  });
  if (docLevel && !sawH1) add('page-has-heading-one', document.documentElement, 'Page has no level-one heading');

  // --- Lists ---
  each('ul,ol', (el) => {
    const bad = Array.from(el.children).filter((c) => !/^(li|script|template)$/.test(c.localName));
    if (bad.length) add('list', el, 'List has ' + bad.length + ' direct child(ren) that are not li');
  });
  each('li', (el) => {
    const p = el.parentElement;
    if (!p || !(/^(ul|ol|menu)$/.test(p.localName) || roleOf(p) === 'list')) add('listitem', el, 'li is not inside a list');
  });

  // --- IDs and ARIA ---
  const idCount = new Map();
  Array.from(document.querySelectorAll('[id]')).forEach((e) => idCount.set(e.id, (idCount.get(e.id) || 0) + 1));
  each('[aria-labelledby],[aria-describedby],label[for]', (el) => {
    const refs = (attr(el, 'aria-labelledby') + ' ' + attr(el, 'aria-describedby') + ' ' + attr(el, 'for')).split(/\s+/);
    const dup = refs.filter((r) => r && idCount.get(r) > 1)[0];
    if (dup) add('duplicate-id-aria', el, 'Referenced id "' + dup.slice(0, 40) + '" is used by ' + idCount.get(dup) + ' elements');
  });
  if (on.has('aria-valid-attr')) {
    q('*').forEach((el) => {
      if (!shown(el)) return;
      const bad = Array.from(el.attributes)
        .map((a) => a.name)
        .filter((n) => n.indexOf('aria-') === 0 && !ARIA_ATTRS.has(n));
      if (bad.length) add('aria-valid-attr', el, 'Unknown ARIA attribute ' + bad[0]);
    });
  }
  each('[role]', (el) => {
    const need = REQUIRED[roleOf(el)];
    if (need && !/^(input|select|h[1-6])$/.test(el.localName) && !el.hasAttribute(need))
      add('aria-required-attr', el, 'Role ' + roleOf(el) + ' needs ' + need);
  });
  const focusable = (el) => {
    const ti = el.getAttribute('tabindex');
    if (ti !== null) return Number.parseInt(ti, 10) >= 0;
    if (el.hasAttribute('disabled')) return false;
    if (el.localName === 'input') return attr(el, 'type').toLowerCase() !== 'hidden';
    return (
      /^(button|select|textarea)$/.test(el.localName) ||
      (/^(a|area)$/.test(el.localName) && el.hasAttribute('href')) ||
      attr(el, 'contenteditable') === 'true'
    );
  };
  q('*').forEach(
    (el) => state.get(el) === 1 && focusable(el) && add('aria-hidden-focus', el, 'Focusable element is inside aria-hidden content'),
  );
  each(
    '[tabindex]',
    (el) =>
      Number.parseInt(el.getAttribute('tabindex'), 10) > 0 &&
      add('tabindex', el, 'tabindex ' + attr(el, 'tabindex') + ' is greater than 0'),
  );
  each('[autocomplete]', (el) => {
    const v = attr(el, 'autocomplete').trim().toLowerCase();
    if (!v) return;
    const t = v.split(/\s+/).filter((x) => !/^(section-.*|shipping|billing|home|work|mobile|fax|pager)$/.test(x));
    if (!(t.length > 0 && t.length <= 2 && AUTOFILL.has(t[0]) && (t.length === 1 || t[1] === 'webauthn')))
      add('autocomplete-valid', el, 'autocomplete "' + v.slice(0, 40) + '" is not a valid token list');
  });

  // --- Contrast: foreground against the first opaque ancestor background; images and unparseable colors are incomplete. ---
  if (on.has('color-contrast')) {
    const parse = (s) => {
      if (s === 'transparent' || s === '') return [0, 0, 0, 0];
      const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/.exec(s);
      return m && [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
    };
    const mix = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat([1]);
    const lum = (c) => {
      const f = (v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : Math.pow((v / 255 + 0.055) / 1.055, 2.4));
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const memo = new Map();
    const bgOf = (el) => {
      if (memo.has(el)) return memo.get(el);
      const cs = getComputedStyle(el);
      const c = /url\(|gradient/.test(cs.backgroundImage) ? null : parse(cs.backgroundColor);
      let out = /** @type {number[] | null} */ (null);
      if (c && c[3] >= 1) out = c;
      else if (c) {
        const under = el.parentElement ? bgOf(el.parentElement) : [255, 255, 255, 1];
        out = under && mix(c, under);
      }
      memo.set(el, out);
      return out;
    };
    let examined = 0;
    q('*').forEach((el) => {
      if (examined >= maxContrast || !shown(el) || /^(script|style|noscript|template)$/.test(el.localName)) return;
      if (!Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.nodeValue.trim())) return;
      examined++;
      const cs = getComputedStyle(el);
      const fg = parse(cs.color);
      const bg = bgOf(el);
      const why = !fg
        ? 'Text color could not be parsed'
        : fg[3] === 0
          ? 'Text is transparent'
          : !bg
            ? 'Background is an image or could not be parsed'
            : '';
      if (why) return add('color-contrast', el, why, true);
      const a = lum(mix(fg, bg));
      const b = lum(bg);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const size = parseFloat(cs.fontSize);
      const bold = cs.fontWeight === 'bold' || Number(cs.fontWeight) >= 700;
      const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      if (ratio < need) add('color-contrast', el, 'Contrast ratio ' + ratio.toFixed(2) + ':1, needs ' + need + ':1');
    });
  }

  const violations = [];
  const incomplete = [];
  let passes = 0;
  runIds.forEach((id) => {
    const v = vio[id];
    const i = inc[id];
    if (v) violations.push({ id, impact: META[id][0], help: META[id][1], wcag: META[id][2], count: v.count, nodes: v.nodes });
    if (i) incomplete.push({ id, count: i.count, nodes: i.nodes });
    if (!v && !i) passes++;
  });
  violations.sort((x, y) => IMPACT[x.impact] - IMPACT[y.impact] || y.count - x.count);
  return { ...base, rulesRun: runIds.length, violations, incomplete, passes };
}

// The caller evaluates `${A11Y_AUDIT_SOURCE}(${JSON.stringify(opts)})` in an isolated world.
const A11Y_AUDIT_SOURCE = `(${a11yAudit.toString()})`;

module.exports = { a11yAudit, A11Y_AUDIT_SOURCE, RULES };
