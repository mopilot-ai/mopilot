// What a Codex cua_repl `js` program acts on, read from its source: the apps and tabs it binds to variables, and whether it acts on the desktop (Codex Computer Use, on OpenAI's Sky service). Main holds MoPilot's desktop lock with it; the thread narration names apps with it.
//
// The plugin's REPL gives the model `cua` (`cua.getApp("Notes")` returns a bound app: `app.click(…)`,
// `app.typeText(…)`, …; `cua.createBrowserTab(…)` / `cua.getTab(…)` drive the browser) and `sky` (from
// `@oai/sky`, desktop only). The kernel keeps variables between calls until it is reset, so a later
// program's `app.click()` acts on whatever `app` was last bound to: callers keep the bindings per thread,
// apply each program's assignments in order (a reassignment replaces or drops a binding), and clear
// them when the kernel is reset.

/**
 * The source with string literals and comments blanked (same length), and the literals' values by the
 * index of their opening quote.
 * @param {string} src
 */
export function maskCua(src) {
  let code = '';
  /** @type {Map<number, string>} */
  const strings = new Map();
  for (let i = 0; i < src.length; ) {
    const ch = src[i];
    const comment =
      ch === '/' && src[i + 1] === '/' ? src.indexOf('\n', i) : ch === '/' && src[i + 1] === '*' ? src.indexOf('*/', i + 2) : null;
    if (comment !== null) {
      const end = comment < 0 ? src.length : src[i + 1] === '*' ? comment + 2 : comment;
      code += ' '.repeat(end - i);
      i = end;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      let value = '';
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\' && j + 1 < src.length) {
          value += src[j + 1] === 'n' ? '\n' : src[j + 1];
          j += 2;
        } else value += src[j++];
      }
      strings.set(i, value);
      const end = Math.min(j + 1, src.length);
      code += ch + '_'.repeat(Math.max(0, end - i - 2)) + (end - i > 1 ? ch : '');
      i = end;
    } else {
      code += ch;
      i++;
    }
  }
  return { code, strings };
}

/** `cua` methods that return a browser or a tab. */
export const CUA_BROWSER_METHODS = /^(createBrowserTab|getTab|getBrowser|listTabs|listBrowsers)$/;
/** An assignment's target: a name not after a dot, then `=` that is not `==` or `=>`. */
const ASSIGN = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])/g;
/** What an assignment's right side starts with: a method call, or a plain name. */
const CALL = /^\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(\s*/;
const NAME = /^\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*(?:[;,)\n]|$)/;

/** A `cua.getApp(` call, wherever it stands (assigned to a variable, awaited inline, or passed on). */
const GET_APP = /(?<![\w$.])cua\s*\.\s*getApp\s*\(/g;

/**
 * The string literals in every `cua.getApp(...)` call's arguments, assigned or not: a name, a bundle id, or the values
 * of an `{ id }` object. An app a program never binds to a variable is acted on all the same (#1362:
 * `(await cua.getApp("MoPilot")).click(…)`), so a no-go check reads these too. A name built at run time is not seen.
 * @param {unknown} source
 * @returns {string[]}
 */
export function cuaAppQueries(source) {
  if (typeof source !== 'string') return [];
  const m = maskCua(source);
  const out = new Set();
  for (const x of m.code.matchAll(GET_APP)) {
    const open = /** @type {number} */ (x.index) + x[0].length;
    const close = m.code.indexOf(')', open);
    const end = close < 0 ? m.code.length : close;
    for (const [at, value] of m.strings) if (at >= open && at < end && value.trim()) out.add(value.trim());
  }
  return [...out];
}

/**
 * A program's assignments in source order: `app` (cua.getApp, with its literal name or null), `browser`
 * (a cua tab or browser), `alias` (another variable, or a call on one: it takes that variable's binding),
 * or `other` (anything else: the variable no longer names an app).
 * @param {unknown} source
 * @returns {{ name: string, kind: 'app' | 'browser' | 'alias' | 'other', app?: string | null, from?: string }[]}
 */
export function cuaAssignments(source) {
  if (typeof source !== 'string') return [];
  const m = maskCua(source);
  const out = [];
  for (const x of m.code.matchAll(ASSIGN)) {
    const at = /** @type {number} */ (x.index) + x[0].length;
    const rest = m.code.slice(at);
    const call = CALL.exec(rest);
    if (call && call[1] === 'cua' && call[2] === 'getApp') {
      const open = at + call[0].length;
      const literal = m.strings.get(open);
      const close = literal === undefined ? -1 : m.code.indexOf(m.code[open], open + 1);
      const whole = close > 0 && /^\s*[,)]/.test(m.code.slice(close + 1));
      out.push({ name: x[1], kind: 'app', app: whole ? literal.trim() || null : null });
    } else if (call && call[1] === 'cua') out.push({ name: x[1], kind: CUA_BROWSER_METHODS.test(call[2]) ? 'browser' : 'other' });
    else if (call) out.push({ name: x[1], kind: 'alias', from: call[1] });
    else {
      const name = NAME.exec(rest);
      out.push(name ? { name: x[1], kind: 'alias', from: name[1] } : { name: x[1], kind: 'other' });
    }
  }
  return out;
}

/**
 * Applies a program's assignments to the kernel's bindings (name -> { surface, app }), in order.
 * `appName` shapes an app's name as the caller shows it.
 * @param {unknown} source
 * @param {Map<string, { surface: 'desktop' | 'browser', app: string | null }>} into
 * @param {(app: string) => string} [appName]
 */
export function learnCuaBindings(source, into, appName = (app) => app) {
  for (const a of cuaAssignments(source)) {
    if (a.kind === 'app') into.set(a.name, { surface: 'desktop', app: a.app ? appName(a.app) : null });
    else if (a.kind === 'browser') into.set(a.name, { surface: 'browser', app: null });
    else if (a.kind === 'alias' && into.has(/** @type {string} */ (a.from)))
      into.set(a.name, /** @type {{ surface: 'desktop' | 'browser', app: string | null }} */ (into.get(/** @type {string} */ (a.from))));
    else into.delete(a.name);
  }
}

/** Calls that reach the desktop without a bound app. */
const DESKTOP_CALL = /\bcua\s*\.\s*(?:getApp|listApps)\s*\(|\bsky\s*\.\s*[A-Za-z_$]/;

/**
 * What a cua_repl `js` program acts on. `bound`: the thread's kernel bindings from earlier programs; the
 * program's own assignments are applied to it. Returns whether the program acts on the desktop (it calls
 * cua.getApp / listApps or sky, or uses a variable bound to an app before or after its assignments), and
 * the app it names (null when it names none).
 * @param {unknown} source
 * @param {Map<string, { surface: 'desktop' | 'browser', app: string | null }>} [bound]
 * @returns {{ desktop: boolean, app: string | null }}
 */
export function cuaProgramUse(source, bound = new Map()) {
  if (typeof source !== 'string' || !source.trim()) return { desktop: false, app: null };
  const { code } = maskCua(source);
  const before = new Map(bound);
  learnCuaBindings(source, bound);
  const named = cuaAssignments(source).find((a) => a.kind === 'app' && a.app)?.app ?? null;
  let desktop = DESKTOP_CALL.test(code) || /@oai\/sky/.test(source);
  let app = named;
  for (const scope of [bound, before])
    for (const [name, b] of scope) {
      if (b.surface !== 'desktop' || !new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\.`).test(code)) continue;
      desktop = true;
      app ??= b.app;
    }
  return { desktop, app };
}

/** A call Sky serves itself. */
const SKY_CALL = /\bsky\s*\.\s*[A-Za-z_$][\w$]*\s*\(/;

/**
 * Whether a program calls a method of an app bound in `scopes` (the kernel's bindings before and after it) or of
 * sky: work that needs Codex Computer Use's macOS permissions, where finding or binding an app alone may not.
 * @param {string} source
 * @param {Map<string, { surface: 'desktop' | 'browser', app: string | null }>[]} scopes
 */
function cuaProgramActs(source, scopes) {
  const { code } = maskCua(source);
  if (SKY_CALL.test(code)) return true;
  return scopes.some((scope) =>
    [...scope].some(
      ([name, b]) =>
        b.surface === 'desktop' && new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\.\\s*[A-Za-z_$][\\w$]*\\s*\\(`).test(code),
    ),
  );
}

/**
 * The plugin kernels' bindings per thread, for every reader of what a thread's programs act on (the desktop
 * lock, the Codex row's health): `use` reads one program in the order the kernel ran it, `reset` forgets a
 * thread whose kernel was reset or closed.
 */
export class CuaKernels {
  /** @type {Map<string, Map<string, { surface: 'desktop' | 'browser', app: string | null }>>} */
  #bound = new Map();

  /**
   * What a program run on `threadId`'s kernel acts on (cuaProgramUse) and whether it `acts` there
   * (cuaProgramActs), its assignments kept for the next one.
   * @param {string} threadId
   * @param {unknown} source
   */
  use(threadId, source) {
    let bound = this.#bound.get(threadId);
    if (!bound) this.#bound.set(threadId, (bound = new Map()));
    const before = new Map(bound);
    const use = cuaProgramUse(source, bound);
    // a program that reaches no desktop (or isn't one) acts on none
    return { ...use, acts: use.desktop && cuaProgramActs(String(source), [before, bound]) };
  }

  /** @param {string} threadId */
  reset(threadId) {
    this.#bound.delete(threadId);
  }

  clear() {
    this.#bound.clear();
  }
}
