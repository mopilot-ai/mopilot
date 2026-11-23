// browser_react's page side: React's component tree, one component's props, hooks and source, and render counts, read from the fibers React keeps on DOM nodes (the page's own world: an isolated world cannot see them). Read only; secret-looking values are REDACTED.

/**
 * Runs in the page's main world (serialized: no outer names). `op`: 'tree' | 'inspect' | 'renders'.
 * @param {{ op: string, id?: number, maxNodes?: number, secret?: boolean }} opts
 *   secret: the page has a password field, so no string from props or state is returned
 */
function reactPage(opts) {
  const KEY = Symbol.for('mopilot.react');
  const SECRET = /pass(word|wd|code)?|pwd|secret|token|otp|cvc|cvv|card|iban|ssn|auth|credential|session|api[-_]?key/i;
  const COMPONENT = new Set([0, 1, 11, 14, 15]); // function, class, forwardRef, memo, simple memo
  const w = /** @type {any} */ (window);
  const state = w[KEY] || (w[KEY] = { ids: new WeakMap(), byId: new Map(), next: 1 });
  const nameOf = (/** @type {any} */ f) => {
    const t = f.type && (f.type.type || f.type.render || f.type);
    return String((t && (t.displayName || t.name)) || (f.type && f.type.displayName) || 'Anonymous');
  };
  const idOf = (/** @type {any} */ f) => {
    // a fiber and its alternate are one component
    const known = state.ids.get(f) || (f.alternate && state.ids.get(f.alternate));
    if (known) return known;
    const id = state.next++;
    state.ids.set(f, id);
    state.byId.set(id, f);
    return id;
  };
  /** The HostRoot fibers of the page: from root containers, else up from any element's fiber. */
  const roots = () => {
    const out = new Set();
    for (const el of Array.from(document.querySelectorAll('*'))) {
      for (const k of Object.keys(el)) {
        if (k.startsWith('__reactContainer$')) out.add(/** @type {any} */ (el)[k].stateNode ? /** @type {any} */ (el)[k] : null);
        else if (k === '_reactRootContainer') out.add(/** @type {any} */ (el)[k]._internalRoot?.current ?? null);
        else if (k.startsWith('__reactFiber$') && !out.size) {
          let f = /** @type {any} */ (el)[k];
          while (f.return) f = f.return;
          out.add(f);
        }
      }
    }
    out.delete(null);
    // a root reached twice (its container and a fiber under it, or a fiber and its alternate) is one root
    return [...new Set([...out].map((f) => (f.stateNode && f.stateNode.current) || f))];
  };
  /** A value as the agent may see it: short, no functions' bodies, secrets REDACTED. */
  const show = (/** @type {any} */ v, depth = 0, key = '') => {
    if (key && SECRET.test(key)) return 'REDACTED';
    if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      if (opts.secret) return `<${v.length} chars>`;
      // a cut says how much it left out (shared/clippedText.mjs; this runs in the page and cannot import it)
      const cut = Array.from(v).slice(0, 200).join('');
      return cut === v ? v : `${cut}… [+${v.length - cut.length} chars]`;
    }
    if (typeof v === 'function') return `ƒ ${v.name || 'anonymous'}`;
    if (typeof v !== 'object') return String(v);
    if (v.$$typeof) return `<${nameOf({ type: v.type })}>`;
    if (typeof Node !== 'undefined' && v instanceof Node) return `<${v.nodeName.toLowerCase()}>`;
    if (depth >= 2) return Array.isArray(v) ? `[${v.length}]` : '{…}';
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => show(x, depth + 1));
    return Object.fromEntries(
      Object.keys(v)
        .slice(0, 30)
        .map((k) => [k, show(v[k], depth + 1, k)]),
    );
  };
  const walk = (/** @type {any} */ f, /** @type {(f: any, depth: number) => void} */ fn, depth = 0) => {
    for (let c = f; c; c = c.sibling) {
      const own = COMPONENT.has(c.tag);
      if (own) fn(c, depth);
      if (c.child) walk(c.child, fn, depth + (own ? 1 : 0));
    }
  };

  if (opts.op === 'tree') {
    const max = opts.maxNodes || 300;
    const lines = [];
    let count = 0;
    const found = roots();
    for (const root of found)
      walk(root.child, (f, depth) => {
        count++;
        if (lines.length < max)
          lines.push(`${'  '.repeat(depth)}${nameOf(f)} [${idOf(f)}]${f.key != null ? ` key=${JSON.stringify(String(f.key))}` : ''}`);
      });
    return { react: found.length > 0, lines, count };
  }
  if (opts.op === 'inspect') {
    const f = state.byId.get(opts.id);
    if (!f) return { missing: true };
    const hooks = [];
    // a function component's hooks are a linked list on memoizedState; a class keeps its state object there
    if (f.tag !== 1) for (let h = f.memoizedState; h && hooks.length < 30; h = h.next) hooks.push(show(h.memoizedState, 1));
    const owners = [];
    for (let o = f._debugOwner; o && owners.length < 10; o = o._debugOwner) owners.push(nameOf(o));
    const src = f._debugSource;
    return {
      name: nameOf(f),
      id: opts.id,
      props: show(f.memoizedProps),
      state: f.tag === 1 ? show(f.memoizedState) : null,
      hooks,
      owners,
      source: src ? `${src.fileName}:${src.lineNumber}` : null,
    };
  }
  // renders: the counts the commit hook (RENDER_HOOK) kept since it was installed
  const r = w[Symbol.for('mopilot.react.renders')];
  if (!r) return { installed: false };
  const top = [...r.counts.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, opts.maxNodes || 30);
  return { installed: true, commits: r.commits, components: top.map(([name, c]) => ({ name, ...c })) };
}

/**
 * Installed before the page's scripts (Page.addScriptToEvaluateOnNewDocument): a React DevTools hook, or a wrap of the one
 * the page has, that counts each component's renders per commit (a fiber rendered when it is new or its props or state changed).
 */
function renderHook() {
  const COMPONENT = new Set([0, 1, 11, 14, 15]);
  const w = /** @type {any} */ (window);
  const r = (w[Symbol.for('mopilot.react.renders')] = { commits: 0, counts: new Map() });
  const nameOf = (/** @type {any} */ f) => {
    const t = f.type && (f.type.type || f.type.render || f.type);
    return String((t && (t.displayName || t.name)) || 'Anonymous');
  };
  const count = (/** @type {any} */ f) => {
    for (let c = f; c; c = c.sibling) {
      const a = c.alternate;
      if (COMPONENT.has(c.tag) && (!a || a.memoizedProps !== c.memoizedProps || a.memoizedState !== c.memoizedState)) {
        const name = nameOf(c);
        const was = r.counts.get(name) || { count: 0, ms: 0 };
        r.counts.set(name, { count: was.count + 1, ms: Math.round((was.ms + (c.actualDuration || 0)) * 10) / 10 });
      }
      if (c.child) count(c.child);
    }
  };
  const onCommit = (/** @type {any} */ _id, /** @type {any} */ root) => {
    r.commits++;
    count(root.current.child);
  };
  const hook = w.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (hook) {
    const prev = hook.onCommitFiberRoot;
    hook.onCommitFiberRoot = function (/** @type {any[]} */ ...a) {
      onCommit(a[0], a[1]);
      return prev ? prev.apply(this, a) : undefined;
    };
    return;
  }
  let n = 0;
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(/** @type {unknown} */ renderer) {
      this.renderers.set(++n, renderer);
      return n;
    },
    onCommitFiberRoot: onCommit,
    onCommitFiberUnmount() {
      // React calls it; nothing is counted here
    },
    onPostCommitFiberRoot() {
      // React calls it; nothing is counted here
    },
    checkDCE() {
      // React calls it; nothing is counted here
    },
  };
}

const REACT_SOURCE = `(${reactPage.toString()})`;
const RENDER_HOOK = `(${renderHook.toString()})();`;

module.exports = { reactPage, renderHook, REACT_SOURCE, RENDER_HOOK };
