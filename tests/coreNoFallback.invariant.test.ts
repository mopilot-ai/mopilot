// The Rust core has no null branch (docs/architecture/rust-core.md §3): no product source reads a core call's reply as "no core", or checks for a missing core to fall back on.
// What it reads is text, not a parse: a failure turned into another value (`.catch(() => ({}))`, `.catch(() => false)`) or
// a `try`/`catch` that returns null in silence still passes, and is left to review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
/** The product's JS: main, the Host, the shared modules and the window. Tests, scripts and benches are not the product. */
const PRODUCT = ['electron', 'host/src', 'shared', 'src'];
const SOURCE = /\.(?:c|m)?[jt]sx?$/;

const files = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.name === 'node_modules'
        ? []
        : e.isDirectory()
          ? files(path.join(dir, e.name))
          : SOURCE.test(e.name)
            ? [path.join(dir, e.name)]
            : [],
    );
const product = () =>
  PRODUCT.flatMap((dir) => files(path.join(root, dir))).map((file) => [path.relative(root, file).replaceAll('\\', '/'), file]);

/** The names the core is called by in `text`: `coreCall`, `coreSyncCall`, and what stands in for them (`call = coreCall`). */
const callers = (text: string) => [
  'coreCall',
  'coreSyncCall',
  ...[...text.matchAll(/([\w$]+)\s*=\s*core(?:Sync)?Call\b(?!\s*\()/g)].map(([, name]) => name),
];
/** A call of the core whose reply is read, by one of `names`: not their definitions or a property's name. */
const callOf = (names: string[]) => new RegExp(String.raw`(?<![\w$.])(?:${names.join('|')})\(`, 'g');
/**
 * What reads a reply as maybe missing: compared with null or undefined, defaulted, optionally chained, or a failure turned
 * into an empty answer (`.catch(() => null)`).
 */
const MAYBE_MISSING =
  /^\s*(?:\?\.|\?\?|\|\||[=!]==?\s*(?:null|undefined)\b|\.catch\(\s*(?:\(\s*[\w$]*\s*\)|[\w$]+)\s*=>\s*(?:null|undefined|void 0|\{\s*\}|\[\s*\])\s*\))/;

/** The index of the brace that closes the block `from` is in (the text's end at the top level), skipping quoted text. */
function blockEnd(text: string, from: number) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth < 0) return i;
  }
  return text.length;
}

/** The index just past the parenthesis that closes the one at `open`, skipping quoted text; -1 when it never closes. */
function closing(text: string, open: number) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return -1;
}

/** Each core call whose reply is read as maybe missing, by the text of the call. */
function missingReplies(text: string) {
  const found: string[] = [];
  for (const m of text.matchAll(callOf(callers(text)))) {
    let end = closing(text, m.index + m[0].length - 1);
    if (end < 0) continue;
    // `(await coreCall(...))` is read as the call's reply
    if (/\(\s*await\s+$/.test(text.slice(0, m.index)) && /^\s*\)/.test(text.slice(end))) end = text.indexOf(')', end) + 1;
    if (MAYBE_MISSING.test(text.slice(end))) found.push(text.slice(m.index, end));
  }
  // a reply kept in a name: compared with undefined (which no JSON reply is) or loosely with null in the statements after
  // it in its block, or tested for being falsy by the very next statement
  const kept = new RegExp(String.raw`(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+)?(?:${callers(text).join('|')})\(`, 'g');
  for (const m of text.matchAll(kept)) {
    const name = m[1];
    const loose = new RegExp(
      String.raw`(?<![\w$.])${name}\s*(?:[=!]==?\s*undefined\b|[=!]=\s*null\b)|\b(?:undefined\s*[=!]==?|null\s*[=!]=)\s*${name}(?![\w$])`,
    );
    const end = closing(text, m.index + m[0].length - 1);
    const rest = end < 0 ? '' : text.slice(end, blockEnd(text, end));
    const next = rest.replace(/^\s*;/, '');
    if (loose.test(rest) || new RegExp(String.raw`^\s*(?:if\s*\(|return\s+)!\s*${name}(?![\w$])`).test(next))
      found.push(`${name}, read as missing`);
  }
  return found;
}

/** The addon's own methods, as a missing core or an older one would lack them. */
const EXPORT = String.raw`(?:dispatch|dispatchSync|dispatchCancellable|subscribe|routes)`;
/**
 * A check for a missing core, or for an export only an older core lacked:
 * - `!core()`, `core() ?? x`, `core() || x`, `core() && x`, `core()?.`, `core()` compared with null or undefined;
 * - `coreLoaded()` read as a condition (`!coreLoaded()`, `if (coreLoaded())`, `coreLoaded() ? a : b`);
 * - an addon optionally chained at all (`addon?.`);
 * - `typeof addon.dispatchSync`, `typeof addon.cancel` or `typeof core().subscribe`.
 */
const NO_CORE = new RegExp(
  [
    String.raw`!\s*core\(\)`,
    String.raw`(?<![\w$.])core\(\)\s*(?:\?\?|\?\.|\|\||&&|[=!]==?\s*(?:null|undefined)\b)`,
    String.raw`!\s*coreLoaded\(\)|\bif\s*\(\s*coreLoaded\(\)|coreLoaded\(\)\s*(?:\?(?![.?])|&&|\|\|)`,
    String.raw`\baddon\?\.`,
    String.raw`typeof\s+[\w$.]*(?:\baddon|\bcore\(\))\??\.(?:${EXPORT}|cancel)\b`,
  ].join('|'),
);
/**
 * Any value's export called through optional chaining (`c?.routes()`, `x?.dispatchSync(`). The window (`src/`) never holds
 * the addon, and its stores' `store?.subscribe(fn)` is no core, so this is read in main, the Host and shared code only.
 */
const OPTIONAL_EXPORT = new RegExp(String.raw`\?\.${EXPORT}\s*\(`);
/** Whether `text`, from the product file `rel`, checks for a missing core. */
const checksForCore = (rel: string, text: string) => NO_CORE.test(text) || (!rel.startsWith('src/') && OPTIONAL_EXPORT.test(text));

/** Sources that may say whether the core is there, each with why. The loader's own coreLoaded and coreProblem do. */
const ALLOWED: Record<string, string> = {
  'electron/platform/core.cjs': 'the loader: coreLoaded and coreProblem say whether the core loaded, for the probe and startup',
};
/**
 * Sources another change removes, each with it. The test fails when one is still there and stops matching, so the list
 * only shrinks; one already gone needs nothing.
 */
const NOT_YET: Record<string, string> = {};

const flagged = (rel: string, text: string) => missingReplies(text).length > 0 || checksForCore(rel, text);

test('no product source reads a core reply as missing, or falls back on a missing core', () => {
  const found = product().flatMap(([rel, file]) => {
    if (ALLOWED[rel] || NOT_YET[rel]) return [];
    const text = fs.readFileSync(file, 'utf8');
    return [
      ...missingReplies(text).map((call) => `${rel}: ${call}`),
      ...(checksForCore(rel, text) ? [`${rel}: checks for a missing core`] : []),
    ];
  });
  assert.deepEqual(found, []);
  for (const rel of Object.keys(NOT_YET)) {
    const file = path.join(root, rel);
    if (fs.existsSync(file)) assert.ok(flagged(rel, fs.readFileSync(file, 'utf8')), `${rel} no longer matches: drop it from NOT_YET`);
  }
});

test('the scan finds each way of reading a reply as missing, and not a reply read as what it is', () => {
  for (const missing of [
    "const opened = coreSyncCall(addon, 'session.open', { id }) === undefined;",
    "const rows = (await coreCall('proc.table', addon)) ?? [];",
    "const parent = coreSyncCall(core(), 'proc.table', '')?.find((row) => row[0] === pid)?.[1];",
    "if ((await coreCall('rank.open', undefined, files.join('\\0'))) == null) throw new Error('unavailable');",
    "return coreCall('caps.ancestry', addon, String(pid)) !== null;",
    "const reply = coreSyncCall(this.core.addon, route, { id, ...ask });\nif (reply === undefined) throw new Error('no answer');",
    "const reply = await coreCall('x');\nif (undefined !== reply) use(reply);",
    "const rows = (await coreCall('proc.table')) || [];",
    "async function table(call = coreCall) {\n  return (await call('proc.table')) ?? [];\n}",
    "const rows = await coreCall('proc.table').catch(() => null);",
    "const held = await coreCall('proc.contain', addon, `${pid}`).catch((error) => undefined);",
    "return coreCall('rank.close', undefined, String(id)).catch(() => {});",
    "const rows = await coreCall('proc.table');\nif (rows == null) return [];",
    "const value = await coreCall('transcript.checkpoints', undefined, payload);\nif (!value) return {};",
    "const value = await coreCall('transcript.checkpoints', undefined, payload);\nreturn !value;",
  ])
    assert.ok(missingReplies(missing).length, missing);
  for (const read of [
    "return (await coreCall('transcript.contains', undefined, JSON.stringify({ file, needle }))) === true;",
    "if (coreSyncCall(addon, 'caps.ready', null) === true) return true;",
    "const at = await coreCall('proc.started', addon, String(pid));\nreturn Number.isFinite(at) ? at : null;",
    "coreCall('rank.close', undefined, String(id)).catch((error) => noteIgnored('close', error));",
    'const reply = this.ask(route, { chat });\nif (reply === null) return false;',
    "const at = await coreCall('proc.started', addon, `${pid} (${now})`);\nif (at === null) return null;",
    'async function coreCall(route, addon = core(), payload = "") {',
    "async function table(call = coreCall) {\n  const rows = await call('proc.table');\n  return rows.length ? rows : [];\n}",
    "const reply = coreSyncCall(addon, 'session.patch', ask);\nconst s = this.get(chat);\nif (!reply) return false;",
    "const at = await coreCall('proc.started', addon, String(pid));\nif (at === null) return null;",
    "coreCall('rank.close', undefined, String(id)).catch((error) => noteIgnored('close a file listing', error));",
    // the same name in another function is another value
    "async function table() {\n  const rows = await coreCall('proc.table');\n  return rows;\n}\nfunction count(rows) {\n  return rows == null ? 0 : rows.length;\n}",
  ])
    assert.deepEqual(missingReplies(read), [], read);
  for (const check of [
    'if (!core()) return null;',
    'const routes = core()?.routes() ?? [];',
    'const addon = core() ?? fallback;',
    'if (core() === null) return copyInJs();',
    'const routes = addon?.routes() ?? [];',
    "if (typeof addon?.dispatchSync !== 'function') return undefined;",
    "if (typeof addon.subscribe !== 'function') return () => undefined;",
    'if (!coreLoaded()) return copyInJs();',
    'if (coreLoaded()) fast(); else slow();',
    'const read = coreLoaded() ? inCore : inJs;',
    'const native = core() || {};',
    'const ok = core() && core().routes();',
    'const routes = c?.routes() ?? [];',
    "const reply = x?.dispatchSync('proc.table', payload);",
    "if (typeof core().subscribe !== 'function') return () => undefined;",
    "if (typeof addon.cancel !== 'function') return false;",
  ])
    assert.ok(checksForCore('electron/platform/x.cjs', check), check);
  for (const use of [
    'const addon = core();',
    'return requiredCore(addon).routes().includes(route);',
    "const { core } = require('./core.cjs');",
    'this.addon = o.addon ?? core();',
    'return { loaded: Boolean(addon), routes: addon ? addon.routes().length : 0 };',
    "if (typeof store.subscribe === 'function') store.subscribe(listener);",
    'const onCore = coreLoaded();',
    'syncProbe(on, dir, coreLoaded);',
    'controller?.cancel();',
    'const s = sessions?.get(key);',
    'const chosen = loaded ? a : b;',
    'const routes = config?.routes ?? [];',
    "if (typeof controller.cancel === 'function') controller.cancel();",
  ])
    assert.ok(!checksForCore('electron/platform/x.cjs', use), use);
  // the window holds no addon: a store's own subscribe there is no core
  assert.ok(!checksForCore('src/store/x.ts', 'const stop = store?.subscribe(fn);'));
  assert.ok(checksForCore('host/src/x.mjs', 'const stop = store?.subscribe(fn);'));
});
