// What a browser_script sees (electron/capabilities/browser/script.cjs runs it): a Playwright-style API
// over this chat's tabs - browser, tabs, tab, console, sleep - built inside a node:vm context in a worker
// thread. The context has no Node globals and no code generation from strings; every API call becomes
// one JSON message to the main process, which runs it on the shared BrowserHost with the same checks as
// the browser_* tools. Only strings cross between the context and the worker, so the script never holds
// a function or object of the worker's realm. A chat keeps its worker (and so its context) for the
// turn, so the top-level declarations of one call are there in the next, as in a REPL.
//
// scriptRuntime, persist, withReturn, workerMain and hardenRealm are serialized with
// Function.prototype.toString, so they must not close over anything.

/* eslint-disable no-restricted-globals */

/**
 * Builds the API inside the script's realm. `post(json)` sends a message to the main process (call, log,
 * done); `receive(json)` takes its answers. `init`: { current: tab id | null, platform, doc }.
 */
function scriptRuntime(post, init) {
  'use strict';
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const then = Promise.prototype.then;
  const pending = new Map();
  let seq = 0;
  Error.stackTraceLimit = 30;

  const isRe = (x) => Object.prototype.toString.call(x) === '[object RegExp]';

  /** A value as text for logs and the result: JSON where it can be, never throwing. */
  function show(v, space) {
    if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
    if (typeof v === 'bigint') return `${v}n`;
    const seen = new Set();
    let s;
    try {
      s = stringify(
        v,
        (_k, x) => {
          if (typeof x === 'bigint') return `${x}n`;
          if (typeof x === 'function') return `[Function ${x.name || 'anonymous'}]`;
          if (isRe(x)) return String(x);
          if (x instanceof Error) return { name: x.name, message: x.message };
          if (x instanceof Map) return { Map: [...x.entries()] };
          if (x instanceof Set) return { Set: [...x] };
          if (x && typeof x === 'object') {
            if (seen.has(x)) return '[Circular]';
            seen.add(x);
          }
          return x;
        },
        space,
      );
    } catch (e) {
      return `[unserializable: ${e && e.message}]`;
    }
    return s === undefined ? String(v) : s;
  }

  /** A failure the script can catch; `site` is the stack where the script made the call. */
  function failure(message, code, site) {
    const e = /** @type {Error & { code?: string, site?: string }} */ (new Error(message));
    e.name = code === 'timeout' ? 'TimeoutError' : 'BrowserError';
    e.code = code;
    e.site = site;
    return e;
  }

  /** One call to the main process. */
  function call(op, args, site = new Error().stack) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject, site });
      post(stringify({ t: 'call', id, op, args }));
    });
  }

  function receive(json) {
    const m = parse(String(json));
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.value);
    else p.reject(failure(m.error.message, m.error.code, p.site));
  }

  const sleep = (ms) => call('sleep', { ms: Number(ms) || 0 }).then(() => undefined);

  const console = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug'])
    console[level] = (...a) => post(stringify({ t: 'log', level, text: a.map((x) => (typeof x === 'string' ? x : show(x))).join(' ') }));

  /* -- locators -------------------------------------------------------- */

  /** A text matcher: a string (substring, any case; exact: the whole text) or a RegExp. */
  function m(text, exact) {
    if (isRe(text)) return { re: text.source, flags: text.flags };
    if (typeof text !== 'string') throw new TypeError(`Expected a string or a RegExp, got ${show(text)}.`);
    return { s: text, exact: !!exact };
  }
  const jsArg = (x) => (isRe(x) ? String(x) : stringify(x));

  /** Splits "a >> b" outside quotes. */
  function splitChain(sel) {
    const parts = [];
    let cur = '';
    let quote = '';
    for (let i = 0; i < sel.length; i++) {
      const c = sel[i];
      if (quote) {
        if (c === quote) quote = '';
        cur += c;
      } else if (c === '>' && sel[i + 1] === '>') {
        parts.push(cur.trim());
        cur = '';
        i++;
      } else {
        if (c === '"' || c === "'") quote = c;
        cur += c;
      }
    }
    parts.push(cur.trim());
    return parts;
  }

  /** text= bodies: "quoted" is exact, /re/flags a RegExp, anything else a substring. */
  function textEngine(body) {
    const quoted = /^(["'])([\s\S]*)\1$/.exec(body);
    if (quoted) return { s: quoted[2], exact: true };
    const re = /^\/([\s\S]+)\/([a-z]*)$/.exec(body);
    return re ? m(new RegExp(re[1], re[2])) : { s: body, exact: false };
  }

  /** Steps for a selector: CSS by default, or engine=... (xpath, text, id, data-testid, nth, visible, aria-ref), chained with >>. */
  function selectorSteps(sel) {
    if (typeof sel !== 'string' || !sel.trim()) throw new TypeError('A selector must be a non-empty string.');
    return splitChain(sel).map((part) => {
      if (!part) throw new SyntaxError(`Invalid selector ${stringify(sel)}: nothing around ">>".`);
      const eq = /^([a-z][a-z-]*)=([\s\S]*)$/.exec(part);
      if (!eq) return /^(\/\/|\.\.)/.test(part) ? { k: 'xpath', s: part } : { k: 'css', s: part };
      const body = eq[2];
      switch (eq[1]) {
        case 'css':
          return { k: 'css', s: body };
        case 'xpath':
          return { k: 'xpath', s: body };
        case 'text':
          return { k: 'text', m: textEngine(body) };
        case 'id':
          return { k: 'css', s: `[id=${stringify(body)}]` };
        case 'data-testid':
          return { k: 'attr', name: 'data-testid', m: { s: body.replace(/^(["'])([\s\S]*)\1$/, '$2'), exact: true } };
        case 'nth':
          if (!/^-?\d+$/.test(body)) throw new SyntaxError(`Invalid selector ${stringify(part)}: nth= takes an integer.`);
          return { k: 'nth', i: Number(body) };
        case 'visible':
          return { k: 'visible', v: body !== 'false' };
        case 'ref':
        case 'aria-ref':
          return { k: 'ref', ref: body };
        default:
          throw new SyntaxError(
            `Unsupported selector engine "${eq[1]}=". Use CSS, xpath=, text=, id=, data-testid=, nth=, visible= or aria-ref=, or the getBy* methods.`,
          );
      }
    });
  }

  const optsDesc = (o) => {
    const keys = Object.keys(o).filter((k) => o[k] !== undefined);
    return keys.length ? `, { ${keys.map((k) => `${k}: ${jsArg(o[k])}`).join(', ')} }` : '';
  };
  const pick = (o, keys) => {
    const out = {};
    for (const k of keys) if (o && o[k] !== undefined) out[k] = o[k];
    return out;
  };
  const timeoutOf = (o) => (o && (o.timeoutMs ?? o.timeout)) ?? null;
  const ROLE_OPTIONS = ['checked', 'disabled', 'expanded', 'selected', 'pressed', 'level', 'includeHidden'];
  const unsupported = (what, instead) => {
    throw new TypeError(`${what} is not available in browser_script. ${instead}`);
  };

  /**
   * Each kind of scope makes its own Locator from `steps` (Locator, FrameLocator, Playwright).
   * @typedef {{ _make(steps: object[], desc: string): any }} LocatorMaker
   */

  /** What builds locators: tab.playwright, a Locator (scoped to it) and a FrameLocator (inside its frame). */
  class Scope {
    /** @this {Scope & LocatorMaker} */
    locator(sel, o) {
      const l = this._make(selectorSteps(sel), `locator(${jsArg(sel)})`);
      return o ? l.filter(o) : l;
    }
    /** @this {Scope & LocatorMaker} */
    getByRole(role, o = {}) {
      if (typeof role !== 'string' || !role) throw new TypeError('getByRole needs a role such as "button".');
      /** @type {Record<string, any>} */
      const s = { k: 'role', role: role.toLowerCase(), ...pick(o, ROLE_OPTIONS) };
      if (o.name !== undefined) s.name = m(o.name, o.exact);
      return this._make([s], `getByRole(${jsArg(role)}${optsDesc(o)})`);
    }
    /** @this {Scope & LocatorMaker} */
    getByText(text, o = {}) {
      return this._make([{ k: 'text', m: m(text, o.exact) }], `getByText(${jsArg(text)}${optsDesc(o)})`);
    }
    /** @this {Scope & LocatorMaker} */
    getByLabel(text, o = {}) {
      return this._make([{ k: 'label', m: m(text, o.exact) }], `getByLabel(${jsArg(text)}${optsDesc(o)})`);
    }
    /** @this {Scope & LocatorMaker} */
    getByPlaceholder(text, o = {}) {
      return this._make([{ k: 'attr', name: 'placeholder', m: m(text, o.exact) }], `getByPlaceholder(${jsArg(text)}${optsDesc(o)})`);
    }
    /** @this {Scope & LocatorMaker} */
    getByAltText(text, o = {}) {
      return this._make([{ k: 'attr', name: 'alt', m: m(text, o.exact) }], `getByAltText(${jsArg(text)}${optsDesc(o)})`);
    }
    /** @this {Scope & LocatorMaker} */
    getByTitle(text, o = {}) {
      return this._make([{ k: 'attr', name: 'title', m: m(text, o.exact) }], `getByTitle(${jsArg(text)}${optsDesc(o)})`);
    }
    /** @this {Scope & LocatorMaker} */
    getByTestId(id) {
      return this._make([{ k: 'attr', name: 'data-testid', m: m(id, true) }], `getByTestId(${jsArg(id)})`);
    }
    /** @this {Scope & LocatorMaker} */
    frameLocator(sel) {
      const l = this._make(selectorSteps(sel), `frameLocator(${jsArg(sel)})`);
      return new FrameLocator(l._tab, l._steps, l._desc);
    }
  }

  class Locator extends Scope {
    constructor(tab, steps, desc) {
      super();
      this._tab = tab;
      this._steps = steps;
      this._desc = desc;
    }
    _make(steps, d) {
      return new Locator(this._tab, [...this._steps, ...steps], `${this._desc}.${d}`);
    }
    toString() {
      return this._desc;
    }
    toJSON() {
      return `Locator ${this._desc}`;
    }
    /** Steps of another locator on the same tab, for has/hasNot/and/or (no frames). */
    _stepsOf(other, what) {
      if (!(other instanceof Locator) || other._tab !== this._tab) throw new TypeError(`${what} needs a locator of the same tab.`);
      if (other._steps.some((s) => s.k === 'frame')) throw new TypeError(`${what} can't take a locator inside a frame.`);
      return other._steps;
    }
    nth(i) {
      if (!Number.isInteger(i)) throw new TypeError('nth needs an integer.');
      return new Locator(this._tab, [...this._steps, { k: 'nth', i }], `${this._desc}.nth(${i})`);
    }
    first() {
      return new Locator(this._tab, [...this._steps, { k: 'nth', i: 0 }], `${this._desc}.first()`);
    }
    last() {
      return new Locator(this._tab, [...this._steps, { k: 'nth', i: -1 }], `${this._desc}.last()`);
    }
    filter(o = {}) {
      const s = { k: 'filter' };
      if (o.hasText !== undefined) s.hasText = m(o.hasText);
      if (o.hasNotText !== undefined) s.hasNotText = m(o.hasNotText);
      if (o.has !== undefined) s.has = this._stepsOf(o.has, 'filter({ has })');
      if (o.hasNot !== undefined) s.hasNot = this._stepsOf(o.hasNot, 'filter({ hasNot })');
      if (o.visible !== undefined) s.visible = !!o.visible;
      return new Locator(this._tab, [...this._steps, s], `${this._desc}.filter(${show(pick(o, ['hasText', 'hasNotText', 'visible']))})`);
    }
    and(other) {
      return new Locator(
        this._tab,
        [...this._steps, { k: 'and', steps: this._stepsOf(other, 'and') }],
        `${this._desc}.and(${other._desc})`,
      );
    }
    or(other) {
      return new Locator(this._tab, [...this._steps, { k: 'or', steps: this._stepsOf(other, 'or') }], `${this._desc}.or(${other._desc})`);
    }

    _op(op, args) {
      return this._tab._call(op, { steps: this._steps, desc: this._desc, ...args });
    }
    _act(action, value, o, keys = []) {
      return then.call(
        this._op('loc.act', { action, value, options: pick(o, ['force', 'messageKind', ...keys]), timeoutMs: timeoutOf(o) }),
        (v) => v ?? undefined,
      );
    }
    _read(what, o, extra = {}) {
      return this._op('loc.read', { what, timeoutMs: timeoutOf(o), ...extra });
    }

    click(o = {}) {
      return this._act('click', null, { ...o, modifiers: modifiers(o.modifiers) }, [
        'button',
        'clickCount',
        'modifiers',
        'position',
        'delay',
      ]);
    }
    dblclick(o = {}) {
      return this.click({ ...o, clickCount: 2 });
    }
    hover(o = {}) {
      return this._act('hover', null, o, ['position']);
    }
    fill(value, o = {}) {
      return this._act('fill', String(value), o);
    }
    clear(o = {}) {
      return this._act('fill', '', o);
    }
    type(text, o = {}) {
      return this._act('type', String(text), o);
    }
    pressSequentially(text, o = {}) {
      return this._act('type', String(text), o);
    }
    press(key, o = {}) {
      return this._act('press', keyName(key), o, ['delay']);
    }
    check(o = {}) {
      return this._act('check', true, o);
    }
    uncheck(o = {}) {
      return this._act('check', false, o);
    }
    setChecked(checked, o = {}) {
      return this._act('check', !!checked, o);
    }
    selectOption(value, o = {}) {
      return this._act(
        'select',
        [].concat(value).map((v) => (typeof v === 'string' ? v : pick(v, ['value', 'label', 'index']))),
        o,
      );
    }
    focus(o = {}) {
      return this._act('focus', null, o);
    }
    scrollIntoViewIfNeeded(o = {}) {
      return this._act('scroll', null, o);
    }
    waitFor(o = {}) {
      return then.call(this._op('loc.waitFor', { state: o.state || 'visible', timeoutMs: timeoutOf(o) }), () => undefined);
    }
    screenshot(o = {}) {
      return this._read('screenshot', o);
    }
    count() {
      return this._read('count');
    }
    async all() {
      const n = await this.count();
      return Array.from({ length: n }, (_, i) => this.nth(i));
    }
    innerText(o) {
      return this._read('innerText', o);
    }
    textContent(o) {
      return this._read('textContent', o);
    }
    innerHTML(o) {
      return this._read('innerHTML', o);
    }
    getAttribute(name, o) {
      return this._read('attr', o, { name: String(name) });
    }
    inputValue(o) {
      return this._read('value', o);
    }
    allTextContents() {
      return this._read('allTextContents');
    }
    allInnerTexts() {
      return this._read('allInnerTexts');
    }
    isVisible() {
      return this._read('isVisible');
    }
    isHidden() {
      return then.call(this._read('isVisible'), (v) => !v);
    }
    isEnabled(o) {
      return this._read('isEnabled', o);
    }
    isDisabled(o) {
      return then.call(this._read('isEnabled', o), (v) => !v);
    }
    isEditable(o) {
      return this._read('isEditable', o);
    }
    isChecked(o) {
      return this._read('isChecked', o);
    }
    boundingBox(o) {
      return this._read('boundingBox', o);
    }
    evaluate() {
      unsupported(
        'locator.evaluate',
        'Read with innerText(), getAttribute() or inputValue(), or run page JavaScript with tab.playwright.evaluate().',
      );
    }
    evaluateAll() {
      unsupported('locator.evaluateAll', 'Use allTextContents() or allInnerTexts(), or tab.playwright.evaluate().');
    }
  }

  class FrameLocator extends Scope {
    constructor(tab, pre, desc) {
      super();
      this._tab = tab;
      this._pre = pre;
      this._desc = desc;
    }
    _make(steps, d) {
      return new Locator(this._tab, [...this._pre, { k: 'frame' }, ...steps], `${this._desc}.${d}`);
    }
    first() {
      return new FrameLocator(this._tab, [...this._pre, { k: 'nth', i: 0 }], `${this._desc}.first()`);
    }
    last() {
      return new FrameLocator(this._tab, [...this._pre, { k: 'nth', i: -1 }], `${this._desc}.last()`);
    }
    nth(i) {
      return new FrameLocator(this._tab, [...this._pre, { k: 'nth', i }], `${this._desc}.nth(${i})`);
    }
    owner() {
      return new Locator(this._tab, this._pre, `${this._desc}.owner()`);
    }
  }

  /* -- tabs ------------------------------------------------------------- */

  const MODS = Object.assign(Object.create(null), {
    alt: 'alt',
    option: 'alt',
    control: 'ctrl',
    ctrl: 'ctrl',
    meta: 'meta',
    cmd: 'meta',
    command: 'meta',
    shift: 'shift',
    controlormeta: init.platform === 'darwin' ? 'meta' : 'ctrl',
  });
  /** Playwright key names ("ControlOrMeta+A") as the host's chords. */
  const keyName = (key) => String(key).replace(/ControlOrMeta/gi, init.platform === 'darwin' ? 'Meta' : 'Control');
  /** ["Shift", "Control"] or "shift+ctrl" as the host's modifier string. */
  const modifiers = (list) =>
    []
      .concat(list ?? [])
      .flatMap((x) => String(x).split('+'))
      .filter(Boolean)
      .map((x) => MODS[x.toLowerCase()] ?? x)
      .join('+');
  const BUTTONS = Object.assign(Object.create(null), {
    1: 'left',
    2: 'middle',
    3: 'right',
    left: 'left',
    middle: 'middle',
    right: 'right',
  });

  /** A glob ("**" any text, "*" no slash) or exact string, a RegExp, or a predicate, as a URL test. */
  function urlTest(want) {
    if (isRe(want)) return (u) => want.test(u);
    if (typeof want === 'function') return (u) => !!want(u);
    const s = String(want);
    if (!/[*]/.test(s)) return (u) => u === s;
    const re = new RegExp(
      `^${s
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '.*')}$`,
    );
    return (u) => re.test(u);
  }

  class Playwright extends Scope {
    constructor(tab) {
      super();
      this._tab = tab;
    }
    _make(steps, d) {
      return new Locator(this._tab, steps, d);
    }
    domSnapshot() {
      return this._tab._call('tab.domSnapshot', {});
    }
    waitForLoadState(state, o = {}) {
      const opts = typeof state === 'object' && state !== null ? state : { ...o, state };
      return then.call(
        this._tab._call('tab.waitForLoadState', { state: opts.state || 'load', timeoutMs: timeoutOf(opts) }),
        () => undefined,
      );
    }
    async waitForURL(want, o = {}) {
      const site = new Error().stack;
      const test = urlTest(want);
      const ms = timeoutOf(o) ?? 10_000;
      const end = Date.now() + ms;
      for (;;) {
        const u = await this._tab.url();
        if (test(u)) break;
        if (Date.now() >= end)
          throw failure(`Timed out after ${ms} ms waiting for the URL to match ${jsArg(want)} (it is ${u}).`, 'timeout', site);
        await sleep(100);
      }
      if (o.waitUntil !== 'commit') await this.waitForLoadState({ state: o.waitUntil || 'load', timeoutMs: Math.max(1, end - Date.now()) });
    }
    waitForTimeout(ms) {
      return sleep(ms);
    }
    evaluate(fn, arg) {
      const source = typeof fn === 'function' ? `(${String(fn)})(${arg === undefined ? '' : stringify(arg)})` : String(fn);
      return this._tab._call('tab.evaluate', { expression: source });
    }
    elementInfo() {
      unsupported('elementInfo', 'Use domSnapshot() and locators.');
    }
    elementScreenshot() {
      unsupported('elementScreenshot', 'Use locator.screenshot() or tab.screenshot({ clip }).');
    }
    expectNavigation() {
      unsupported('expectNavigation', 'Do the action, then await waitForURL() or waitForLoadState().');
    }
    waitForEvent() {
      unsupported(
        'waitForEvent',
        "Downloads are saved to the chat's downloads folder and reported in browser_state; for file inputs use browser_file_upload.",
      );
    }
  }

  class Tab {
    constructor(id) {
      this._id = id || null;
      this.playwright = new Playwright(this);
      const t = this;
      const raw = (op, args) => then.call(t._call(op, args), () => undefined);
      this.cua = {
        click: (o) =>
          raw('cua.click', { x: o.x, y: o.y, button: BUTTONS[o.button ?? 1] ?? 'left', modifiers: modifiers(o.keypress ?? o.keys) }),
        double_click: (o) => raw('cua.click', { x: o.x, y: o.y, clickCount: 2, modifiers: modifiers(o.keypress ?? o.keys) }),
        move: (o) => raw('cua.move', { x: o.x, y: o.y }),
        scroll: (o) => raw('cua.scroll', { x: o.x, y: o.y, dx: o.scrollX ?? 0, dy: o.scrollY ?? 0 }),
        type: (o) => raw('cua.type', { text: String(o.text) }),
        keypress: (o) => raw('cua.keys', { keys: [].concat(o.keys).join('+') }),
        drag: (o) => raw('cua.drag', { path: o.path }),
      };
      this.mouse = {
        click: (x, y, o = {}) =>
          raw('cua.click', {
            x,
            y,
            button: BUTTONS[o.button ?? 'left'] ?? 'left',
            clickCount: o.clickCount ?? 1,
            modifiers: modifiers(o.modifiers),
            delay: o.delay,
          }),
        dblclick: (x, y) => raw('cua.click', { x, y, clickCount: 2 }),
        move: (x, y) => raw('cua.move', { x, y }),
        wheel: (dx, dy) => raw('cua.scroll', { x: null, y: null, dx, dy }),
      };
      this.keyboard = {
        press: (key, o = {}) => raw('cua.keys', { keys: keyName(key), delay: o.delay }),
        type: (text) => raw('cua.type', { text: String(text) }),
        insertText: (text) => raw('cua.type', { text: String(text) }),
      };
      this.dev = { logs: (o = {}) => t._call('tab.logs', pick(o, ['onlyErrors', 'pattern', 'limit'])) };
    }
    get id() {
      return this._id;
    }
    toJSON() {
      return `Tab ${this._id || '(current)'}`;
    }
    /** Calls `op` on this tab: the chat's current tab is bound on first use. */
    _call(op, args) {
      const site = new Error().stack;
      const bound = this._id ? Promise.resolve(this._id) : then.call(call('tab.resolve', {}, site), (r) => (this._id = r.id));
      return then.call(bound, (id) => call(op, { ...args, tab: id }, site));
    }
    _done(op, args) {
      return then.call(this._call(op, args), () => undefined);
    }
    goto(url) {
      return this._done('tab.goto', { url: String(url) });
    }
    back() {
      return this._done('tab.back', {});
    }
    forward() {
      return this._done('tab.forward', {});
    }
    reload() {
      return this._done('tab.reload', {});
    }
    close() {
      return this._done('tab.close', {});
    }
    title() {
      return this._call('tab.title', {});
    }
    url() {
      return this._call('tab.url', {});
    }
    select() {
      return this._done('tab.select', {});
    }
    bringToFront() {
      return this.select();
    }
    markDeliverable() {
      return this._done('tab.mark', { status: 'deliverable' });
    }
    markHandoff() {
      return this._done('tab.mark', { status: 'handoff' });
    }
    screenshot(o = {}) {
      return this._call('tab.screenshot', pick(o, ['clip', 'fullPage', 'scale']));
    }
    async getJsDialog() {
      const d = await this._call('tab.dialog', {});
      if (!d) return undefined;
      const answer = (accept, text) => this._done('tab.dialog.answer', { accept, text: text === undefined ? null : String(text) });
      return { ...d, accept: (text) => answer(true, text), dismiss: () => answer(false) };
    }
    locator(sel, o) {
      return this.playwright.locator(sel, o);
    }
    getByRole(role, o) {
      return this.playwright.getByRole(role, o);
    }
    getByText(text, o) {
      return this.playwright.getByText(text, o);
    }
    getByLabel(text, o) {
      return this.playwright.getByLabel(text, o);
    }
    getByPlaceholder(text, o) {
      return this.playwright.getByPlaceholder(text, o);
    }
    getByAltText(text, o) {
      return this.playwright.getByAltText(text, o);
    }
    getByTitle(text, o) {
      return this.playwright.getByTitle(text, o);
    }
    getByTestId(id) {
      return this.playwright.getByTestId(id);
    }
    frameLocator(sel) {
      return this.playwright.frameLocator(sel);
    }
    domSnapshot() {
      return this.playwright.domSnapshot();
    }
    waitForLoadState(state, o) {
      return this.playwright.waitForLoadState(state, o);
    }
    waitForURL(url, o) {
      return this.playwright.waitForURL(url, o);
    }
    waitForTimeout(ms) {
      return sleep(ms);
    }
    evaluate(fn, arg) {
      return this.playwright.evaluate(fn, arg);
    }
  }

  const handle = (r) => new Tab(r.id);
  const tabs = {
    new: (o) => then.call(call('tabs.new', { url: typeof o === 'string' ? o : (o && o.url) || null }), handle),
    list: () => call('tabs.list', {}),
    selected: () => then.call(call('tabs.selected', {}), (r) => (r ? handle(r) : undefined)),
    get: (id) => then.call(call('tabs.get', { id: String(id) }), handle),
  };
  const browser = {
    tabs,
    documentation: () => Promise.resolve(String(init.doc || '')),
    nameSession: () => Promise.resolve(),
  };
  const getBrowser = () => Promise.resolve(browser);
  const agent = {
    browsers: {
      get: getBrowser,
      getDefault: getBrowser,
      getForUrl: getBrowser,
      list: () => Promise.resolve([{ id: 'iab', name: 'MoPilot built-in browser' }]),
    },
  };

  /** Runs one call's compiled script (an async function); its outcome goes to the main process as 'done' for `run`. */
  function start(fn, run) {
    then.call(
      fn(),
      (v) => post(stringify({ t: 'done', run, ok: true, value: v === undefined ? null : show(v, 2), undef: v === undefined })),
      (e) => {
        const err = e !== null && typeof e === 'object' && typeof e.message === 'string';
        post(
          stringify({
            t: 'done',
            run,
            ok: false,
            error: err
              ? {
                  name: String(e.name),
                  message: e.message,
                  code: typeof e.code === 'string' ? e.code : null,
                  stack: String(e.site || e.stack || ''),
                }
              : { name: 'Error', message: `Uncaught ${show(e)}`, code: null, stack: '' },
          }),
        );
      },
    );
  }

  /** The `tab` a call starts with: the chat's current tab then (bound on first use when there is none). */
  const tabFor = (id) => new Tab(id);

  return { globals: { browser, tabs, tab: tabFor(init.current), console, sleep, agent }, receive, start, show, tabFor };
}

const { persist, withReturn } = require('./scriptTransform.cjs');
const { workerMain, hardenRealm } = require('./scriptWorker.cjs');

module.exports = { scriptRuntime, persist, withReturn, workerMain, hardenRealm };
