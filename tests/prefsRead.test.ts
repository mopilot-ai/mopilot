// No dead settings (#1861): every key of the renderer's Prefs (shared/model/store.d.ts) is read somewhere other than its
// declaration, its default and the Settings pages that write it, so a setting can't outlive its feature. Main gets
// prefs as the same object (prefs.<key>), so electron/ and shared/ count as readers too. A key kept without a reader
// is listed here with why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { treeFiles } from '../scripts/source-tree.mjs';

export const GUARDS = ['electron/', 'shared/', 'src/'];

/** Keys with no reader outside Settings, each with why it stays. Keep this list short. */
const KEPT: Record<string, string> = {
  localUrlDestination: "no reader; its Settings row is in Browser.tsx, owned by #1861's browser owner",
  sshHosts: 'the Settings → Connections list is its use: opening a saved host starts ssh in a terminal tab',
};

const TYPES = 'src/store/types.ts';
/** Where Prefs is declared (the store re-exports it with DEFAULT_PREFS and the prefs loaders). */
const MODEL = 'shared/model/store.d.ts';
const SETTINGS = 'src/components/pages/settings/';

/** The text between `start` and the first line that closes it at column 0. */
function block(text: string, start: string, file = TYPES) {
  const at = text.indexOf(start);
  assert.ok(at >= 0, `${file} has ${start}`);
  const end = text.indexOf('\n}', at);
  return { at, end, body: text.slice(at, end) };
}

const types = fs.readFileSync(TYPES, 'utf8');
const decl = block(fs.readFileSync(MODEL, 'utf8'), 'export interface Prefs {', MODEL);
const defaults = block(types, 'export const DEFAULT_PREFS: Prefs = {');
/** types.ts without the defaults: its helpers are readers. */
const typesRest = [types.slice(0, defaults.at), types.slice(defaults.end)];
const keys = [...decl.body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);

const sources = [...treeFiles('src', /\.tsx?$/), ...treeFiles('electron', /\.[cm]?js$/), ...treeFiles('shared', /\.[cm]?js$/)]
  .filter((f) => f !== TYPES && !f.startsWith(SETTINGS))
  .map((f) => fs.readFileSync(f, 'utf8'));
const text = [...typesRest, ...sources].join('\n');

/**
 * A read: `.key` or `?.key` that isn't an assignment, `['key']`, or a destructure `{ …key… } =`. Setting the key in an
 * object literal (`setPrefs({ key: v })`) is a write and doesn't count.
 */
const readOf = (k: string) =>
  new RegExp(`\\??\\.${k}\\b(?!\\s*=[^=>])|\\[['"]${k}['"]\\]|\\{[^{}=;]*\\b${k}\\b(?!\\s*:)[^{}=;]*\\}\\s*=[^=>]`);

test('the Prefs declaration is found and parsed', () => {
  assert.ok(keys.length > 20, `${keys.length} keys`);
  assert.ok(keys.includes('theme'));
});

test('every pref is read outside its declaration, its default and Settings, or is listed with why', () => {
  const unread = keys.filter((k) => !(k in KEPT) && !readOf(k).test(text));
  assert.deepEqual(unread, [], 'remove the setting (and add it to RETIRED_PREFS), or list it in KEPT with why');
});

test('each kept key is still a pref and still has no reader outside Settings', () => {
  for (const k of Object.keys(KEPT)) {
    assert.ok(keys.includes(k), `${k} is no longer a pref; drop it from KEPT`);
    assert.ok(!readOf(k).test(text), `${k} has a reader now; drop it from KEPT`);
  }
});

test('the read pattern tells a read from a write', () => {
  const r = readOf('theme');
  assert.ok(r.test('if (prefs.theme === "dark")'));
  assert.ok(r.test('const t = p?.theme;'));
  assert.ok(r.test("prefs['theme']"));
  assert.ok(r.test('const { theme, wrapCode } = prefs;'));
  assert.ok(!r.test('setPrefs({ theme: "dark" })'));
  assert.ok(!r.test('prefs.theme = "dark";'));
  assert.ok(!r.test('prefs.themeColor'));
});
