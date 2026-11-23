// Every MoMo service capability has an entry point (#2285): each public method of a class under electron/momo/ is called
// somewhere in the app's own code (main, the windows or shared), not only from tests, or is listed below as internal
// with its reason or as deferred with its issue. routines.propose() was built and tested with nothing calling it, so
// routines could never be made in the app (#2285); a capability only tests reach fails here instead. The match is by
// name (`.name`), so a method whose name another module also uses can still slip by: the sibling sweep checks those.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { treeFiles } from '../scripts/source-tree.mjs';

export const GUARDS = ['electron/', 'shared/', 'src/'];

/** Methods only tests call, each with why that is right, or the issue that wires it. */
const NOT_WIRED: Record<string, string> = {
  'Sentinel.hasOpened': 'internal: a read of the hosts a chat opened; decide() checks them through the marks itself',
  'SourcesHub.copyDir': 'internal: where a source would keep its copies (none keeps any yet); disconnecting deletes that folder by path',
};

const MOMO = 'electron/momo';
const PRODUCTION = [
  ...treeFiles('electron', /\.(c|m)?js$/),
  ...treeFiles('src', /\.tsx?$/).filter((f) => !/\.test\.tsx?$/.test(f)),
  ...treeFiles('shared', /\.(c|m)?js$|\.d\.mts$/),
];
const texts = new Map(PRODUCTION.map((f) => [f, fs.readFileSync(f, 'utf8')]));

/** Each class under electron/momo/ (errors aside) and its public methods. */
function services() {
  const out: { file: string; cls: string; methods: string[] }[] = [];
  for (const file of treeFiles(MOMO, /\.cjs$/)) {
    const text = texts.get(file)!;
    for (const m of text.matchAll(/^class (\w+)(?: extends (\w+))? \{\n([\s\S]*?)^\}/gm)) {
      if (m[2] === 'Error') continue;
      const methods = [...m[3].matchAll(/^ {2}(?:static |async |get |set )*([A-Za-z_$][\w$]*)\s*\(/gm)].map((x) => x[1]);
      out.push({ file, cls: m[1], methods: [...new Set(methods)].filter((n) => n !== 'constructor') });
    }
  }
  return out;
}

/** Whether the app's own code names `.method` anywhere (a call, a bind, a callback). */
const called = (method: string) => {
  const re = new RegExp(`\\.${method.replace(/\$/g, '\\$')}\\b`);
  for (const text of texts.values()) if (re.test(text)) return true;
  return false;
};

test('every public method of a MoMo service is called by the app, or listed as internal or deferred with its reason', () => {
  const found = services();
  assert.ok(found.length >= 10, `the MoMo services were found (${found.length})`);
  assert.ok(
    found.some((s) => s.cls === 'MomoRoutines' && s.methods.includes('propose')),
    'the scan sees each class’s methods',
  );
  const unwired = found.flatMap((s) => s.methods.filter((m) => !called(m)).map((m) => `${s.cls}.${m}`));
  assert.deepEqual(
    unwired.filter((k) => !Object.hasOwn(NOT_WIRED, k)).sort(),
    [],
    'wire each to a tool, IPC or main, or list it in NOT_WIRED with why',
  );
  // and the list holds only what is still unwired
  assert.deepEqual(
    Object.keys(NOT_WIRED).filter((k) => !unwired.includes(k)),
    [],
    'wired now: take it off NOT_WIRED',
  );
  for (const [k, why] of Object.entries(NOT_WIRED)) assert.match(why, /^(internal: .+|deferred: .+\(#\d+\))$/, k);
});

test('the scan tells a method only tests call from one the app calls', () => {
  assert.equal(called('propose'), true, 'routines.propose is reached from the app (routineTools.cjs, starterRoutines.cjs)');
  assert.equal(called('hasOpened'), false, 'Sentinel.hasOpened only tests call');
  assert.ok(texts.has(path.join('electron', 'momo', 'routineTools.cjs')));
});
